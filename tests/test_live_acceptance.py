"""Acceptance harness regression tests: real loopback API, simulated AI only."""
from __future__ import annotations

from dataclasses import replace
import json
from pathlib import Path
import shutil
import subprocess
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app import main, db, library, worker, extractor, labs
from app.config import settings
from scripts import acceptance_live as live


class LocalAdapter(live.Acceptance):
    """Use the actual FastAPI app in-process; only the HTTP transport is replaced."""
    def __init__(self, client):
        super().__init__('http://127.0.0.1:8000')
        self.client=client

    def call(self, path: str, method='GET', *, payload=None, headers=None, timeout=20, max_bytes=2_000_000):
        response=self.client.request(method,path,json=payload,headers=headers)
        assert len(response.content)<=max_bytes
        return response.status_code, dict(response.headers),response.content


@pytest.fixture
def actual_api(tmp_path,monkeypatch):
    if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
        pytest.skip('FFmpeg is required for real file-streaming acceptance tests')
    folder=tmp_path/'courses'/'Python'
    folder.mkdir(parents=True)
    subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','color=c=navy:s=320x180:r=5',
                   '-t','3','-c:v','mpeg4','-y',str(folder/'intro.mp4')],check=True,timeout=30)
    cfg=replace(settings,courses_dir=folder.parent,data_dir=tmp_path/'data',enable_vision=False,disable_frames=True)
    for module in (main,db,library,worker,extractor,labs):
        monkeypatch.setattr(module,'settings',cfg)
    monkeypatch.setattr(worker,'transcribe',lambda *_: ([{'start':0,'end':2,'text':'Python functions and modules'}],'en'))
    monkeypatch.setattr(worker,'index_video',lambda *_:None)
    with TestClient(main.app) as c:
        assert c.post('/api/scan').json()['imported']==1
        worker.process(db.claim_job())
        vid=db.fetch_videos()[0]['id']
        yield LocalAdapter(c),vid,c


def test_real_media_note_and_focus_lifecycle(actual_api):
    harness,vid,client=actual_api
    assert harness.health()
    assert harness.video(vid)
    assert harness.notes(vid) is None
    harness.focus(vid)
    statuses={result.name:result.status for result in harness.results}
    for check in ('local FastAPI health','indexed lecture and transcript','source timestamps',
                  'video byte-range seeking','note create','timestamped note read',
                  'probe note cleanup','focus session starts and links to lesson',
                  'focus pauses','focus resumes','focus persisted history','probe timer cleanup'):
        assert statuses.get(check)=='PASS', (check,[(i.name,i.status,i.detail) for i in harness.results])
    assert client.get('/api/videos/'+vid+'/notes').json()['notes']==[]
    assert client.get('/api/focus/active').json()['session'] is None
    # Probe was cancelled, so it cannot inflate focus analytics.
    assert client.get('/api/focus/history').json()['sessions'][0]['status']=='cancelled'
    assert all(not row['completed'] and row['percent']==0 for row in client.get('/api/progress').json()['progress'])


def test_existing_focus_session_is_preserved(actual_api):
    harness,vid,client=actual_api
    learner=client.post('/api/focus/sessions',json={'duration_minutes':15,'title':'My study'}).json()
    harness.focus(vid)
    assert any(c.name=='focus timer lifecycle' and c.status=='SKIP' for c in harness.results)
    assert client.get('/api/focus/active').json()['session']['id']==learner['id']
    client.post('/api/focus/sessions/'+learner['id']+'/actions',json={'action':'cancel'})


def test_missing_video_fails_honestly(actual_api):
    harness,vid,client=actual_api
    assert harness.video('nonexistent-id') is False
    assert any(c.status=='FAIL' for c in harness.results)


def test_missing_health_prevents_mutations(monkeypatch):
    monkeypatch.setattr(live.Acceptance,'health',lambda self:False)
    args=SimpleNamespace(url='http://127.0.0.1:8000',video_id='video',focus=True,docker_lab=True,
                         real_ai=True,browser=True,inference_timeout=3600,screenshot_dir=None)
    result=live.execute(args)
    assert len(result)==6 and all(x.status=='SKIP' for x in result)


def test_video_optional_modes_are_skipped_without_claiming_success(monkeypatch):
    monkeypatch.setattr(live.Acceptance,'health',lambda self:True)
    args=SimpleNamespace(url='http://127.0.0.1:8000',video_id=None,focus=False,docker_lab=False,
                         real_ai=False,browser=False,inference_timeout=3600,screenshot_dir=None)
    checks=live.execute(args)
    assert len(checks)==5 and all(c.status=='SKIP' for c in checks)


def test_inference_opt_in_requires_video(monkeypatch):
    monkeypatch.setattr(live.Acceptance,'health',lambda self:True)
    args=SimpleNamespace(url='http://127.0.0.1:8000',video_id=None,focus=False,docker_lab=False,
                         real_ai=True,browser=False,inference_timeout=3600,screenshot_dir=None)
    checks=live.execute(args)
    assert any(c.name=='real AI pipeline' and c.status=='FAIL' for c in checks)


def test_no_remote_base_urls():
    for origin in ('http://example.com','https://localhost:8000','http://127.0.0.1:8000/docs',
                   'http://user:pass@localhost:8000','http://localhost:8000?secret=x'):
        with pytest.raises(ValueError):
            live.Acceptance(origin)
    assert live.Acceptance('http://127.0.0.1:8000').origin=='http://127.0.0.1:8000'


def test_no_probe_uses_docker_implicitly(actual_api,monkeypatch):
    harness,vid,_=actual_api
    def unexpected(*args,**kwargs):
        raise AssertionError('Docker/model execution should be explicitly opt-in')
    monkeypatch.setattr(harness,'lab',unexpected)
    monkeypatch.setattr(harness,'inference',unexpected)
    harness.health();harness.video(vid);harness.notes(vid);harness.focus(vid)
    assert all(c.status=='PASS' for c in harness.results)