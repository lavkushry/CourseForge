"""Curated, verifiable coding labs. No LLM-generated command is run on the host."""
import json
import os
import re
import shutil
import subprocess
import uuid
from pathlib import Path
from .config import settings
from .db import connect, utcnow

LABS = {
  'python-log-analysis': {
    'title': 'Python: detect production errors', 'type': 'docker',
    'objective': 'Implement count_errors(lines) to count lines with log level ERROR, not WARNING.',
    'filename': 'solution.py', 'starter': '''def count_errors(lines: list[str]) -> int:\n    """Count log records containing the severity token ERROR."""\n    # TODO: return the number of error records\n    return 0\n''',
    'tip': 'Use the log level token instead of matching words such as error_count.',
  },
  'shell-http-analysis': {
    'title': 'Shell: inspect HTTP access logs', 'type': 'docker',
    'objective': 'Write a POSIX shell script that counts HTTP 5xx responses from stdin; output one integer.',
    'filename': 'solution.sh', 'starter': '''#!/bin/sh\n# Input: space-separated `method path status` on stdin\n# Print a single count for status codes 500-599\necho 0\n''',
    'tip': 'awk can read status code from column 3.',
  },
  'k8s-resilient-service': {
    'title': 'Kubernetes: resilient API deployment', 'type': 'kubernetes',
    'objective': ('Create a Deployment and Service YAML. The Deployment must be named learning-api, have '
                  '2 replicas, label app=learning-api, a readinessProbe and resource requests/limits. '
                  'The ClusterIP Service must be named learning-api and target port 8080.'),
    'filename': 'manifest.yaml', 'starter': '''apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: learning-api\nspec:\n  replicas: 1\n  selector:\n    matchLabels:\n      app: learning-api\n  template:\n    metadata:\n      labels:\n        app: learning-api\n    spec:\n      containers:\n        - name: api\n          image: nginx:1.27-alpine\n          ports:\n            - containerPort: 8080\n---\napiVersion: v1\nkind: Service\nmetadata:\n  name: learning-api\nspec:\n  type: ClusterIP\n  selector:\n    app: learning-api\n  ports:\n    - port: 80\n      targetPort: 8080\n''',
    'tip': 'Add readinessProbe, resource requests/limits, and ensure 2 replicas.',
  },
}

from .lab_tracks import TRACKS
LABS.update(TRACKS)


def ensure_schema(path: Path | None = None):
    with connect(path) as db:
        db.executescript('''CREATE TABLE IF NOT EXISTS lab_sessions(
          id TEXT PRIMARY KEY, slug TEXT NOT NULL, status TEXT NOT NULL,
          result_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS lab_sessions_created_idx ON lab_sessions(created_at);''')


def list_labs() -> list[dict]:
    return [{k:v for k,v in lab.items() if k!='starter'} | {'slug':slug} for slug,lab in LABS.items()]


def _workspace(session_id: str) -> Path:
    if not re.fullmatch(r'[0-9a-f]{32}', session_id):
        raise ValueError('Invalid lab session ID')
    return settings.data_dir / 'labs' / 'workspaces' / session_id


def start_lab(slug: str) -> dict:
    if slug not in LABS:
        raise KeyError(slug)
    session_id = uuid.uuid4().hex
    root = _workspace(session_id)
    root.mkdir(mode=0o755, parents=True, exist_ok=False)
    lab = LABS[slug]
    (root/lab['filename']).write_text(lab['starter'], encoding='utf-8')
    with connect() as db:
        db.execute('INSERT INTO lab_sessions(id,slug,status,created_at,updated_at) VALUES(?,?,?,?,?)',
                   (session_id, slug, 'started', utcnow(), utcnow()))
    return {'session_id':session_id, 'slug':slug, 'filename':lab['filename'],
            'content':lab['starter'], 'title':lab['title'], 'objective':lab['objective'],
            'tip':lab['tip'], 'type':lab['type'], 'category':lab.get('category','General'), 'level':lab.get('level','Guided')}


def get_lab(session_id: str) -> dict:
    with connect() as db:
        record = db.execute('SELECT * FROM lab_sessions WHERE id=?', (session_id,)).fetchone()
    if not record:
        raise KeyError(session_id)
    lab = LABS[record['slug']]
    return {'session_id':session_id, 'slug':record['slug'], 'filename':lab['filename'],
            'content':(_workspace(session_id)/lab['filename']).read_text(encoding='utf-8'),
            'status':record['status'], 'result':json.loads(record['result_json']) if record['result_json'] else None}


def update_file(session_id: str, content: str) -> dict:
    if len(content.encode('utf-8')) > 100_000:
        raise ValueError('Solution too large (limit 100 KB)')
    state = get_lab(session_id)
    root = _workspace(session_id).resolve()
    target = root / state['filename']
    if target.is_symlink() or not target.resolve().is_relative_to(root):
        raise ValueError('Unsafe workspace file')
    tmp = root / ('revision-' + uuid.uuid4().hex)
    tmp.write_text(content, encoding='utf-8')
    os.chmod(tmp, 0o644)
    os.replace(tmp, target)
    with connect() as db:
        db.execute('UPDATE lab_sessions SET status=?,result_json=NULL,updated_at=? WHERE id=?', ('started', utcnow(), session_id))
    return {'saved':True, 'bytes':len(content.encode('utf-8'))}


def docker_command(root: Path, slug: str) -> list[str]:
    grader = (Path(__file__).parent/'lab_graders').resolve()
    spark = slug == 'pyspark-order-analytics'
    image = settings.lab_spark_image if spark else settings.lab_image
    return ['docker','run','--rm','--pull=never', '--network=none','--read-only',
            '--cap-drop=ALL','--security-opt=no-new-privileges', '--pids-limit='+('128' if spark else '64'),
            '--memory='+('2g' if spark else '256m'),'--cpus='+('2' if spark else '1'),'--user=65534:65534',
            '--tmpfs=/tmp:rw,nosuid'+(',size=512m' if spark else ',noexec,size=16m'),
            '--mount',f'type=bind,src={root},dst=/workspace,readonly',
            '--mount',f'type=bind,src={grader},dst=/grader,readonly',
            image,'python','/grader/grade.py',slug]


def _offline_grading(session_id: str, slug: str) -> dict:
    if not shutil.which('docker'):
        raise RuntimeError('Docker CLI not installed; install Docker Desktop and build the lab image')
    command = docker_command(_workspace(session_id).resolve(), slug)
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=120 if slug == 'pyspark-order-analytics' else 40, check=False)
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError('Lab grading exceeded its execution timeout') from exc
    if result.returncode != 0:
        raise RuntimeError('Restricted Docker grader failed: ' + result.stderr[-700:])
    try:
        parsed = json.loads(result.stdout)
    except ValueError as exc:
        raise RuntimeError('Invalid grading response') from exc
    if not isinstance(parsed,dict) or not isinstance(parsed.get('checks'),list):
        raise RuntimeError('Invalid grading result structure')
    return parsed


def _kind_live_validation(root: Path) -> dict:
    """Server-side dry-run ONLY against an explicitly provisioned, dedicated kind cluster."""
    if not settings.enable_kind:
        return {'skipped': True, 'reason': 'ENABLE_KIND_LABS=0 (offline manifest checks completed)'}
    kubeconfig = (settings.data_dir/'labs'/'kind-kubeconfig').resolve()
    marker = (settings.data_dir/'labs'/'kind-owned.json').resolve()
    if kubeconfig.is_symlink() or not kubeconfig.is_file() or not marker.is_file():
        raise RuntimeError('Dedicated kind kubeconfig and provenance missing; run python scripts/kind_lab.py create')
    ownership = json.loads(marker.read_text())
    if ownership.get('name') != 'courseforge-lab' or ownership.get('kubeconfig') != str(kubeconfig):
        raise RuntimeError('Refusing unowned kind kubeconfig')
    if not shutil.which('kubectl'):
        raise RuntimeError('kubectl is required for optional kind checks')
    # Require an explicitly isolated local context; never inherit ~/.kube/config.
    prefix = ['kubectl','--kubeconfig',str(kubeconfig),'--context','kind-courseforge-lab']
    config = subprocess.run(prefix+['config','view','--minify','-o','json'],capture_output=True,text=True,timeout=10,check=True)
    data = json.loads(config.stdout)
    servers = [c.get('cluster',{}).get('server','') for c in data.get('clusters',[])]
    if len(servers)!=1 or not re.fullmatch(r'https://(127\.0\.0\.1|localhost):\d+',servers[0]):
        raise RuntimeError('Refusing non-local Kubernetes API server for lab')
    # api-server dry-run validates against the ephemeral kind cluster without creating objects.
    try:
        check = subprocess.run(prefix+['apply','--dry-run=server','--validate=strict','-f',str(root/'manifest.yaml')],
                               capture_output=True,text=True,timeout=25,check=False)
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError('kind validation timed out') from exc
    return {'passed':check.returncode==0, 'details':(check.stdout or check.stderr)[-1500:]}


def submit_lab(session_id: str, *, kind: bool = False) -> dict:
    state = get_lab(session_id)
    slug = state['slug']
    result = _offline_grading(session_id, slug)
    if kind and LABS[slug]['type']=='kubernetes' and result.get('passed'):
        result['kind'] = _kind_live_validation(_workspace(session_id).resolve())
        if not result['kind'].get('skipped'):
            result['passed'] = result['passed'] and result['kind']['passed']
    with connect() as db:
        db.execute('UPDATE lab_sessions SET status=?,result_json=?,updated_at=? WHERE id=?',
                   ('passed' if result['passed'] else 'failed', json.dumps(result), utcnow(), session_id))
    return result
