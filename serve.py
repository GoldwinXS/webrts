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


# Port priority: argv > PORT env (preview harnesses set this) > default 1338.
port = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("PORT", 1338))
print(f"webRTS dev server (no-cache) on http://localhost:{port}")
http.server.ThreadingHTTPServer(("", port), NoCacheHandler).serve_forever()
