package com.rnexperiments.reconcileengine

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfoProvider

/**
 * Deliberately empty.
 *
 * `NativeReconcileEngine` is a pure C++ TurboModule: it is instantiated by the
 * generated `autolinking_cxxModuleProvider`, not through a Java package, so
 * there is nothing to return here.
 *
 * The class still has to exist. React Native's Android autolinking resolver
 * (`expo-modules-autolinking`'s androidResolver, and the community CLI's
 * equivalent) scans a library's `android/` directory for a class implementing
 * `ReactPackage`; if it finds none, it discards the whole Android config for
 * the dependency and the library is silently not linked. So this is the hook
 * that makes autolinking see us at all.
 */
class ReconcileEnginePackage : BaseReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? = null

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider = ReactModuleInfoProvider {
    emptyMap()
  }
}
