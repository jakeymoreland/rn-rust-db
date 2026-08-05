# C++ TurboModule + Rust static library, compiled into the consuming app's
# libappmodules.so.
#
# React Native's autolinking `add_subdirectory`s this file (declared as
# `cxxModuleCMakeListsPath` in the package's react-native.config.js) and adds
# `reconcile_engine_cxx` to AUTOLINKED_LIBRARIES, so the app links it without
# any app-side CMake of its own (audit S29).
cmake_minimum_required(VERSION 3.13)

get_filename_component(PKG_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../../.." ABSOLUTE)

# Audit C4: fail at configure time with an actionable message if the Rust
# artifact for this ABI is missing or stale, instead of a later ninja
# "no rule to make target" or an undefined-symbol link error.
execute_process(
        COMMAND bash "${PKG_DIR}/scripts/check-artifacts.sh"
        RESULT_VARIABLE ARTIFACTS_OK)
if(NOT ARTIFACTS_OK EQUAL 0)
        message(FATAL_ERROR
                "reconcile-engine: prebuilt Rust artifacts are missing or stale — run "
                "${PKG_DIR}/scripts/build-android.sh")
endif()

add_library(reconcile_engine_cxx STATIC "${PKG_DIR}/cpp/NativeReconcileEngine.cpp")

# NativeReconcileEngine.h does `#include <ReconcileEngineSpecJSI.h>` (flat, as
# the iOS ReactCodegen pod exposes it). On Android that header is generated into
# this package's own build dir, nested under
# react/renderer/components/ReconcileEngineSpec/ — and the generated
# `react_codegen_ReconcileEngineSpec` target already carries both that directory
# and its parent as PUBLIC include dirs. Borrow them via a generator expression
# rather than linking the target: autolinking links the codegen OBJECT library
# into libappmodules.so directly, and linking it here as well would put the same
# objects in the binary twice.
target_include_directories(reconcile_engine_cxx PUBLIC
        "${PKG_DIR}/cpp"
        $<TARGET_PROPERTY:react_codegen_ReconcileEngineSpec,INTERFACE_INCLUDE_DIRECTORIES>)

# The Rust engine, cross-compiled by scripts/build-android.sh for all four ABIs
# React Native ships by default (audit S49).
add_library(reconcile_engine_rust STATIC IMPORTED)
set_target_properties(reconcile_engine_rust PROPERTIES
        IMPORTED_LOCATION "${PKG_DIR}/android-rust/${ANDROID_ABI}/libreconcile_engine.a")

# Plain (non-keyword) signature is required: ReactNative-application.cmake does
# `target_link_libraries(<autolinked_library> common_flags)` on every entry of
# AUTOLINKED_LIBRARIES, and CMake rejects mixing the two signatures on one target.
target_link_libraries(reconcile_engine_cxx
        reconcile_engine_rust
        log
        fbjni
        jsi
        reactnative)

target_compile_reactnative_options(reconcile_engine_cxx PRIVATE)
