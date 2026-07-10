# Dev server with caching disabled. Browsers heuristically cache ES modules,
# which serves stale game code after edits — no-store makes every reload
# fetch fresh files. Usage: python serve.py [port]
import http.server
import os
import sys

os.chdir(os.path.dirname(os.path.abspath(__file__)))


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *args):
        pass  # quiet

    # Dev-only: accept a canvas dataURL and save it under _shots/ so headless
    # tooling can capture in-game screenshots even when the tab is hidden.
    # POST /__shot?name=foo  body = data:image/jpeg;base64,....
    def do_POST(self):
        if not self.path.startswith("/__shot"):
            self.send_error(404)
            return
        import base64
        import re
        from urllib.parse import parse_qs, urlparse
        q = parse_qs(urlparse(self.path).query)
        name = re.sub(r"[^a-zA-Z0-9_-]", "", (q.get("name") or ["shot"])[0]) or "shot"
        body = self.rfile.read(int(self.headers.get("Content-Length", 0))).decode("ascii", "ignore")
        b64 = body.split(",", 1)[1] if "," in body else body
        ext = "png" if "image/png" in body[:64] else "jpg"
        os.makedirs("_shots", exist_ok=True)
        path = os.path.join("_shots", f"{name}.{ext}")
        with open(path, "wb") as f:
            f.write(base64.b64decode(b64))
        self.send_response(200)
        self.end_headers()
        self.wfile.write(path.encode())


# Port priority: argv > PORT env (preview harnesses set this) > default 1338.
port = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("PORT", 1338))
print(f"webRTS dev server (no-cache) on http://localhost:{port}")
http.server.ThreadingHTTPServer(("", port), NoCacheHandler).serve_forever()
