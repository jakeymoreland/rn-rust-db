#include "NativeReconcileEngine.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <stdexcept>
#include <vector>

namespace facebook::react {

namespace {
std::string takeRustString(char* s) {
  if (s == nullptr) {
    return "{\"ok\":false,\"code\":2,\"message\":\"null response from engine\"}";
  }
  std::string out(s);
  engine_free_string(s);
  return out;
}

// Extracts code/message from an engine last-error JSON envelope
// ({"code":n,"message":"..."}) and formats it as the "EngineError:<code>:<msg>"
// tag the TS layer parses into an EngineError (audit F38). Minimal, dependency-
// free extraction — the envelope shape is produced by our own Rust layer.
std::string toEngineErrorTag(const std::string& envelope) {
  int code = 2;
  std::string message = envelope;
  auto codePos = envelope.find("\"code\":");
  if (codePos != std::string::npos) {
    code = std::atoi(envelope.c_str() + codePos + 7);
  }
  auto msgKey = envelope.find("\"message\":\"");
  if (msgKey != std::string::npos) {
    size_t start = msgKey + 11;
    std::string out;
    for (size_t i = start; i < envelope.size(); i++) {
      char c = envelope[i];
      if (c == '\\' && i + 1 < envelope.size()) {
        char n = envelope[++i];
        out.push_back(n == 'n' ? '\n' : n == 't' ? '\t' : n);
      } else if (c == '"') {
        break;
      } else {
        out.push_back(c);
      }
    }
    message = out;
  }
  return "EngineError:" + std::to_string(code) + ":" + message;
}

// RAII guard for buffers returned by engine_query_entries_bin. Ensures
// engine_free_bytes runs exactly once on every exit path — normal return,
// early throw (corrupt buffer, engine destroyed), or an exception thrown by
// JSI/JS calls (ArrayBuffer construction, JSON.parse) — instead of only on
// the happy path.
struct RustBufferGuard {
  unsigned char* data;
  size_t len;
  ~RustBufferGuard() {
    if (data != nullptr) {
      engine_free_bytes(data, len);
    }
  }
};

// Zero-copy handoff: wraps a Rust-allocated buffer as a jsi::MutableBuffer so
// the JS ArrayBuffer reads Rust's memory directly (no memcpy). The Rust
// allocation is released when the JS GC collects the ArrayBuffer.
class RustOwnedBuffer : public facebook::jsi::MutableBuffer {
 public:
  RustOwnedBuffer(unsigned char* data, size_t len) : data_(data), len_(len) {}
  ~RustOwnedBuffer() override {
    engine_free_bytes(data_, len_);
  }
  size_t size() const override {
    return len_;
  }
  uint8_t* data() override {
    return data_;
  }

 private:
  unsigned char* data_;
  size_t len_;
};
} // namespace

NativeReconcileEngine::NativeReconcileEngine(std::shared_ptr<CallInvoker> jsInvoker)
    : NativeReconcileEngineCxxSpec(std::move(jsInvoker)),
      worker_([this] { workerLoop(); }) {}

NativeReconcileEngine::~NativeReconcileEngine() {
  {
    std::lock_guard<std::mutex> lock(queueMutex_);
    stopping_ = true;
  }
  queueCv_.notify_all();
  if (worker_.joinable()) {
    worker_.join();
  }
  // Exclusive: drains any call still holding a shared lock before the handle
  // is closed, so no in-flight FFI call can touch a freed engine.
  std::unique_lock<std::shared_mutex> lock(engineMutex_);
  if (engine_ != nullptr) {
    engine_close(engine_);
    engine_ = nullptr;
  }
}

void NativeReconcileEngine::workerLoop() {
  for (;;) {
    std::function<void()> task;
    {
      std::unique_lock<std::mutex> lock(queueMutex_);
      queueCv_.wait(lock, [this] { return stopping_ || !queue_.empty(); });
      if (stopping_ && queue_.empty()) {
        return;
      }
      task = std::move(queue_.front());
      queue_.pop();
    }
    task();
  }
}

void NativeReconcileEngine::post(std::function<void()> task) {
  // Queued tasks below capture raw `this` (see execute()/open()/close()
  // implementations that route through post()). That is safe: the
  // destructor sets stopping_, wakes the worker, and join()s it before
  // engineMutex_/engine_ are torn down, so no queued task can run — and no
  // new task can start running — after `this` becomes invalid. Unlike
  // eventTrampoline's deferred jsInvoker_->invokeAsync callback or the
  // installFastPath host functions stashed on global.__reconcileEngine,
  // nothing here can outlive the object.
  {
    std::lock_guard<std::mutex> lock(queueMutex_);
    queue_.push(std::move(task));
  }
  queueCv_.notify_one();
}

void NativeReconcileEngine::eventTrampoline(void* ctx, const char* channel, const char* payload) {
  auto* self = static_cast<NativeReconcileEngine*>(ctx);
  std::string ch(channel != nullptr ? channel : "");
  std::string pl(payload != nullptr ? payload : "");
  auto weak = self->weak_from_this();
  self->jsInvoker_->invokeAsync([weak, ch, pl]() {
    if (auto strong = weak.lock()) {
      strong->emitOnChange(ReconcileChangeEvent{ch, pl});
    }
  });
}

void NativeReconcileEngine::open(jsi::Runtime& rt, std::string path) {
  // Exclusive: a lifecycle transition, and the only writer of engine_/openPath_.
  std::unique_lock<std::shared_mutex> lock(engineMutex_);
  if (engine_ != nullptr) {
    // Audit F37: opening the same path again is a genuine no-op, but opening a
    // DIFFERENT path while already open is a caller error — reporting success
    // would silently keep operations pointed at the old database.
    if (path == openPath_) {
      return;
    }
    throw jsi::JSError(
        rt, "engine already open at '" + openPath_ + "'; close it before opening '" + path + "'");
  }
  engine_ = engine_open(path.c_str());
  if (engine_ == nullptr) {
    // Audit F38: rethrow with the EngineError tag the TS layer unwraps, so the
    // native code/message survive instead of becoming opaque JSON soup.
    std::string err = takeRustString(engine_last_error());
    throw jsi::JSError(rt, toEngineErrorTag(err));
  }
  openPath_ = path;
  engine_set_event_callback(engine_, this, &NativeReconcileEngine::eventTrampoline);
}

void NativeReconcileEngine::close(jsi::Runtime& rt) {
  // Exclusive: waits for in-flight calls to drain, then frees the handle.
  std::unique_lock<std::shared_mutex> lock(engineMutex_);
  if (engine_ != nullptr) {
    // Detach the callback before close so no event can reference this after.
    engine_set_event_callback(engine_, nullptr, nullptr);
    engine_close(engine_);
    engine_ = nullptr;
    openPath_.clear();
  }
}

AsyncPromise<std::string> NativeReconcileEngine::execute(jsi::Runtime& rt, std::string requestJson) {
  auto promise = AsyncPromise<std::string>(rt, jsInvoker_);
  post([this, promise, requestJson = std::move(requestJson)]() mutable {
    std::shared_lock<std::shared_mutex> lock(engineMutex_);
    if (engine_ == nullptr) {
      // Audit F39: resolve the canonical error envelope so the TS unwrap()
      // throws a typed EngineError, matching every other engine failure —
      // rather than rejecting with a bare string that has no .code.
      promise.resolve("{\"ok\":false,\"code\":4,\"message\":\"engine not open\"}");
      return;
    }
    char* resp = engine_execute(engine_, requestJson.c_str());
    promise.resolve(takeRustString(resp));
  });
  return promise;
}

AsyncPromise<std::string> NativeReconcileEngine::ingestDirect(
    jsi::Runtime& rt,
    std::string sourceId,
    std::string payload) {
  auto promise = AsyncPromise<std::string>(rt, jsInvoker_);
  post([this, promise, sourceId = std::move(sourceId), payload = std::move(payload)]() mutable {
    std::shared_lock<std::shared_mutex> lock(engineMutex_);
    if (engine_ == nullptr) {
      // Audit F39: canonical envelope, not a bare reject (see execute()).
      promise.resolve("{\"ok\":false,\"code\":4,\"message\":\"engine not open\"}");
      return;
    }
    char* resp = engine_ingest_direct(engine_, sourceId.c_str(), payload.c_str());
    promise.resolve(takeRustString(resp));
  });
  return promise;
}

std::string NativeReconcileEngine::executeSync(jsi::Runtime& rt, std::string requestJson) {
  std::shared_lock<std::shared_mutex> lock(engineMutex_);
  if (engine_ == nullptr) {
    throw jsi::JSError(rt, "engine not open");
  }
  return takeRustString(engine_execute(engine_, requestJson.c_str()));
}

bool NativeReconcileEngine::installFastPath(jsi::Runtime& rt) {
  std::weak_ptr<NativeReconcileEngine> weak = weak_from_this();
  auto queryBuffer = jsi::Function::createFromHostFunction(
      rt,
      jsi::PropNameID::forAscii(rt, "queryEntriesBuffer"),
      1,
      [weak](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args, size_t count) -> jsi::Value {
        auto strong = weak.lock();
        if (!strong) {
          throw jsi::JSError(rt, "reconcile engine module destroyed");
        }
        if (count < 1 || !args[0].isString()) {
          throw jsi::JSError(rt, "queryEntriesBuffer(collection: string)");
        }
        std::string collection = args[0].asString(rt).utf8(rt);
        size_t len = 0;
        unsigned char* data = nullptr;
        {
          std::shared_lock<std::shared_mutex> lock(strong->engineMutex_);
          if (strong->engine_ == nullptr) {
            throw jsi::JSError(rt, "engine not open");
          }
          data = engine_query_entries_bin(strong->engine_, collection.c_str(), &len);
        }
        if (data == nullptr) {
          throw jsi::JSError(rt, "queryEntriesBuffer failed: " + takeRustString(engine_last_error()));
        }
        // zero-copy: JS reads the Rust allocation in place; freed on JS GC
        return jsi::ArrayBuffer(rt, std::make_shared<RustOwnedBuffer>(data, len));
      });

  auto querySchemaBuffer = jsi::Function::createFromHostFunction(
      rt,
      jsi::PropNameID::forAscii(rt, "queryEntriesSchemaBuffer"),
      2,
      [weak](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args, size_t count) -> jsi::Value {
        auto strong = weak.lock();
        if (!strong) {
          throw jsi::JSError(rt, "reconcile engine module destroyed");
        }
        if (count < 2 || !args[0].isString() || !args[1].isString()) {
          throw jsi::JSError(rt, "queryEntriesSchemaBuffer(collection: string, fieldsCsv: string)");
        }
        std::string collection = args[0].asString(rt).utf8(rt);
        std::string fieldsCsv = args[1].asString(rt).utf8(rt);
        size_t len = 0;
        unsigned char* data = nullptr;
        {
          std::shared_lock<std::shared_mutex> lock(strong->engineMutex_);
          if (strong->engine_ == nullptr) {
            throw jsi::JSError(rt, "engine not open");
          }
          data = engine_query_entries_schema_bin(strong->engine_, collection.c_str(), fieldsCsv.c_str(), &len);
        }
        if (data == nullptr) {
          throw jsi::JSError(rt, "queryEntriesSchemaBuffer failed: " + takeRustString(engine_last_error()));
        }
        // zero-copy: JS reads the Rust allocation in place; freed on JS GC
        return jsi::ArrayBuffer(rt, std::make_shared<RustOwnedBuffer>(data, len));
      });

  auto querySchemaBufferRange = jsi::Function::createFromHostFunction(
      rt,
      jsi::PropNameID::forAscii(rt, "queryEntriesSchemaBufferRange"),
      4,
      [weak](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args, size_t count) -> jsi::Value {
        auto strong = weak.lock();
        if (!strong) {
          throw jsi::JSError(rt, "reconcile engine module destroyed");
        }
        if (count < 4 || !args[0].isString() || !args[1].isString() || !args[2].isNumber() || !args[3].isNumber()) {
          throw jsi::JSError(rt, "queryEntriesSchemaBufferRange(collection, fieldsCsv, limit, offset)");
        }
        std::string collection = args[0].asString(rt).utf8(rt);
        std::string fieldsCsv = args[1].asString(rt).utf8(rt);
        // Audit F41: validate before casting — a non-finite or out-of-range
        // double is undefined behavior in static_cast<long long>.
        double limitD = args[2].asNumber();
        double offsetD = args[3].asNumber();
        if (!std::isfinite(limitD) || !std::isfinite(offsetD)) {
          throw jsi::JSError(rt, "limit/offset must be finite numbers");
        }
        constexpr double kMaxRange = 9007199254740992.0; // 2^53
        auto limit = static_cast<long long>(std::clamp(limitD, 0.0, kMaxRange));
        auto offset = static_cast<long long>(std::clamp(offsetD, 0.0, kMaxRange));
        size_t len = 0;
        unsigned char* data = nullptr;
        {
          std::shared_lock<std::shared_mutex> lock(strong->engineMutex_);
          if (strong->engine_ == nullptr) {
            throw jsi::JSError(rt, "engine not open");
          }
          data = engine_query_entries_schema_bin_range(
              strong->engine_, collection.c_str(), fieldsCsv.c_str(), limit, offset, &len);
        }
        if (data == nullptr) {
          throw jsi::JSError(rt, "queryEntriesSchemaBufferRange failed: " + takeRustString(engine_last_error()));
        }
        // zero-copy: JS reads the Rust allocation in place; freed on JS GC
        return jsi::ArrayBuffer(rt, std::make_shared<RustOwnedBuffer>(data, len));
      });

  auto ingestBufferSync = jsi::Function::createFromHostFunction(
      rt,
      jsi::PropNameID::forAscii(rt, "ingestBufferSync"),
      2,
      [weak](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args, size_t count) -> jsi::Value {
        auto strong = weak.lock();
        if (!strong) {
          throw jsi::JSError(rt, "reconcile engine module destroyed");
        }
        if (count < 2 || !args[0].isString() || !args[1].isObject() || !args[1].asObject(rt).isArrayBuffer(rt)) {
          throw jsi::JSError(rt, "ingestBufferSync(sourceId: string, payload: ArrayBuffer)");
        }
        std::string sourceId = args[0].asString(rt).utf8(rt);
        jsi::ArrayBuffer buf = args[1].asObject(rt).getArrayBuffer(rt);
        // SYNCHRONOUS: blocks the JS thread for the whole ingest. This exists
        // to measure the byte-transport boundary (no UTF-8 string
        // materialization — the payload bytes are read in place); production
        // callers with large payloads should prefer ingestFile or the async
        // string path.
        char* resp = nullptr;
        {
          std::shared_lock<std::shared_mutex> lock(strong->engineMutex_);
          if (strong->engine_ == nullptr) {
            throw jsi::JSError(rt, "engine not open");
          }
          resp = engine_ingest_bytes(strong->engine_, sourceId.c_str(), buf.data(rt), buf.size(rt));
        }
        return jsi::String::createFromUtf8(rt, takeRustString(resp));
      });

  auto kvGet = jsi::Function::createFromHostFunction(
      rt,
      jsi::PropNameID::forAscii(rt, "kvGet"),
      1,
      [weak](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args, size_t count) -> jsi::Value {
        auto strong = weak.lock();
        if (!strong) {
          throw jsi::JSError(rt, "reconcile engine module destroyed");
        }
        if (count < 1 || !args[0].isString()) {
          throw jsi::JSError(rt, "kvGet(key: string)");
        }
        std::string key = args[0].asString(rt).utf8(rt);
        char* value = nullptr;
        int err = 0;
        {
          std::shared_lock<std::shared_mutex> lock(strong->engineMutex_);
          if (strong->engine_ == nullptr) {
            throw jsi::JSError(rt, "engine not open");
          }
          // Audit F40: distinguish a genuine miss from a storage error instead
          // of returning undefined for both (which reads a failed read as
          // "no value" and can silently overwrite good data).
          value = engine_kv_get2(strong->engine_, key.c_str(), &err);
        }
        if (value == nullptr) {
          if (err != 0) {
            throw jsi::JSError(rt, "kvGet failed: " + takeRustString(engine_last_error()));
          }
          return jsi::Value::undefined();
        }
        return jsi::String::createFromUtf8(rt, takeRustString(value));
      });

  auto kvSet = jsi::Function::createFromHostFunction(
      rt,
      jsi::PropNameID::forAscii(rt, "kvSet"),
      2,
      [weak](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args, size_t count) -> jsi::Value {
        auto strong = weak.lock();
        if (!strong) {
          throw jsi::JSError(rt, "reconcile engine module destroyed");
        }
        if (count < 2 || !args[0].isString() || !args[1].isString()) {
          throw jsi::JSError(rt, "kvSet(key: string, value: string)");
        }
        std::string key = args[0].asString(rt).utf8(rt);
        std::string value = args[1].asString(rt).utf8(rt);
        bool ok = false;
        {
          std::shared_lock<std::shared_mutex> lock(strong->engineMutex_);
          if (strong->engine_ == nullptr) {
            throw jsi::JSError(rt, "engine not open");
          }
          ok = engine_kv_set(strong->engine_, key.c_str(), value.c_str());
        }
        if (!ok) {
          throw jsi::JSError(rt, "kvSet failed: " + takeRustString(engine_last_error()));
        }
        return jsi::Value(true);
      });

  auto queryObjects = jsi::Function::createFromHostFunction(
      rt,
      jsi::PropNameID::forAscii(rt, "queryEntriesObjects"),
      1,
      [weak](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args, size_t count) -> jsi::Value {
        auto strong = weak.lock();
        if (!strong) {
          throw jsi::JSError(rt, "reconcile engine module destroyed");
        }
        if (count < 1 || !args[0].isString()) {
          throw jsi::JSError(rt, "queryEntriesObjects(collection: string)");
        }
        std::string collection = args[0].asString(rt).utf8(rt);
        size_t len = 0;
        unsigned char* data = nullptr;
        {
          std::shared_lock<std::shared_mutex> lock(strong->engineMutex_);
          if (strong->engine_ == nullptr) {
            throw jsi::JSError(rt, "engine not open");
          }
          data = engine_query_entries_bin(strong->engine_, collection.c_str(), &len);
        }
        if (data == nullptr) {
          throw jsi::JSError(rt, "queryEntriesObjects failed: " + takeRustString(engine_last_error()));
        }
        RustBufferGuard guard{data, len};
        // Decode: LE [u32 count]([u32 klen][key][u32 jlen][json])*
        // Audit F31: assemble the u32 explicitly little-endian (binenc always
        // writes to_le_bytes) instead of a host-endian memcpy.
        // Audit F26: bounds checks use subtraction form (off <= len is an
        // invariant) so they cannot wrap on a 32-bit size_t.
        auto readU32 = [&](size_t off) -> uint32_t {
          if (off > len || len - off < 4) {
            throw jsi::JSError(rt, "corrupt entry buffer");
          }
          return static_cast<uint32_t>(data[off]) |
              (static_cast<uint32_t>(data[off + 1]) << 8) |
              (static_cast<uint32_t>(data[off + 2]) << 16) |
              (static_cast<uint32_t>(data[off + 3]) << 24);
        };
        size_t off = 0;
        uint32_t rows = readU32(off);
        off += 4;
        // Each row needs at least 8 bytes (two u32 length prefixes), so a
        // claimed row count that can't possibly fit in the remaining buffer
        // is corrupt — reject it before pre-allocating a jsi::Array of that
        // size.
        if (rows > (len - off) / 8) {
          throw jsi::JSError(rt, "corrupt entry buffer");
        }
        jsi::Array out(rt, rows);
        jsi::Function jsonParse = rt.global()
            .getPropertyAsObject(rt, "JSON")
            .getPropertyAsFunction(rt, "parse");
        for (uint32_t i = 0; i < rows; i++) {
          uint32_t klen = readU32(off); off += 4;
          if (klen > len - off) { // audit F26: no-wrap subtraction form
            throw jsi::JSError(rt, "corrupt entry buffer");
          }
          std::string key(reinterpret_cast<char*>(data + off), klen); off += klen;
          uint32_t jlen = readU32(off); off += 4;
          if (jlen > len - off) {
            throw jsi::JSError(rt, "corrupt entry buffer");
          }
          std::string json(reinterpret_cast<char*>(data + off), jlen); off += jlen;
          jsi::Object row(rt);
          row.setProperty(rt, "key", jsi::String::createFromUtf8(rt, key));
          row.setProperty(rt, "fields", jsonParse.call(rt, jsi::String::createFromUtf8(rt, json)));
          out.setValueAtIndex(rt, i, row);
        }
        return out;
      });

  jsi::Object ns(rt);
  ns.setProperty(rt, "queryEntriesBuffer", queryBuffer);
  ns.setProperty(rt, "queryEntriesSchemaBuffer", querySchemaBuffer);
  ns.setProperty(rt, "queryEntriesSchemaBufferRange", querySchemaBufferRange);
  ns.setProperty(rt, "queryEntriesObjects", queryObjects);
  ns.setProperty(rt, "kvGet", kvGet);
  ns.setProperty(rt, "kvSet", kvSet);
  ns.setProperty(rt, "ingestBufferSync", ingestBufferSync);
  rt.global().setProperty(rt, "__reconcileEngine", ns);
  return true;
}

} // namespace facebook::react
