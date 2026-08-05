require "json"
package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "ReconcileEngine"
  s.version      = package["version"]
  s.summary      = "On-device reconciler for multi-source data in React Native"
  s.homepage     = "https://github.com/jakeymoreland/rn-rust-db"
  s.license      = "MIT"
  s.authors      = { "Initial Studios" => "jake@initialstudios.com.au" }
  s.platforms    = { :ios => "15.1" }
  s.source       = { :path => "." }

  # Audit C4: fail pod install with an actionable message when the prebuilt Rust
  # artifacts are missing or stale, instead of a later undefined-symbol link
  # error (the binaries are gitignored and built by scripts/build-ios.sh).
  s.prepare_command = "bash scripts/check-artifacts.sh"

  s.source_files = "ios/**/*.{h,mm}", "cpp/**/*.{h,cpp}"
  s.header_mappings_dir = "."
  s.vendored_frameworks = "ios-rust/ReconcileEngine.xcframework"
  s.pod_target_xcconfig = {
    "CLANG_CXX_LANGUAGE_STANDARD" => "c++20",
  }

  install_modules_dependencies(s)
end
