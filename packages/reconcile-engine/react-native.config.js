/**
 * Autolinking config for consuming apps.
 *
 * `NativeReconcileEngine` is a pure C++ TurboModule, so on Android it is not
 * reachable through a Java ReactPackage. These three keys are what make React
 * Native's autolinking generate, into the app's build dir:
 *
 *   - `Android-autolinking.cmake` — an `add_subdirectory` of the CMakeLists
 *     below plus `reconcile_engine_cxx` in AUTOLINKED_LIBRARIES;
 *   - `autolinking.cpp` — `#include <NativeReconcileEngine.h>` and the
 *     `autolinking_cxxModuleProvider` branch that constructs the module.
 *
 * Paths are relative to the package's `android/` directory.
 */
module.exports = {
  dependency: {
    platforms: {
      android: {
        cxxModuleCMakeListsModuleName: 'reconcile_engine_cxx',
        cxxModuleCMakeListsPath: 'src/main/jni/CMakeLists.txt',
        cxxModuleHeaderName: 'NativeReconcileEngine',
      },
    },
  },
};
