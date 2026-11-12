#!/bin/bash
# Install the actively maintained RapidOCR Python package + ONNX Runtime CPU.
# Isolated venv: no system Python or application npm dependencies are changed.
set -Eeuo pipefail

VENV="${ERP_RAPIDOCR_VENV:-/opt/rapidocr-venv}"
PIP_INDEX="${ERP_PIP_INDEX:-https://pypi.tuna.tsinghua.edu.cn/simple}"

if [[ "$VENV" != /* || "$VENV" == "/" ]]; then
  echo "ERP_RAPIDOCR_VENV must be an absolute non-root path" >&2
  exit 2
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq python3-venv poppler-utils libglib2.0-0

# Keep the venv and upgrade in place: avoid deleting a live Python interpreter.
python3 -m venv "$VENV"
"$VENV/bin/python" -m pip install -q --upgrade pip -i "$PIP_INDEX"
"$VENV/bin/python" -m pip uninstall -q -y rapidocr_onnxruntime rapidocr_openvino rapidocr_paddle || true
"$VENV/bin/python" -m pip install -q --upgrade -i "$PIP_INDEX" 'rapidocr>=3.10,<4' onnxruntime

echo "==> Checking RapidOCR Python package and inference engine"
"$VENV/bin/python" - <<'PY'
from importlib.metadata import version
from rapidocr import RapidOCR
import onnxruntime
assert RapidOCR
print("RapidOCR", version("rapidocr"), "| onnxruntime", onnxruntime.__version__)
PY
"$VENV/bin/rapidocr" check
echo "==> Ready: set ERP_OCR_ENABLED=1 and restart the ERP service."
