require "json"
package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "ReconcileEngine"
  s.version      = package["version"]
  s.summary      = "Redis-esque Rust reconcile engine turbo module"
  s.homepage     = "https://example.invalid/reconcile-engine"
  s.license      = "MIT"
  s.authors      = { "Initial Studios" => "jake@initialstudios.com.au" }
  s.platforms    = { :ios => "15.1" }
  s.source       = { :path => "." }

  s.source_files = "ios/**/*.{h,mm}", "cpp/**/*.{h,cpp}"
  s.header_mappings_dir = "."
  s.vendored_frameworks = "ios-rust/ReconcileEngine.xcframework"
  s.pod_target_xcconfig = {
    "CLANG_CXX_LANGUAGE_STANDARD" => "c++20",
  }

  install_modules_dependencies(s)
end
