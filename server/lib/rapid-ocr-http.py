"""Private, serialized RapidOCR HTTP adapter for LiteParse; no external requests."""
import contextlib
import email.policy
from email.parser import BytesParser
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import runpy
import sys
import tempfile

MAX_BODY = 32 * 1024 * 1024
convert_output = runpy.run_path(str(Path(__file__).with_name("rapid-ocr.py")))["convert_output"]
engine = None

class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(30)

    def log_message(self, *args):
        # No recognized text, image paths, headers or request contents in logs.
        pass

    def reply(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self.reply(200, {"status": "ok", "engine": "RapidOCR"})
        else:
            self.reply(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/ocr":
            return self.reply(404, {"error": "not found"})
        try:
            n = int(self.headers.get("Content-Length", "0"))
            ctype = self.headers.get("Content-Type", "")
            if n <= 0 or n > MAX_BODY or not ctype.lower().startswith("multipart/form-data;"):
                return self.reply(400, {"error": "invalid image request"})
            data = self.rfile.read(n)
            if len(data) != n:
                return self.reply(400, {"error": "incomplete request"})
            message = BytesParser(policy=email.policy.default).parsebytes(
                b"Content-Type: " + ctype.encode("ascii") + b"\r\nMIME-Version: 1.0\r\n\r\n" + data)
            if not message.is_multipart():
                return self.reply(400, {"error": "invalid multipart"})
            parts = [p for p in message.iter_parts()
                     if p.get_param("name", header="content-disposition") == "file"]
            if len(parts) != 1:
                return self.reply(400, {"error": "one image required"})
            image = parts[0].get_payload(decode=True) or b""
            if image.startswith(b"\x89PNG\r\n\x1a\n"):
                ext = ".png"
            elif image.startswith(b"\xff\xd8\xff"):
                ext = ".jpg"
            else:
                return self.reply(400, {"error": "unsupported image"})
            with tempfile.TemporaryDirectory(prefix="erp-liteparse-") as directory:
                filename = Path(directory) / ("page" + ext)
                filename.write_bytes(image)
                filename.chmod(0o600)
                with contextlib.redirect_stdout(sys.stderr):
                    items = convert_output(engine(str(filename)))
            results = [{"text": i["text"], "confidence": i["score"],
                        "bbox": [i["x"], i["y"], i["x"] + i["w"], i["y"] + i["h"]]}
                       for i in items if i["w"] > 0 and i["h"] > 0]
            self.reply(200, {"results": results})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            # Do not include sensitive material or exception text in HTTP responses/logs.
            try:
                self.reply(500, {"error": "RapidOCR inference failed"})
            except OSError:
                pass

def main():
    global engine
    os.umask(0o077)
    with contextlib.redirect_stdout(sys.stderr):
        from rapidocr import RapidOCR
        engine = RapidOCR()
    HTTPServer(("127.0.0.1", 18765), Handler).serve_forever()

if __name__ == "__main__":
    main()
