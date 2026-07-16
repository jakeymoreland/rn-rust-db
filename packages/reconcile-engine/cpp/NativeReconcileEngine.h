#pragma once

#include <ReconcileEngineSpecJSI.h>

#include <condition_variable>
#include <functional>
#include <memory>
#include <mutex>
#include <queue>
#include <string>
#include <thread>

#include "include/engine.h"

namespace facebook::react {

class NativeReconcileEngine
    : public NativeReconcileEngineCxxSpec<NativeReconcileEngine>,
      public std::enable_shared_from_this<NativeReconcileEngine> {
 public:
  explicit NativeReconcileEngine(std::shared_ptr<CallInvoker> jsInvoker);
  ~NativeReconcileEngine() override;

  void open(jsi::Runtime& rt, std::string path);
  void close(jsi::Runtime& rt);
  AsyncPromise<std::string> execute(jsi::Runtime& rt, std::string requestJson);
  // executeSync blocks the calling (JS) thread for the duration of the
  // engine call: it takes engineMutex_ directly on the caller's thread
  // instead of handing the work to the worker thread. If the worker is
  // mid-way through a long ingest and holding engineMutex_, this call will
  // block the JS thread until that ingest completes. This is an accepted
  // trade-off: executeSync exists as a benchmark/instrumentation entry
  // point, not for real workloads — production call sites should use
  // execute() instead, which queues onto the worker thread and resolves
  // asynchronously.
  std::string executeSync(jsi::Runtime& rt, std::string requestJson);
  bool installFastPath(jsi::Runtime& rt);

 private:
  void workerLoop();
  void post(std::function<void()> task);
  static void eventTrampoline(void* ctx, const char* channel, const char* payload);

  engine_handle_t engine_{nullptr};
  std::mutex engineMutex_;

  std::thread worker_;
  std::mutex queueMutex_;
  std::condition_variable queueCv_;
  std::queue<std::function<void()>> queue_;
  bool stopping_{false};
};

} // namespace facebook::react
