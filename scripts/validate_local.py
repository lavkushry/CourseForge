"""CourseForge P0 acceptance checks against a running local application.

No cloud dependencies and no arbitrary learner code execution. Optional lab smoke
runs only a curated, fixed test submission in the restricted Docker grader.

Examples:
  python scripts/validate_local.py
  python scripts/validate_local.py --video-id <id> --lab-smoke
  python scripts/validate_local.py --video-id <id> --real-inference
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.config import settings


def local_url(value: str) -> str:
    parts = urlsplit(value)
    if parts.scheme != 'http' or parts.hostname not in {'localhost', '127.0.0.1', '::1'} or parts.username or parts.password or parts.query or parts.fragment:
        raise ValueError('Only loopback HTTP endpoints are accepted; do not expose CourseForge to the network')
    if parts.path not in {'', '/'}:
        raise ValueError('Specify the app origin without a path')
    return value.rstrip('/')


def api(url: str, *, method: str = 'GET', payload=None, headers=None, timeout=15):
    data = None if payload is None else json.dumps(payload).encode('utf-8')
    req = urllib.request.Request(url, method=method, data=data,
                                 headers={'Content-Type': 'application/json', **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return response.status, dict(response.headers), response.read(4096 if '/stream' in url else 2_000_000)
    except urllib.error.HTTPError as exc:
        return exc.code, dict(exc.headers), exc.read(2000)


def run(args) -> dict:
    base = local_url(args.url)
    checks: list[dict] = []

    def check(name, condition, detail=''):
        checks.append({'check': name, 'passed': bool(condition), 'detail': str(detail)[:400]})

    for tool in ('ffmpeg', 'ffprobe', 'tesseract'):
        check('tool:' + tool, shutil.which(tool) is not None, shutil.which(tool) or 'missing')

    try:
        status, _, body = api(base + '/api/health')
        data = json.loads(body)
        check('app health', status == 200 and data.get('status') == 'ok', 'HTTP ' + str(status))
    except (OSError, ValueError, TimeoutError) as exc:
        check('app health', False, exc)

    try:
        status, _, body = api(settings.ollama_url + '/api/tags')
        data = json.loads(body)
        names = {model.get('name') for model in data.get('models', [])}
        check('Ollama reachable', status == 200, 'HTTP ' + str(status))
        for model in [settings.chat_model, settings.embed_model] + ([settings.vision_model] if settings.enable_vision else []):
            check('Ollama model: ' + model, model in names, 'pull with: ollama pull ' + model)
    except (OSError, ValueError, TimeoutError) as exc:
        check('Ollama reachable', False, exc)

    try:
        status, _, body = api(settings.qdrant_url + '/collections')
        check('Qdrant reachable', status == 200 and 'result' in json.loads(body), 'HTTP ' + str(status))
    except (OSError, ValueError, TimeoutError) as exc:
        check('Qdrant reachable', False, exc)

    if args.video_id:
        from urllib.parse import quote
        vid = quote(args.video_id, safe='')
        try:
            status, _, body = api(base + '/api/videos/' + vid)
            document = json.loads(body)
            video = document.get('video') or {}
            chunks = document.get('chunks') or []
            check('indexed lecture', status == 200 and video.get('status') == 'done', 'HTTP ' + str(status))
            check('timestamped source chunks', bool(chunks) and all(isinstance(c.get('start'), (int,float)) for c in chunks), str(len(chunks)) + ' chunks')
            status, headers, sample = api(base + '/api/videos/' + vid + '/stream', headers={'Range': 'bytes=0-63'})
            check('seekable video HTTP Range', status == 206 and len(sample) > 0 and headers.get('Content-Range', '').startswith('bytes 0-'), 'HTTP ' + str(status))
            # The notes API is tested by creating and then deleting ONLY our own probe note.
            note_id = None
            try:
                status, _, body = api(base + '/api/videos/' + vid + '/notes', method='POST', payload={'position': 1, 'content': 'CourseForge P0 validation probe'})
                if status == 201:
                    note_id = json.loads(body).get('id')
                check('timestamped note create', status == 201 and bool(note_id), 'HTTP ' + str(status))
                if note_id:
                    status, _, body = api(base + '/api/videos/' + vid + '/notes')
                    notes = json.loads(body).get('notes', [])
                    check('timestamped note read', status == 200 and any(n.get('id') == note_id and n.get('position') == 1 for n in notes))
            finally:
                if note_id:
                    status, _, _ = api(base + '/api/notes/' + quote(note_id, safe=''), method='DELETE')
                    check('probe note cleanup', status == 204, 'HTTP ' + str(status))
        except (OSError, ValueError, TimeoutError, KeyError) as exc:
            check('lecture/stream/notes checks', False, exc)

    if args.lab_smoke:
        if not shutil.which('docker'):
            check('Docker lab runner', False, 'Install Docker Desktop')
        else:
            try:
                probe = subprocess.run(['docker', 'image', 'inspect', settings.lab_image], capture_output=True, timeout=12)
                if probe.returncode != 0:
                    check('Docker lab image', False, 'Build: docker build -f docker/lab.Dockerfile -t courseforge-lab:local .')
                else:
                    check('Docker lab image', True)
                    status, _, body = api(base + '/api/labs/python-log-analysis/start', method='POST')
                    if status != 200:
                        raise RuntimeError('Cannot create lab session (HTTP ' + str(status) + ')')
                    session = json.loads(body)['session_id']
                    solution = 'def count_errors(lines):\n    return sum("ERROR" in line.split() for line in lines)\n'
                    status, _, _ = api(base + '/api/lab-sessions/' + session + '/file', method='PUT', payload={'content': solution})
                    if status != 200:
                        raise RuntimeError('Cannot save lab solution (HTTP ' + str(status) + ')')
                    status, _, body = api(base + '/api/lab-sessions/' + session + '/submit', method='POST', payload={'validate_in_kind': False}, timeout=50)
                    result = json.loads(body)
                    check('restricted Docker lab grading', status == 200 and result.get('passed') is True,
                          result.get('detail', 'HTTP ' + str(status)))
            except (OSError, ValueError, TimeoutError, KeyError, RuntimeError) as exc:
                check('restricted Docker lab grading', False, exc)

    if args.real_inference:
        if not args.video_id:
            check('real AI inference', False, '--real-inference requires --video-id')
        else:
            try:
                result = subprocess.run([sys.executable, str(Path(__file__).with_name('e2e_real.py')), '--video-id', args.video_id, '--fresh-transcript'],
                                        capture_output=True, text=True, timeout=args.inference_timeout)
                check('real Whisper/vision/Ollama/Qdrant workflow', result.returncode == 0,
                      (result.stdout + '\n' + result.stderr)[-400:])
            except (OSError, subprocess.TimeoutExpired) as exc:
                check('real Whisper/vision/Ollama/Qdrant workflow', False, exc)

    return {'passed': all(item['passed'] for item in checks), 'checks': checks,
            'real_inference_exercised': args.real_inference, 'docker_grader_exercised': args.lab_smoke}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', default='http://127.0.0.1:8000', help='CourseForge loopback origin')
    parser.add_argument('--video-id', help='ID of an indexed lecture in the configured local library')
    parser.add_argument('--lab-smoke', action='store_true', help='Run a fixed known-good submission in the isolated Docker grader')
    parser.add_argument('--real-inference', action='store_true', help='Exercise genuine models and Qdrant using e2e_real.py; may reindex the video')
    parser.add_argument('--inference-timeout', type=int, default=3600, help='Maximum seconds for the local AI pipeline')
    parser.add_argument('--json-output', type=Path, help='Optional machine-readable report path (keep reports local)')
    args = parser.parse_args()
    try:
        report = run(args)
    except ValueError as exc:
        parser.error(str(exc))
    for check in report['checks']:
        print(('PASS' if check['passed'] else 'FAIL') + ' ' + check['check'] + (' — ' + check['detail'] if check['detail'] else ''))
    print('P0 acceptance:', 'PASS' if report['passed'] else 'FAIL')
    if args.json_output:
        args.json_output.parent.mkdir(parents=True, exist_ok=True)
        args.json_output.write_text(json.dumps(report, indent=2), encoding='utf-8')
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    sys.exit(main())
