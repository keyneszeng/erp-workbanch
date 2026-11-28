#!/bin/bash
# Optional, separate installation. Does not alter running ERP services or OCR flags.
set -Eeuo pipefail
PREFIX=/opt/erp-liteparse
VERSION=2.21.4
command -v npm >/dev/null || { echo "Install Node.js >=22 first" >&2; exit 1; }
test -x /opt/rapidocr-venv/bin/python || { echo "Run install-rapidocr.sh first" >&2; exit 1; }
mkdir -p "$PREFIX"
npm install --prefix "$PREFIX" --omit=dev --save-exact "@llamaindex/liteparse@$VERSION"
"$PREFIX/node_modules/.bin/lit" --version
# The bridge code lives in the ERP release; run as a non-root service account.
echo "LiteParse installed. Follow docs/liteparse-ocr.md to start the loopback adapter and enable the test flag."
