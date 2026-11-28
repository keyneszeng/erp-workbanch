#!/bin/bash
# Optional, separate installation. Does not alter running ERP services or OCR flags.
set -Eeuo pipefail
PREFIX=/opt/erp-liteparse
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
[[ "$(id -u)" == 0 ]] || { echo "Run as root" >&2; exit 1; }
VERSION=2.21.4
command -v npm >/dev/null || { echo "Install Node.js >=22 first" >&2; exit 1; }
test -x /opt/rapidocr-venv/bin/python || { echo "Run install-rapidocr.sh first" >&2; exit 1; }
mkdir -p "$PREFIX"
npm install --prefix "$PREFIX" --omit=dev --save-exact "@llamaindex/liteparse@$VERSION"
"$PREFIX/node_modules/.bin/lit" --version
install -d -m 0755 "$PREFIX/bridge"
install -m 0644 "$ROOT/server/lib/rapid-ocr.py" "$ROOT/server/lib/rapid-ocr-http.py" "$PREFIX/bridge/"
# Never overwrite an active unit or start/restart it automatically.
# The operator installs the supplied unit after testing the bridge under User=erp.
echo "LiteParse installed. Follow docs/liteparse-ocr.md to start the loopback adapter and enable the test flag."
