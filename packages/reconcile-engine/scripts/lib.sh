# Shared helpers for the build scripts. Sourced, not executed.

# Content hash of the Rust source tree, read from the working tree so that
# uncommitted edits change it. Run with rust/ as the working directory.
rust_tree_hash() {
  git ls-files --cached --others --exclude-standard -- src Cargo.toml Cargo.lock \
    | LC_ALL=C sort \
    | while IFS= read -r f; do
        [ -f "$f" ] || continue
        printf '%s %s\n' "$(git hash-object -- "$f")" "$f"
      done \
    | git hash-object --stdin
}

# Writes/merges artifacts-manifest.json (audit S25/S47) recording the source
# hash and toolchain so check-artifacts.sh can detect drift.
write_manifest() {
  local pkg_dir="$1"
  local rustc_ver
  rustc_ver=$(rustc --version)
  local tree_hash
  # Hash the WORKING TREE, not the index. `git ls-files -s` emits the staged
  # blob hash, so uncommitted edits to rust/src left this value unchanged — the
  # guard that exists to stop stale native code shipping passed happily while
  # the .a on disk was older than the source, which is exactly when it should
  # fire. --others --exclude-standard also catches a brand-new, not-yet-added
  # module file.
  tree_hash=$( cd "$pkg_dir/rust" && rust_tree_hash )
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
