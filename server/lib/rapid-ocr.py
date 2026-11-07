"""RapidOCR 识别入口：输出 JSON 到 stdout，由 Node 侧还原表格列。

用法：python rapid-ocr.py <图片路径>
输出：{"items":[{"text","score","x","y","w","h"}],"ms":123}
"""
import json
import sys
import time

from rapidocr_onnxruntime import RapidOCR

_engine = None


def get_engine():
    global _engine
    if _engine is None:
        _engine = RapidOCR()
    return _engine


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "missing image path"}, ensure_ascii=False))
        return 1
    t0 = time.time()
    try:
        result, _ = get_engine()(sys.argv[1])
    except Exception as e:  # noqa: BLE001 - 把异常交给 Node 侧统一报错
        print(json.dumps({"error": str(e)}, ensure_ascii=False))
        return 1
    items = []
    for row in result or []:
        box, text, score = row[0], row[1], row[2]
        xs = [float(p[0]) for p in box]
        ys = [float(p[1]) for p in box]
        items.append({
            "text": text,
            "score": float(score),
            "x": min(xs),
            "y": min(ys),
            "w": max(xs) - min(xs),
            "h": max(ys) - min(ys),
        })
    print(json.dumps({"items": items, "ms": int((time.time() - t0) * 1000)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
