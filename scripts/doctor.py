"""Run with python scripts/doctor.py after installing Python dependencies."""
import json
import shutil
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.config import settings


def check(url, method='GET', payload=None):
    try:
        data = json.dumps(payload).encode() if payload else None
        req=urllib.request.Request(url, data=data, method=method,
                                   headers={'Content-Type':'application/json'})
        with urllib.request.urlopen(req, timeout=7) as reply:
            return json.loads(reply.read().decode())
    except (urllib.error.URLError, TimeoutError, ValueError) as exc:
        return {'error':str(exc)}


print('CourseForge environment check')
print('Python:', sys.version.split()[0], '(3.11/3.12 recommended)')
print('Courses:', settings.courses_dir, 'exists:', settings.courses_dir.is_dir())
print('Data:', settings.data_dir)
for utility in ['ffmpeg', 'ffprobe', 'tesseract','docker']:
    print(utility+':', shutil.which(utility) or 'NOT FOUND')
models=check(settings.ollama_url+'/api/tags')
if 'error' in models:
    print('Ollama: NOT REACHABLE:', models['error'])
else:
    names = [m.get('name') for m in models.get('models', [])]
    print('Ollama: OK. Installed models:', ', '.join(names) or 'none')
    for name in [settings.chat_model,settings.embed_model,settings.vision_model]:
        print(' ',name,'installed:', name in names)
qdrant=check(settings.qdrant_url+'/collections')
print('Qdrant:', 'OK' if 'result' in qdrant else 'NOT REACHABLE: '+str(qdrant.get('error',qdrant)))

import subprocess
if shutil.which('docker'):
    result = subprocess.run(['docker','image','inspect',settings.lab_image],capture_output=True,text=True,timeout=15)
    print('Lab grader Docker image:', 'READY' if result.returncode==0 else 'NOT BUILT')
print('Vision:', 'ENABLED' if settings.enable_vision else 'DISABLED', 'model:',settings.vision_model)
print('kind live checks:', 'ENABLED' if settings.enable_kind else 'DISABLED')
