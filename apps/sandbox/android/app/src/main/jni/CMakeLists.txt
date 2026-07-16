# App-level CMake config: builds libappmodules.so with the ReconcileEngine
# C++ Turbo Module compiled in and the Rust static library linked.
cmake_minimum_required(VERSION 3.13)
project(appmodules)

# Path from this jni dir back to the monorepo package (7 levels up to repo root).
set(PKG ${CMAKE_SOURCE_DIR}/../../../../../../../packages/reconcile-engine)

include(${REACT_ANDROID_DIR}/cmake-utils/ReactNative-application.cmake)

target_sources(${CMAKE_PROJECT_NAME} PRIVATE ${PKG}/cpp/NativeReconcileEngine.cpp)
target_include_directories(${CMAKE_PROJECT_NAME} PUBLIC
        ${PKG}/cpp
        # NativeReconcileEngine.h does `#include <ReconcileEngineSpecJSI.h>` (flat, as
        # exposed by the iOS ReactCodegen pod). On Android the app-level codegen (run
        # by the generateAppLevelCodegen gradle task) emits that header nested under
        # react/renderer/components/<spec>/, so put that dir on the include path.
        ${PROJECT_BUILD_DIR}/generated/source/codegen/jni/react/renderer/components/ReconcileEngineSpec)

# Rust engine static library, built by packages/reconcile-engine/scripts/build-android.sh
# (only arm64-v8a and x86_64 are built; reactNativeArchitectures is restricted to match).
add_library(reconcile_engine_rust STATIC IMPORTED)
set_target_properties(reconcile_engine_rust PROPERTIES
        IMPORTED_LOCATION ${PKG}/android-rust/${ANDROID_ABI}/libreconcile_engine.a)
target_link_libraries(${CMAKE_PROJECT_NAME} reconcile_engine_rust log)
