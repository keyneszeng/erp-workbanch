"""RapidOCR (unified package) bridge: JSON only on stdout.

Usage: python rapid-ocr.py IMAGE_PATH
Output: {"items":[{"text","score","x","y","w","h"}],"ms":123}
The Python process is short-lived; all OCR inference stays on this server.
"""
import contextlib
import json
import sys
import time


def convert_output(output):
    """Convert RapidOCROutput.boxes/txts/scores to the Node table layout."""
    boxes = getattr(output, "boxes", None)
    texts = getattr(output, "txts", None)
    scores = getattr(output, "scores", None)
    if boxes is None or texts is None:
        return []
    if scores is None:
        scores = [1.0] * len(texts)
    items = []
    for box, text, score in zip(boxes, texts, scores):
        if text is None or len(box) == 0:
            continue
        xs = [float(point[0]) for point in box]
        ys = [float(point[1]) for point in box]
        items.append({
            "text": str(text),
            "score": float(score),
            "x": min(xs),
            "y": min(ys),
            "w": max(xs) - min(xs),
            "h": max(ys) - min(ys),
        })
    return items


def main():
    if len(sys.argv) != 2:
        print(json.dumps({"error": "missing image path"}, ensure_ascii=False))
        return 0
    start = time.monotonic()
    try:
        # Keep library diagnostics off stdout: Node must be able to parse JSON.
        with contextlib.redirect_stdout(sys.stderr):
            from rapidocr import RapidOCR
            output = RapidOCR()(sys.argv[1])
        items = convert_output(output)
        payload = {"items": items, "ms": int((time.monotonic() - start) * 1000)}
    except Exception as exc:  # Return structured error for Node's OCR_PROVIDER_FAILED.
        payload = {"error": str(exc)}
    print(json.dumps(payload, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
