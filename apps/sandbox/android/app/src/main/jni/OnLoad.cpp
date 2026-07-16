/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Copied from react-native/ReactAndroid/cmake-utils/default-app-setup/OnLoad.cpp
// (RN 0.86) and edited to register the ReconcileEngine C++ Turbo Module in
// cxxModuleProvider.
//
// Differences from the default file:
// - #include <NativeReconcileEngine.h> and the kModuleName check in
//   cxxModuleProvider.
// - The REACT_NATIVE_APP_COMPONENT_DESCRIPTORS_HEADER /
//   REACT_NATIVE_APP_COMPONENT_REGISTRATION blocks are removed: the app-level
//   codegen here is modules-only (type: "modules"), so codegen emits no
//   ComponentDescriptors.h, but ReactNative-application.cmake still defines
//   both macros unconditionally — keeping the default #ifdef blocks would be
//   a hard compile error on the missing include.

#include <DefaultComponentsRegistry.h>
#include <DefaultTurboModuleManagerDelegate.h>
#include <FBReactNativeSpec.h>
#include <NativeReconcileEngine.h>
#include <autolinking.h>
#include <fbjni/fbjni.h>
#include <react/renderer/componentregistry/ComponentDescriptorProviderRegistry.h>

#ifdef REACT_NATIVE_APP_CODEGEN_HEADER
#include REACT_NATIVE_APP_CODEGEN_HEADER
#endif

namespace facebook::react {

void registerComponents(
    std::shared_ptr<const ComponentDescriptorProviderRegistry> registry) {
  // No custom Fabric components in this app; fall back to the autolinked ones.
  autolinking_registerProviders(registry);
}

std::shared_ptr<TurboModule> cxxModuleProvider(
    const std::string& name,
    const std::shared_ptr<CallInvoker>& jsInvoker) {
  if (name == facebook::react::NativeReconcileEngine::kModuleName) {
    return std::make_shared<facebook::react::NativeReconcileEngine>(jsInvoker);
  }
  // And we fallback to the CXX module providers autolinked
  return autolinking_cxxModuleProvider(name, jsInvoker);
}

std::shared_ptr<TurboModule> javaModuleProvider(
    const std::string& name,
    const JavaTurboModule::InitParams& params) {
  // We link app local modules if available
#ifdef REACT_NATIVE_APP_MODULE_PROVIDER
  auto module = REACT_NATIVE_APP_MODULE_PROVIDER(name, params);
  if (module != nullptr) {
    return module;
  }
#endif

  // We first try to look up core modules
  if (auto module = FBReactNativeSpec_ModuleProvider(name, params)) {
    return module;
  }

  // And we fallback to the module providers autolinked
  if (auto module = autolinking_ModuleProvider(name, params)) {
    return module;
  }

  return nullptr;
}

} // namespace facebook::react

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void*) {
  return facebook::jni::initialize(vm, [] {
    facebook::react::DefaultTurboModuleManagerDelegate::cxxModuleProvider =
        &facebook::react::cxxModuleProvider;
    facebook::react::DefaultTurboModuleManagerDelegate::javaModuleProvider =
        &facebook::react::javaModuleProvider;
    facebook::react::DefaultComponentsRegistry::
        registerComponentDescriptorsFromEntryPoint =
            &facebook::react::registerComponents;
  });
}
