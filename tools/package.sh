#!/usr/bin/env bash
# Builds an upload-ready zip for cPanel hosting (e.g. MilesWeb): app files + slimmed PHP libraries.
# Usage: tools/package.sh [output.zip]
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="$(realpath -m "${1:-baymax-upload.zip}")"
composer --working-dir=api install --no-dev --no-interaction -q
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/baymax/api"
cp -r .htaccess index.html manifest.webmanifest sw.js icon.svg css js "$TMP/baymax/"
cp -r api/assistant.php api/config.sample.php api/vendor "$TMP/baymax/api/"
find "$TMP/baymax/api/vendor" -type d \( -name .git -o -name tests -o -name examples -o -name fixtures -o -name scripts \) -prune -exec rm -rf {} +
rm -f "$OUT"; (cd "$TMP" && zip -qr "$OUT" baymax)
echo "Wrote $OUT ($(du -h "$OUT" | cut -f1))"
