"""P0 acceptance checks: real media file and API, mocked models, no external services."""
from dataclasses import replace
from pathlib import Path
import shutil
import subprocess
import pytest
from client_helpers import TestClient

from app import main, db, library, worker, extractor, labs, tutor
from app.config import settings
from scripts import validate_local


@pytest.mark.skipif(not shutil.which('ffmpeg') or not shutil.which('ffprobe'), reason='FFmpeg required')
def test_api_media_notes_tutor_and_sandbox_contract(tmp_path, monkeypatch):
    videos = tmp_path/'courses'/'Kubernetes'
    videos.mkdir(parents=True)
    clip = videos/'pods.mp4'
    subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','color=c=navy:s=320x180:r=5',
                    '-t','3','-c:v','mpeg4','-y',str(clip)], check=True, timeout=20)
    updated = replace(settings, courses_dir=videos.parent, data_dir=tmp_path/'data', disable_frames=True, enable_vision=False)
    for module in (main, db, library, worker, extractor, labs):
        monkeypatch.setattr(module, 'settings', updated)
    monkeypatch.setattr(worker, 'transcribe', lambda *_:([{'start':0,'end':2,'text':'Pods are Kubernetes scheduling units.'}], 'en'))
    monkeypatch.setattr(worker, 'index_video', lambda *_: None)

    with TestClient(main.app) as client:
        assert client.post('/api/scan').json()['imported'] == 1
        job = db.claim_job()
        worker.process(job)
        vid = db.fetch_videos()[0]['id']
        detail = client.get('/api/videos/'+vid).json()
        assert detail['video']['status']=='done'
        speech = [c for c in detail['chunks'] if c['kind']=='speech']
        assert speech and speech[0]['start']==0
        stream = client.get('/api/videos/'+vid+'/stream',headers={'Range':'bytes=0-63'})
        assert stream.status_code == 206 and stream.headers['content-range'].startswith('bytes 0-63/')
        assert len(stream.content)==64
        added = client.post('/api/videos/'+vid+'/notes',json={'position':1.25,'content':'Seek and revisit pods'}).json()
        assert added['position']==1.25
        assert client.get('/api/videos/'+vid+'/notes').json()['notes'][0]['id']==added['id']
        assert client.delete('/api/notes/'+added['id']).status_code==204
        assert client.get('/api/videos/'+vid+'/notes').json()['notes']==[]
        assert client.put('/api/videos/'+vid+'/progress',json={'position':1.5,'percent':50}).status_code==200
        assert client.get('/api/progress').json()['progress'][0]['percent']==50
        assert client.post('/api/labs/k8s-resilient-service/start').status_code==200
        cmd = labs.docker_command(tmp_path,'k8s-resilient-service')
        for flag in ('--network=none','--cap-drop=ALL','--read-only','--pull=never'):
            assert flag in cmd
        assert not any('docker.sock' in argument or 'kubeconfig' in argument for argument in cmd)
        monkeypatch.setattr(__import__('app.tutor',fromlist=['ask']), 'ask', lambda **kwargs: {'answer':'Pods are deployable units [S1]',
                              'sources':[{'label':'S1','video_id':vid,'start':0,'end':2,'text':speech[0]['text']}]})
        answer = client.resolve(client.post('/api/ask',json={'question':'What are pods?', 'video_id':vid})).json()
        assert answer['sources'][0]['start']==0 and answer['sources'][0]['video_id']==vid


def test_p0_validator_rejects_non_loopback_urls():
    for url in ('http://example.com', 'https://localhost:8000','http://127.0.0.1:8000/path',
                'http://127.0.0.1:8000?token=secret', 'http://user:pass@localhost:8000'):
        with pytest.raises(ValueError):
            validate_local.local_url(url)
    assert validate_local.local_url('http://127.0.0.1:8000/')=='http://127.0.0.1:8000'


def test_p0_validator_report_can_prove_missing_services(monkeypatch):
    monkeypatch.setattr(validate_local.shutil, 'which', lambda _name: None)
    def unavailable(*_args, **_kwargs):
        raise OSError('not running')
    monkeypatch.setattr(validate_local, 'api', unavailable)
    args = type('Args', (), {'url':'http://127.0.0.1:8000','video_id':None,'lab_smoke':False,'real_inference':False})()
    result = validate_local.run(args)
    assert result['passed'] is False
    assert result['real_inference_exercised'] is False
    assert any(x['check']=='Ollama reachable' and not x['passed'] for x in result['checks'])
