"""Air-Waves 本地服务：在标准库 http.server 基础上强制禁用缓存。

为什么需要它：
    python -m http.server 只发 Last-Modified、不发 Cache-Control，
    浏览器会对这类响应做"启发式缓存"，于是改了 app.js / audio.js 之后
    刷新页面仍可能拿到旧版本，表现为"改了没生效"。

用法（与标准库一致，端口可选）：
    python serve.py 8765
    python serve.py 8765 -d .
"""
import sys
import socket
import argparse
import functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def send_header(self, keyword, value):
        # 去掉 Last-Modified：浏览器就是靠它用启发式规则判断"新鲜度"的
        if keyword.lower() == 'last-modified':
            return
        super().send_header(keyword, value)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write('%s - - [%s] %s\n' % (
            self.address_string(), self.log_date_time_string(), fmt % args))


def main():
    parser = argparse.ArgumentParser(description='Air-Waves 无缓存静态服务器')
    parser.add_argument('port', type=int, nargs='?', default=8765)
    parser.add_argument('--directory', '-d', default=None, help='网站根目录，默认为当前目录')
    args = parser.parse_args()

    handler = functools.partial(NoCacheHandler, directory=args.directory)

    ThreadingHTTPServer.address_family = socket.AF_INET
    httpd = ThreadingHTTPServer(('127.0.0.1', args.port), handler)
    print('Air-Waves 服务已启动: http://127.0.0.1:%d/   (已禁用缓存)' % args.port)
    sys.stdout.flush()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == '__main__':
    main()
