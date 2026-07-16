#include "NativeReconcileEngine.h"

#include <cstdint>
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
  std::lock_guard<std::mutex> lock(engineMutex_);
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
  std::lock_guard<std::mutex> lock(engineMutex_);
  if (engine_ != nullptr) {
    return; // already open — idempotent for the sandbox
  }
  engine_ = engine_open(path.c_str());
  if (engine_ == nullptr) {
    std::string err = takeRustString(engine_last_error());
    throw jsi::JSError(rt, "engine_open failed: " + err);
  }
  engine_set_event_callback(engine_, this, &NativeReconcileEngine::eventTrampoline);
}

void NativeReconcileEngine::close(jsi::Runtime& rt) {
  std::lock_guard<std::mutex> lock(engineMutex_);
  if (engine_ != nullptr) {
    engine_close(engine_);
    engine_ = nullptr;
  }
}

AsyncPromise<std::string> NativeReconcileEngine::execute(jsi::Runtime& rt, std::string requestJson) {
  auto promise = AsyncPromise<std::string>(rt, jsInvoker_);
  post([this, promise, requestJson = std::move(requestJson)]() mutable {
    std::lock_guard<std::mutex> lock(engineMutex_);
    if (engine_ == nullptr) {
      promise.reject("engine not open");
      return;
    }
    char* resp = engine_execute(engine_, requestJson.c_str());
    promise.resolve(takeRustString(resp));
  });
  return promise;
}

std::string NativeReconcileEngine::executeSync(jsi::Runtime& rt, std::string requestJson) {
  std::lock_guard<std::mutex> lock(engineMutex_);
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
          std::lock_guard<std::mutex> lock(strong->engineMutex_);
          if (strong->engine_ == nullptr) {
            throw jsi::JSError(rt, "engine not open");
          }
          data = engine_query_entries_bin(strong->engine_, collection.c_str(), &len);
        }
        if (data == nullptr) {
          throw jsi::JSError(rt, "queryEntriesBuffer failed: " + takeRustString(engine_last_error()));
        }
        RustBufferGuard guard{data, len};
        jsi::Function ctor = rt.global().getPropertyAsFunction(rt, "ArrayBuffer");
        jsi::Object abObj = ctor.callAsConstructor(rt, static_cast<int>(len)).getObject(rt);
        jsi::ArrayBuffer ab = abObj.getArrayBuffer(rt);
        std::memcpy(ab.data(rt), data, len);
        return abObj;
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
          std::lock_guard<std::mutex> lock(strong->engineMutex_);
          if (strong->engine_ == nullptr) {
            throw jsi::JSError(rt, "engine not open");
          }
          data = engine_query_entries_schema_bin(strong->engine_, collection.c_str(), fieldsCsv.c_str(), &len);
        }
        if (data == nullptr) {
          throw jsi::JSError(rt, "queryEntriesSchemaBuffer failed: " + takeRustString(engine_last_error()));
        }
        RustBufferGuard guard{data, len};
        jsi::Function ctor = rt.global().getPropertyAsFunction(rt, "ArrayBuffer");
        jsi::Object abObj = ctor.callAsConstructor(rt, static_cast<int>(len)).getObject(rt);
        jsi::ArrayBuffer ab = abObj.getArrayBuffer(rt);
        std::memcpy(ab.data(rt), data, len);
        return abObj;
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
          std::lock_guard<std::mutex> lock(strong->engineMutex_);
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
        auto readU32 = [&](size_t off) -> uint32_t {
          if (off + 4 > len) {
            throw jsi::JSError(rt, "corrupt entry buffer");
          }
          uint32_t v;
          std::memcpy(&v, data + off, 4);
          return v;
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
          if (off + klen > len) {
            throw jsi::JSError(rt, "corrupt entry buffer");
          }
          std::string key(reinterpret_cast<char*>(data + off), klen); off += klen;
          uint32_t jlen = readU32(off); off += 4;
          if (off + jlen > len) {
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
  ns.setProperty(rt, "queryEntriesObjects", queryObjects);
  rt.global().setProperty(rt, "__reconcileEngine", ns);
  return true;
}

} // namespace facebook::react
