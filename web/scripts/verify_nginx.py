#!/usr/bin/env python3
"""Isolated public routing smoke test for the pinned nginx image; no production writes."""
import http.client
import json
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

WEB = Path(__file__).resolve().parents[1]
IMAGE = 'nginx:1.29.5-alpine@sha256:1eff5a5f3fcf8431a0abb7eddf5471fec24e5e1905a2581aeacdb07a4479b92b'

class Probe(BaseHTTPRequestHandler):
    def do_GET(self): self.respond()
    def do_HEAD(self): self.respond()
    def do_POST(self): self.respond()
    def log_message(self, *_): pass
    def respond(self):
        body = json.dumps({'upstream': self.server.label, 'method': self.command, 'range': self.headers.get('Range'), 'cookie': self.headers.get('Cookie'), 'csrf': self.headers.get('X-CSRF-Token')}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'private, no-store')
        self.send_header('X-Probe-Upstream', self.server.label)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        if self.command != 'HEAD': self.wfile.write(body)

def main():
    if not (WEB / 'dist/index.html').exists(): raise SystemExit('Run npm run build first.')
    servers = [ThreadingHTTPServer(('127.0.0.1', 0), Probe) for _ in range(2)]
    for server, label in zip(servers, ['api', 'media']):
        server.label = label
        threading.Thread(target=server.serve_forever, daemon=True).start()
    with socket.socket() as available:
        available.bind(('127.0.0.1', 0)); port = available.getsockname()[1]
    name = f'courseforge-nginx-probe-{uuid.uuid4().hex[:12]}'
    try:
        with tempfile.TemporaryDirectory(prefix='courseforge-nginx-') as directory:
            template = (WEB / 'nginx.conf.template').read_text()
            substitutions = {'COURSEFORGE_WEB_PORT': f'127.0.0.1:{port}', 'COURSEFORGE_API_UPSTREAM': f'127.0.0.1:{servers[0].server_port}', 'COURSEFORGE_MEDIA_UPSTREAM': f'127.0.0.1:{servers[1].server_port}'}
            for key, value in substitutions.items(): template = template.replace('${' + key + '}', value)
            config = Path(directory) / 'default.conf'; config.write_text(template)
            subprocess.run(['docker', 'run', '--rm', '-d', '--name', name, '--network', 'host', '-v', f'{config}:/etc/nginx/conf.d/default.conf:ro', '-v', f'{WEB / "dist"}:/usr/share/nginx/html:ro', IMAGE], check=True, stdout=subprocess.DEVNULL)
            deadline = time.monotonic() + 10
            while True:
                try:
                    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=1)
                    connection.request('GET', '/health'); response = connection.getresponse(); response.read(); connection.close()
                    if response.status == 200: break
                except OSError:
                    if time.monotonic() >= deadline: raise
                    time.sleep(.1)
            subprocess.run(['docker', 'exec', name, 'nginx', '-t'], check=True, capture_output=True)
            checks = [('GET', '/api/v1/auth/me', 'api'), ('POST', '/api/v1/playback/sessions', 'api'), ('POST', '/api/v1/playback/sessions/ps_synthetic/pulse', 'api'), ('GET', '/api/v1/playback/sessions/ps_synthetic/media?t=synthetic-test-token', 'media'), ('HEAD', '/api/v1/playback/sessions/ps_synthetic/media?t=synthetic-test-token', 'media'), ('GET', '/media/synthetic', 'media'), ('GET', '/verify/synthetic-certificate', 'api'), ('GET', '/api/v1/certificates/verify/synthetic-certificate', 'api')]
            for method, path, expected in checks:
                connection = http.client.HTTPConnection('127.0.0.1', port, timeout=3)
                connection.request(method, path, headers={'Range': 'bytes=0-15', 'Cookie': 'cf_session=synthetic', 'X-CSRF-Token': 'synthetic-csrf'})
                response = connection.getresponse(); body = response.read()
                assert response.status == 200 and response.getheader('X-Probe-Upstream') == expected, (method, path, response.status)
                if method == 'HEAD': assert body == b''
                else:
                    data = json.loads(body)
                    assert data['range'] == 'bytes=0-15' and data['cookie'] == 'cf_session=synthetic' and data['csrf'] == 'synthetic-csrf'
                connection.close()
            logs = subprocess.run(['docker', 'logs', name], check=True, capture_output=True, text=True)
            assert 'synthetic-test-token' not in logs.stdout + logs.stderr
            print('PASS: nginx syntax; eight API/media/certificate routing cases; HEAD; Range/cookie/CSRF forwarding; token excluded from logs.')
    finally:
        subprocess.run(['docker', 'rm', '-f', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for server in servers: server.shutdown(); server.server_close()

if __name__ == '__main__': main()
