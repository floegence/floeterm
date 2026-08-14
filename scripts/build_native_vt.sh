#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="${FLOETERM_GHOSTTY_SOURCE:-}"
EXPECTED_COMMIT=d2c70a8c7b9b6893c13640c02d7b6f9a1624f3f0
EXPECTED_ADAPTER_COMMIT=a3f9fda90c98bb12059fd16da67f3d7c544ebf6c
EXPECTED_ZIG_VERSION=0.16.0
OUT="$ROOT/terminal-go/internal/nativevt/generated"
TARGETS=(
  "aarch64-macos:darwin-arm64"
  "x86_64-macos:darwin-amd64"
  "aarch64-linux-gnu:linux-arm64"
  "x86_64-linux-gnu:linux-amd64"
)

if [[ -z "$SOURCE" || ! -d "$SOURCE/.git" ]]; then
  echo "FLOETERM_GHOSTTY_SOURCE must name the fixed Ghostty source checkout" >&2
  exit 1
fi
if ! git -C "$SOURCE" diff --quiet "$EXPECTED_COMMIT" -- src include build.zig build.zig.zon; then
  echo "Ghostty engine/public source differs from fixed commit $EXPECTED_COMMIT" >&2
  exit 1
fi
if [[ "$(git -C "$SOURCE" rev-parse HEAD)" != "$EXPECTED_ADAPTER_COMMIT" ]] ||
   [[ -n "$(git -C "$SOURCE" status --porcelain)" ]]; then
  echo "Ghostty adapter checkout must be clean at $EXPECTED_ADAPTER_COMMIT" >&2
  exit 1
fi
if [[ "$(zig version)" != "$EXPECTED_ZIG_VERSION" ]]; then
  echo "Zig $EXPECTED_ZIG_VERSION is required" >&2
  exit 1
fi

rm -rf "$OUT"
mkdir -p "$OUT/include" "$OUT/lib"
build_root="$(mktemp -d "${TMPDIR:-/tmp}/floeterm-native-vt.XXXXXX")"
trap 'rm -rf "$build_root"' EXIT

for entry in "${TARGETS[@]}"; do
  zig_target="${entry%%:*}"
  artifact_name="${entry##*:}"
  prefix="$build_root/$artifact_name"
  (cd "$SOURCE" && zig build \
    -Demit-lib-vt \
    -Demit-macos-app=false \
    -Doptimize=ReleaseFast \
    -Dtarget="$zig_target" \
    -p "$prefix")
  install -m 0644 "$prefix/lib/libghostty-vt.a" "$OUT/lib/libghostty-vt-$artifact_name.a"
  if [[ ! -d "$OUT/include/ghostty" ]]; then
    rsync -a --delete "$prefix/include/ghostty/" "$OUT/include/ghostty/"
  fi
done
install -m 0644 "$SOURCE/gate/native/adapter.c" "$OUT/adapter.c"
install -m 0644 "$SOURCE/LICENSE" "$OUT/GHOSTTY_LICENSE"
install -m 0644 "$SOURCE/gate/native/adapter.h" "$OUT/adapter.h"

{
cat <<EOF
ghostty_commit=$EXPECTED_COMMIT
adapter_commit=$EXPECTED_ADAPTER_COMMIT
zig_version=$EXPECTED_ZIG_VERSION
optimize=ReleaseFast
emit_lib_vt=true
targets=aarch64-macos,x86_64-macos,aarch64-linux-gnu,x86_64-linux-gnu
ghostty_vt_header_set_sha256=$(cd "$SOURCE" && find include/ghostty/vt -type f -print | LC_ALL=C sort | while IFS= read -r file; do shasum -a 256 "$file"; done | shasum -a 256 | awk '{print $1}')
adapter_c_sha256=$(shasum -a 256 "$OUT/adapter.c" | awk '{print $1}')
adapter_h_sha256=$(shasum -a 256 "$OUT/adapter.h" | awk '{print $1}')
ghostty_license_sha256=$(shasum -a 256 "$OUT/GHOSTTY_LICENSE" | awk '{print $1}')
EOF
for archive in "$OUT"/lib/*.a; do
  printf '%s_sha256=%s\n' "$(basename "$archive" .a | tr '-' '_')" "$(shasum -a 256 "$archive" | awk '{print $1}')"
done
} > "$OUT/provenance.txt"
