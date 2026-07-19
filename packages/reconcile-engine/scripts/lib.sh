# Shared helpers for the build scripts. Sourced, not executed.

# Writes/merges artifacts-manifest.json (audit S25/S47) recording the source
# hash and toolchain so check-artifacts.sh can detect drift.
write_manifest() {
  local pkg_dir="$1"
  local rustc_ver
  rustc_ver=$(rustc --version)
  local tree_hash
  tree_hash=$( cd "$pkg_dir/rust" && git ls-files src Cargo.toml Cargo.lock | LC_ALL=C sort \
      | git hash-object --stdin-paths | git hash-object --stdin )
  cat > "$pkg_dir/artifacts-manifest.json" <<EOF
{
  "rust_tree_hash": "$tree_hash",
  "rustc": "$rustc_ver"
}
EOF
  echo "wrote artifacts-manifest.json (rust_tree_hash $tree_hash)"
}

# Preflight: confirm the required rustup targets are installed.
require_targets() {
  local missing=()
  local installed
  installed=$(rustup target list --installed 2>/dev/null || true)
  for t in "$@"; do
    echo "$installed" | grep -qx "$t" || missing+=("$t")
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    echo "ERROR: missing rustup targets: ${missing[*]}" >&2
    echo "  rustup target add ${missing[*]}" >&2
    exit 1
  fi
}
