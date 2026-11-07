#!/bin/bash
# 安装 RapidOCR（纯 CPU 的 PP-OCR ONNXRuntime 版），供 ERP_OCR_PROVIDER=rapidocr 使用。
#
# 只装到独立 venv（/opt/rapidocr-venv），不污染系统 Python。
# 磁盘约 450 MB，运行峰值内存约 560 MB。
# 可用 ERP_PIP_INDEX 覆盖 pip 源（默认清华镜像）。
set -e

VENV="${ERP_RAPIDOCR_VENV:-/opt/rapidocr-venv}"
PIP_INDEX="${ERP_PIP_INDEX:-https://pypi.tuna.tsinghua.edu.cn/simple}"

echo "==> 安装系统依赖（python3-venv / libgl1）"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq python3-venv libgl1 libglib2.0-0

echo "==> 创建虚拟环境 $VENV"
rm -rf "$VENV"
python3 -m venv "$VENV"

echo "==> 安装 rapidocr_onnxruntime（源：$PIP_INDEX）"
"$VENV/bin/pip" install -q --upgrade pip -i "$PIP_INDEX"
"$VENV/bin/pip" install -q -i "$PIP_INDEX" rapidocr_onnxruntime

echo "==> 验证"
"$VENV/bin/python" - <<'PY'
from rapidocr_onnxruntime import RapidOCR
import onnxruntime, cv2
print("RapidOCR 就绪 | onnxruntime", onnxruntime.__version__, "| opencv", cv2.__version__)
PY

du -sh "$VENV"
echo "==> 完成。设置 ERP_OCR_PROVIDER=rapidocr 后重启服务即可。"
