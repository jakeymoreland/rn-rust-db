# App-level CMake config: builds libappmodules.so with the ReconcileEngine
# C++ Turbo Module compiled in and the Rust static library linked.
cmake_minimum_required(VERSION 3.13)
project(appmodules)

# Resolve the package dir via node (audit F52/S51) so this works whether the
# package lives in the workspace or under node_modules; fall back to the fixed
# relative path if node resolution fails.
execute_process(
        COMMAND node --print "require('path').dirname(require.resolve('@rn-experiments/reconcile-engine/package.json'))"
        WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
        OUTPUT_VARIABLE PKG_RESOLVED
        OUTPUT_STRIP_TRAILING_WHITESPACE
        RESULT_VARIABLE PKG_RESOLVE_RESULT)
if(PKG_RESOLVE_RESULT EQUAL 0 AND EXISTS ${PKG_RESOLVED})
        set(PKG ${PKG_RESOLVED})
else()
        set(PKG ${CMAKE_SOURCE_DIR}/../../../../../../../packages/reconcile-engine)
endif()

# Audit C4: fail configure with an actionable message if the Rust artifact for
# this ABI is missing/stale, instead of a later ninja "no rule to make" error.
execute_process(
        COMMAND bash ${PKG}/scripts/check-artifacts.sh
        RESULT_VARIABLE ARTIFACTS_OK)
if(NOT ARTIFACTS_OK EQUAL 0)
        message(FATAL_ERROR "reconcile-engine: prebuilt Rust artifacts missing or stale — run packages/reconcile-engine/scripts/build-android.sh")
endif()

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
# (all four ABIs are built: arm64-v8a, armeabi-v7a, x86_64, x86 — audit S49).
add_library(reconcile_engine_rust STATIC IMPORTED)
set_target_properties(reconcile_engine_rust PROPERTIES
        IMPORTED_LOCATION ${PKG}/android-rust/${ANDROID_ABI}/libreconcile_engine.a)
target_link_libraries(${CMAKE_PROJECT_NAME} reconcile_engine_rust log)
