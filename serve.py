"""
360° Video Maker のローカルサーバー。
ES モジュールと ffmpeg.wasm のロードに HTTP サーバーが必要なため用意。

使い方:
    python serve.py
    -> http://localhost:8000 をブラウザで開く

    ポートを変えたいとき:
    python serve.py 8080
"""
import sys
import http.server
from pathlib import Path

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
ROOT = Path(__file__).resolve().parent


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        # ffmpeg.wasm マルチスレッド版を使う場合に必要（現在は ST 版なので不要）
        # self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        # self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        self.send_header('Cache-Control', 'no-store')
        # Service Worker のスコープ制限回避用（サブディレクトリに置いても / 全体をスコープに）
        if self.path.endswith('/sw.js'):
            self.send_header('Service-Worker-Allowed', '/')
        super().end_headers()


if __name__ == '__main__':
    # ThreadingHTTPServer でないと Service Worker の install 中に
    # 他のリクエスト（例: fetch('sw.js') や app shell）を並行で捌けず、
    # install が無期限にブロックする。
    with http.server.ThreadingHTTPServer(('', PORT), Handler) as httpd:
        print(f'Serving {ROOT} at http://localhost:{PORT}')
        print('Ctrl+C to stop.')
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print()
