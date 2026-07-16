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
    : public NativeReconcileEngineCxxSpec<NativeReconcileEngine> {
 public:
  explicit NativeReconcileEngine(std::shared_ptr<CallInvoker> jsInvoker);
  ~NativeReconcileEngine() override;

  void open(jsi::Runtime& rt, std::string path);
  void close(jsi::Runtime& rt);
  AsyncPromise<std::string> execute(jsi::Runtime& rt, std::string requestJson);
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
