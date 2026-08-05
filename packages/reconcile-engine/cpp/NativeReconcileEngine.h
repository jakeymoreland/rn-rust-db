#pragma once

#include <ReconcileEngineSpecJSI.h>

#include <condition_variable>
#include <functional>
#include <memory>
#include <mutex>
#include <shared_mutex>
#include <queue>
#include <string>
#include <thread>

#include "include/engine.h"

namespace facebook::react {

// Concrete instantiation of the codegen'd event payload struct
// (`onChange: EventEmitter<ChangeEvent>` in the TS spec), plus the Bridging
// specialization codegen expects the implementer to provide. The generated
// emitOnChange is a template over the payload type, so callers must pass a
// concrete struct — a braced initializer list does not deduce.
using ReconcileChangeEvent =
    NativeReconcileEngineChangeEvent<std::string, std::string>;

template <>
struct Bridging<ReconcileChangeEvent>
    : NativeReconcileEngineChangeEventBridging<ReconcileChangeEvent> {};

class NativeReconcileEngine
    : public NativeReconcileEngineCxxSpec<NativeReconcileEngine>,
      public std::enable_shared_from_this<NativeReconcileEngine> {
 public:
  explicit NativeReconcileEngine(std::shared_ptr<CallInvoker> jsInvoker);
  ~NativeReconcileEngine() override;

  void open(jsi::Runtime& rt, std::string path);
  void close(jsi::Runtime& rt);
  AsyncPromise<std::string> execute(jsi::Runtime& rt, std::string requestJson);
  AsyncPromise<std::string> ingestDirect(jsi::Runtime& rt, std::string sourceId, std::string payload);
  // executeSync runs the engine call on the calling (JS) thread rather than
  // handing it to the worker. It no longer waits on engineMutex_ for an
  // in-flight ingest — that lock is now a lifecycle guard only (see below) —
  // but a *write* command still serialises on the Rust engine mutex, so a
  // sync write issued mid-ingest blocks the JS thread until that ingest
  // completes. Reads are unaffected: they take the read-only connection.
  // Prefer execute() for writes, which queues onto the worker thread.
  std::string executeSync(jsi::Runtime& rt, std::string requestJson);
  bool installFastPath(jsi::Runtime& rt);

 private:
  void workerLoop();
  void post(std::function<void()> task);
  static void eventTrampoline(void* ctx, const char* channel, const char* payload);

  engine_handle_t engine_{nullptr};
  // Path the engine is currently open at, so a second open with a DIFFERENT
  // path is rejected instead of silently no-oping (audit F37).
  std::string openPath_;
  // Lifecycle guard, NOT a work lock. Every engine entry point takes it in
  // SHARED mode purely to keep `engine_` alive for the duration of the call;
  // only open/close/teardown take it EXCLUSIVELY, which waits for in-flight
  // calls to drain before the handle is freed.
  //
  // Mutual exclusion of the actual engine work belongs to Rust, which already
  // owns it: every FFI entry takes either the engine mutex (writes) or the
  // read-only connection mutex (entry queries). Holding an exclusive lock here
  // as well made every read queue behind whatever ingest was running — on a
  // moto g35 that was a 2.1 s JS-thread stall and 1.9 fps, against 65 fps for
  // the same load without sync readers.
  std::shared_mutex engineMutex_;

  std::thread worker_;
  std::mutex queueMutex_;
  std::condition_variable queueCv_;
  std::queue<std::function<void()>> queue_;
  bool stopping_{false};
};

} // namespace facebook::react
