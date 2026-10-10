from datetime import datetime, timezone
from dataclasses import replace

from client_helpers import TestClient
from app import main, db, library, labs, study, studio


def test_studio_analytics_notes_and_api(tmp_path, monkeypatch):
    root=tmp_path/'courses'; (root/'Data Engineering').mkdir(parents=True)
    (root/'Data Engineering'/'lesson.mp4').write_bytes(b'fake video bytes')
    config=replace(db.settings,courses_dir=root,data_dir=tmp_path/'data')
    for mod in (main,db,library,labs):
        monkeypatch.setattr(mod,'settings',config)
    db.init_db()
    with TestClient(main.app) as client:
        assert client.post('/api/scan').status_code==200
        video=client.get('/api/videos').json()['videos'][0]
        vid=video['id']
        assert client.get('/api/studio/insights').json()['mastery_signal_percent'] is None
        assert client.get('/api/studio/insights').json()['streak_days']==0
        assert client.get(f'/api/videos/{vid}/notes').json()['notes']==[]
        created=client.post(f'/api/videos/{vid}/notes',json={'position':23.4,'content':'Remember this.'})
        assert created.status_code==201
        note=created.json()
        assert note['position']==23.4
        assert client.get(f'/api/videos/{vid}/notes').json()['notes'][0]['content']=='Remember this.'
        assert client.delete('/api/notes/'+note['id']).status_code==204
        assert client.get(f'/api/videos/{vid}/notes').json()['notes']==[]
        assert client.delete('/api/notes/'+note['id']).status_code==404
        assert client.post(f'/api/videos/{vid}/notes',json={'content':'', 'position':0}).status_code==422
        assert client.get('/api/videos/missing/notes').status_code==404
        assert client.post(f'/api/videos/{vid}/notes',json={'content':'valid','position':-1}).status_code==422
        client.put(f'/api/videos/{vid}/progress',json={'percent':100,'position':60})
        assert client.get('/api/progress').json()['progress'][0]['updated_at']
        row=studio.insights(path=config.db_path,now=datetime.now(timezone.utc))
        assert row['streak_days']>=1
        study.add_cards('Data Engineering',[{'video_id':vid,'question':'What is a relational database?','answer':'A database with structured tables.'}],path=config.db_path)
        card=study.due_cards(path=config.db_path)[0]
        study.grade_card(card['id'],0,path=config.db_path)
        result=client.get('/api/studio/insights').json()
        assert result['mastery_signal_percent']==0
        assert result['weak_areas'][0]['course']=='Data Engineering'
        assert result['history'][0]['quality']==0
        assert result['reviews_today']==1
