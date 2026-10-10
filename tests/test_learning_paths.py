"""Cross-course planning, source fidelity, prerequisite and API regression tests."""
import json
from dataclasses import replace
import httpx
import pytest
from client_helpers import TestClient
from app import db, library, main, learning_paths

def seeded(tmp_path, monkeypatch):
    root=tmp_path/'courses'
    for course in ('SQL','Python','Spark'):
        (root/course).mkdir(parents=True)
        (root/course/'lesson.mp4').write_bytes(b'video')
    config=replace(db.settings,courses_dir=root,data_dir=tmp_path/'runtime')
    for module in (db,library,main):
        monkeypatch.setattr(module,'settings',config)
    db.init_db(config.db_path)
    library.scan_courses(root,config.db_path)
    videos={v['course']:v for v in db.fetch_videos(config.db_path)}
    content={'SQL':[('SQL Basics',15),('SQL joins',32)],
             'Python':[('Python Basics',10),('SQL joins',57)],
             'Spark':[('PySpark transformations',73)]}
    with db.connect(config.db_path) as conn:
        for course,items in content.items():
            src=videos[course]
            payload={'course':course,'source_fingerprint':course+'-v1',
                     'topics':[{'title':title,'objectives':['Understand '+title],
                                'sources':[{'video_id':src['id'],'video_title':src['title'],'start':stamp}]}
                               for title,stamp in items]}
            conn.execute('INSERT INTO syllabi VALUES(?,?,?,?)',
                         (course,json.dumps(payload),'2026-10-09T00:00:00',payload['source_fingerprint']))
    return config,videos

def test_path_dedup_invented_cycle_rejection_and_progress(tmp_path,monkeypatch):
    config,_=seeded(tmp_path,monkeypatch)
    def fake_planner(steps,goal):
        base=next(s for s in steps if s['title']=='SQL Basics')['id']
        joins=next(s for s in steps if s['title']=='SQL joins')['id']
        return {'edges':[{'before':base,'after':joins,'reason':'Foundations first'},
                         {'before':joins,'after':base},
                         {'before':'invented','after':base},
                         {'before':base,'after':base},
                         {'before':base,'after':joins}], 'focus':[joins,'fake']}
    path=learning_paths.generate(['SQL','Python'],'Prepare for Data Engineering',
                                 db_path=config.db_path,planner=fake_planner)
    assert path['inference']=='ai'
    assert len(path['steps'])==3
    assert path['topics_collapsed']==1
    assert path['rejected_edges']==4
    assert len(path['edges'])==1
    joins=next(s for s in path['steps'] if s['title']=='SQL joins')
    assert {s['course'] for s in joins['sources']}=={'SQL','Python'}
    assert {s['start'] for s in joins['sources']}=={32,57}
    basics=next(s for s in path['steps'] if s['title']=='SQL Basics')
    assert joins['prerequisites']==[basics['id']]
    with pytest.raises(learning_paths.PathInputError):
        learning_paths.mark_step(path['id'],joins['id'],True,config.db_path)
    learning_paths.mark_step(path['id'],basics['id'],True,config.db_path)
    result=learning_paths.mark_step(path['id'],joins['id'],True,config.db_path)
    assert result['completed_steps']==2
    assert result['completion_percent']==67
    again=learning_paths.generate(['Python','SQL'],'Prepare for Data Engineering',
                                  db_path=config.db_path,planner=fake_planner)
    assert again['id']==path['id']
    assert again['completed_steps']==2
    after=learning_paths.mark_step(path['id'],basics['id'],False,config.db_path)
    assert after['completed_steps']==0
    with db.connect(config.db_path) as conn:
        row=conn.execute('SELECT content_json FROM syllabi WHERE course=?',('SQL',)).fetchone()
        data=json.loads(row[0]);data['source_fingerprint']='v2'
        conn.execute('UPDATE syllabi SET content_json=? WHERE course=?',(json.dumps(data),'SQL'))
    assert learning_paths.get_path(path['id'],config.db_path)['outdated']

def test_offline_fallback_and_input_errors(tmp_path,monkeypatch):
    config,_=seeded(tmp_path,monkeypatch)
    offline=learning_paths.generate(['SQL'],'Learn SQL joins',db_path=config.db_path,use_ai=False)
    assert offline['inference']=='local-rules'
    assert len(offline['edges'])==1
    def unavailable(steps,goal):
        raise httpx.ConnectError('offline')
    fallback=learning_paths.generate(['SQL'],'Learn SQL joins',db_path=config.db_path,planner=unavailable)
    assert fallback['inference']=='local-rules-fallback'
    assert len(learning_paths.list_paths(config.db_path))==1
    with pytest.raises(learning_paths.PathInputError):
        learning_paths.generate(['Missing'],'Learn more',db_path=config.db_path,use_ai=False)
    with pytest.raises(learning_paths.PathNotFound):
        learning_paths.get_path('missing',config.db_path)

def test_learning_path_api_source_progress_and_gating(tmp_path,monkeypatch):
    config,videos=seeded(tmp_path,monkeypatch)
    with TestClient(main.app) as client:
        response=client.post('/api/learning-paths',json={'courses':['SQL','Python'],
                                    'goal':'Learn SQL joins','use_ai':False})
        response=client.resolve(response)
        assert response.status_code==200,response.text
        path=response.json()
        assert len(path['steps'])==3
        assert client.get('/api/learning-paths').json()['paths'][0]['id']==path['id']
        assert client.get('/api/learning-paths/'+path['id']).status_code==200
        joins=next(s for s in path['steps'] if s['title']=='SQL joins')
        basics=next(s for s in path['steps'] if s['title']=='SQL Basics')
        client.put('/api/videos/'+videos['SQL']['id']+'/progress',json={'percent':100,'position':32})
        refreshed=client.get('/api/learning-paths/'+path['id']).json()
        assert next(s for s in refreshed['steps'] if s['id']==joins['id'])['watched_sources']==1
        assert refreshed['completed_steps']==0
        assert client.put('/api/learning-paths/'+path['id']+'/steps/'+joins['id'],json={'completed':True}).status_code==409
        assert client.put('/api/learning-paths/'+path['id']+'/steps/'+basics['id'],json={'completed':True}).status_code==200
        assert client.put('/api/learning-paths/'+path['id']+'/steps/'+joins['id'],json={'completed':True}).status_code==200
        assert client.get('/api/learning-paths/bad').status_code==404
        assert client.put('/api/learning-paths/'+path['id']+'/steps/bad',json={'completed':True}).status_code==404
        assert client.post('/api/learning-paths',json={'courses':['bad'],'goal':'Learn SQL','use_ai':False}).status_code==422

def test_frontend_path_contract():
    from pathlib import Path
    root=Path(__file__).parents[1]/'app'/'static'
    html=(root/'index.html').read_text()
    js=(root/'learning-paths.js').read_text()
    service=(root/'services.js').read_text()
    assert '/static/learning-paths.js' in html
    assert '/static/learning-paths.css' in html
    for element in ('crossPathForm','pathCourseChoices','pathGoal','pathUseAI','createPathBtn',
                    'savedPathList','crossPathDetail','crossPathSteps','reloadPathsBtn'):
        assert f'id="{element}"' in html
        assert f"$('#{element}')" in js
    for call in ('learningPaths','createLearningPath','completeLearningStep'):
        assert call in service and call in js
