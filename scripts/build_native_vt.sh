#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="${FLOETERM_GHOSTTY_SOURCE:-}"
EXPECTED_COMMIT=d2c70a8c7b9b6893c13640c02d7b6f9a1624f3f0
OUT="$ROOT/terminal-go/internal/nativevt/generated"

if [[ -z "$SOURCE" || ! -d "$SOURCE/.git" ]]; then
  echo "FLOETERM_GHOSTTY_SOURCE must name the fixed Ghostty source checkout" >&2
  exit 1
fi
if ! git -C "$SOURCE" diff --quiet "$EXPECTED_COMMIT" -- src include build.zig build.zig.zon; then
  echo "Ghostty engine/public source differs from fixed commit $EXPECTED_COMMIT" >&2
  exit 1
fi

(cd "$SOURCE" && zig build -Demit-lib-vt -Demit-macos-app=false -Doptimize=ReleaseFast)
mkdir -p "$OUT/include" "$OUT/lib"
rsync -a --delete "$SOURCE/zig-out/include/ghostty/" "$OUT/include/ghostty/"
install -m 0644 "$SOURCE/zig-out/lib/libghostty-vt.a" "$OUT/lib/libghostty-vt.a"
install -m 0644 "$SOURCE/gate/native/adapter.c" "$OUT/adapter.c"
install -m 0644 "$SOURCE/gate/native/adapter.h" "$OUT/adapter.h"

cat > "$OUT/provenance.txt" <<EOF
ghostty_commit=$EXPECTED_COMMIT
adapter_commit=$(git -C "$SOURCE" rev-parse HEAD)
optimize=ReleaseFast
emit_lib_vt=true
adapter_c_sha256=$(shasum -a 256 "$OUT/adapter.c" | awk '{print $1}')
adapter_h_sha256=$(shasum -a 256 "$OUT/adapter.h" | awk '{print $1}')
archive_sha256=$(shasum -a 256 "$OUT/lib/libghostty-vt.a" | awk '{print $1}')
EOF
