from dataclasses import replace
from fastapi.testclient import TestClient
from app import main, db, library, labs
import pytest


def test_new_routes_with_local_database(tmp_path,monkeypatch):
    root=tmp_path/'courses';(root/'Ansible').mkdir(parents=True)
    (root/'Ansible'/'lesson.mp4').write_bytes(b'video')
    config=replace(db.settings,courses_dir=root,data_dir=tmp_path/'data')
    for mod in (main,db,library,labs):
        monkeypatch.setattr(mod,'settings',config)
    db.init_db()
    with TestClient(main.app) as client:
        scan=client.post('/api/scan')
        assert scan.json()['imported']==1
        vid=client.get('/api/videos').json()['videos'][0]['id']
        saved=client.put(f'/api/videos/{vid}/progress',json={'percent':35,'position':60})
        assert saved.status_code==200
        assert client.get('/api/progress').json()['progress'][0]['percent']==35
        assert client.get('/api/syllabus?course=Ansible').json()['syllabus'] is None
        assert client.get('/api/reviews/due').json()['cards']==[]
        result=client.get('/api/labs').json()['labs']
        assert len(result)>=3
        start=client.post('/api/labs/python-log-analysis/start').json()
        assert start['filename']=='solution.py'
        sess=start['session_id']
        assert client.get(f'/api/lab-sessions/{sess}').status_code==200
        assert client.put(f'/api/lab-sessions/{sess}/file',json={'content':'print("hi")'}).status_code==200
        assert client.get(f'/api/lab-sessions/{sess}').json()['content']=='print("hi")'
        assert client.post('/api/labs/does-not-exist/start').status_code==404
        assert client.put(f'/api/videos/{vid}/progress',json={'percent':101,'position':0}).status_code==422
        assert client.post('/api/scan',headers={'origin':'https://attacker.example'}).status_code==403
