#!/usr/bin/env python3
"""Локальный сервер МАССИНГа с живой перезагрузкой.

Отдаёт файлы без кэширования — иначе браузер держит старую версию
модуля и правки в app/*.js не видны без ручной чистки кэша.

Плюс следит за исходниками и пушит событие в браузер через SSE:
правка .css подменяется на лету, правка .js или .html перезагружает
страницу. Состояние (участок, ракурс, солнце) браузер восстанавливает
сам — см. app/livereload.js.
"""
import http.server
import os
import queue
import socketserver
import sys
import threading
import time

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
ROOT = os.path.dirname(os.path.abspath(__file__))
os.chdir(ROOT)

WATCH_DIRS = ('app',)
WATCH_FILES = ('index.html',)
POLL = 0.4

CLIENTS = []
LOCK = threading.Lock()


def scan():
    """Снимок «путь → время правки» по отслеживаемым исходникам."""
    out = {}
    for name in WATCH_FILES:
        p = os.path.join(ROOT, name)
        if os.path.exists(p):
            out[p] = os.path.getmtime(p)
    for d in WATCH_DIRS:
        base = os.path.join(ROOT, d)
        for dirpath, _, files in os.walk(base):
            for f in files:
                if f.endswith(('.js', '.css', '.html')):
                    p = os.path.join(dirpath, f)
                    try:
                        out[p] = os.path.getmtime(p)
                    except OSError:
                        pass
    return out


def broadcast(kind):
    with LOCK:
        targets = list(CLIENTS)
    for q in targets:
        q.put(kind)


def watch():
    prev = scan()
    while True:
        time.sleep(POLL)
        cur = scan()
        changed = [p for p in cur if prev.get(p) != cur[p]]
        changed += [p for p in prev if p not in cur]
        if changed:
            # Стили умеем подменять без перезагрузки — модель остаётся живой.
            kind = 'css' if all(p.endswith('.css') for p in changed) else 'reload'
            names = ', '.join(os.path.relpath(p, ROOT) for p in sorted(changed)[:4])
            print(f'  ↻ {kind}: {names}', flush=True)
            broadcast(kind)
        prev = cur


class Handler(http.server.SimpleHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        super().end_headers()

    def do_GET(self):
        if self.path.split('?')[0] == '/__events':
            self.stream_events()
            return
        super().do_GET()

    def stream_events(self):
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Connection', 'keep-alive')
        self.end_headers()

        q = queue.Queue()
        with LOCK:
            CLIENTS.append(q)
        try:
            self.wfile.write(b'data: hello\n\n')
            self.wfile.flush()
            while True:
                try:
                    msg = q.get(timeout=15)
                    self.wfile.write(f'data: {msg}\n\n'.encode())
                except queue.Empty:
                    self.wfile.write(b': ping\n\n')   # держим соединение живым
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            with LOCK:
                if q in CLIENTS:
                    CLIENTS.remove(q)

    def log_message(self, fmt, *args):
        line = fmt % args
        if '404' in line:
            sys.stderr.write(f'404: {line}\n')


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True          # SSE-соединения не должны держать выход


if __name__ == '__main__':
    threading.Thread(target=watch, daemon=True).start()
    print(f'МАССИНГ → http://localhost:{PORT}   (живая перезагрузка включена)')
    try:
        Server(('', PORT), Handler).serve_forever()
    except KeyboardInterrupt:
        print('\nостановлен')
