"""P1.7: real persisted signals, budget safety, source fidelity, and independent checklist."""
import json
from dataclasses import replace

import pytest
from client_helpers import TestClient
from app import db, library, main, labs, learning_paths, planner, practice, study


def seed(tmp_path, monkeypatch):
    root = tmp_path/'courses'/'Data Engineering'
    root.mkdir(parents=True)
    for name in ('01-basics.mp4', '02-joins.mp4'):
        (root/name).write_bytes(b'video')
    config = replace(db.settings, courses_dir=root.parent, data_dir=tmp_path/'data')
    for target in (db, library, main, labs):
        monkeypatch.setattr(target, 'settings', config)
    db.init_db(config.db_path)
    library.scan_courses(root.parent, config.db_path)
    videos = db.fetch_videos(config.db_path)
    with db.connect(config.db_path) as conn:
        for video in videos:
            conn.execute("UPDATE videos SET status='done',duration=1800 WHERE id=?", (video['id'],))
        doc = {'course':'Data Engineering','source_fingerprint':'fp-1','topics':[
            {'title':'SQL Basics','objectives':['Introduction to SQL fundamentals'],
             'sources':[{'video_id':videos[0]['id'],'video_title':videos[0]['title'],'start':12}]},
            {'title':'SQL joins','objectives':['SQL join queries'],
             'sources':[{'video_id':videos[1]['id'],'video_title':videos[1]['title'],'start':30}]},
        ]}
        conn.execute('INSERT INTO syllabi VALUES (?,?,?,?)',
                     ('Data Engineering',json.dumps(doc),db.utcnow(),'fp-1'))
    path=learning_paths.generate(['Data Engineering'],'Become fluent in SQL',db_path=config.db_path,use_ai=False)
    return config,path,videos


def test_no_invented_learning_and_empty_days(tmp_path, monkeypatch):
    config = replace(db.settings,courses_dir=tmp_path/'courses',data_dir=tmp_path/'data')
    monkeypatch.setattr(db, 'settings', config)
    db.init_db(config.db_path)
    plan=planner.generate('2026-10-10',-330,db_path=config.db_path)
    assert plan['planned_minutes']==0 and plan['items']==[]
    assert planner.generate('2026-10-10',-330,db_path=config.db_path)['study_date']=='2026-10-10'


def test_due_review_before_local_day_end_and_budget(tmp_path, monkeypatch):
    config,path,videos=seed(tmp_path,monkeypatch)
    study.add_cards('Data Engineering',[{'video_id':videos[0]['id'],'question':'What is a SQL primary key?',
                                        'answer':'It uniquely identifies a row.'}],config.db_path)
    with db.connect(config.db_path) as conn:
        conn.execute("UPDATE review_cards SET due_at='2026-10-10T21:00:00+00:00'")
    planner.save_preferences(45,None,config.db_path)
    plan=planner.generate('2026-10-10',-330,db_path=config.db_path)
    assert not any(item['kind']=='review' for item in plan['items'])
    assert plan['planned_minutes'] <=45
    after=planner.generate('2026-10-10',0,refresh=True,db_path=config.db_path)
    assert after['items'][0]['kind']=='review'
    assert after['items'][0]['action']['due_card_ids']


def test_path_prerequisites_and_exact_timestamp(tmp_path, monkeypatch):
    config,path,videos=seed(tmp_path,monkeypatch)
    planner.save_preferences(60,path['id'],config.db_path)
    plan=planner.generate('2026-10-10',-330,db_path=config.db_path)
    lessons=[i for i in plan['items'] if i['kind']=='lesson']
    assert lessons
    assert lessons[0]['action']['video_id'] == videos[0]['id']
    assert lessons[0]['action']['start']==12
    assert not any(i['action'].get('video_id')==videos[1]['id'] for i in lessons)
    assert plan['planned_minutes']<=60


def test_self_report_is_not_mastery_or_video_completion(tmp_path, monkeypatch):
    config,path,_=seed(tmp_path,monkeypatch)
    planner.save_preferences(45,path['id'],config.db_path)
    plan=planner.generate('2026-10-10',0,db_path=config.db_path)
    item=plan['items'][0]
    done=planner.set_item_status(item['id'],'done',config.db_path)
    assert done['completed_count']==1
    assert learning_paths.get_path(path['id'],config.db_path)['completed_steps']==0
    assert not any(row['completed'] for row in study.get_progress(path=config.db_path))
    rerun=planner.generate('2026-10-10',0,refresh=True,db_path=config.db_path)
    assert next(i for i in rerun['items'] if i['item_key']==item['item_key'])['status']=='done'
    assert next(i for i in rerun['items'] if i['item_key']==item['item_key'])['id']==item['id']
    assert planner.set_item_status(item['id'],'pending',config.db_path)['completed_count']==0
    with pytest.raises(planner.PlannerNotFound):
        planner.set_item_status('nonexistent','done',config.db_path)


def test_empty_path_and_budget_validation(tmp_path, monkeypatch):
    config,path,_=seed(tmp_path,monkeypatch)
    for minutes in [0,14,181]:
        with pytest.raises(planner.PlannerInputError):
            planner.save_preferences(minutes,None,config.db_path)
    with pytest.raises(planner.PlannerNotFound):
        planner.save_preferences(30,'missing',config.db_path)
    for day in ['not-a-date','2026-02-29','2026-1-1']:
        with pytest.raises(planner.PlannerInputError):
            planner.generate(day,db_path=config.db_path)
    with pytest.raises(planner.PlannerInputError):
        planner.generate('2026-10-10',-900,db_path=config.db_path)
    with pytest.raises(planner.PlannerInputError):
        planner.set_item_status('bad','invalid',config.db_path)


def test_outdated_roadmap_does_not_schedule_unsafe_links(tmp_path, monkeypatch):
    config,path,_=seed(tmp_path,monkeypatch)
    planner.save_preferences(90,path['id'],config.db_path)
    with db.connect(config.db_path) as conn:
        doc=json.loads(conn.execute('SELECT content_json FROM syllabi').fetchone()[0])
        doc['source_fingerprint']='updated-index'
        conn.execute('UPDATE syllabi SET content_json=?',(json.dumps(doc),))
    plan=planner.generate('2026-10-10',0,db_path=config.db_path)
    assert plan['warnings']
    assert not any(x['kind'] in ('lab','assessment','lesson') for x in plan['items'])


def test_http_api_persistence_and_cross_origin_protection(tmp_path, monkeypatch):
    config,path,_=seed(tmp_path,monkeypatch)
    with TestClient(main.app) as client:
        prefs=client.put('/api/planner/preferences',json={'daily_minutes':45,'path_id':path['id']})
        assert prefs.status_code==200
        assert client.put('/api/planner/preferences',json={'daily_minutes':999}).status_code==422
        assert client.put('/api/planner/preferences',json={'daily_minutes':30,'path_id':'missing'}).status_code==404
        assert client.get('/api/planner/days/2026-10-10').status_code==404
        assert client.get('/api/planner/days/invalid-date').status_code==422
        blocked=client.post('/api/planner/days',json={'study_date':'2026-10-10'},headers={'Origin':'http://malicious.invalid'})
        assert blocked.status_code==403
        plan=client.post('/api/planner/days',json={'study_date':'2026-10-10','tz_offset_minutes':-330})
        assert plan.status_code==201 and plan.json()['items']
        task=plan.json()['items'][0]
        assert client.put(f'/api/planner/items/{task["id"]}',json={'status':'done'}).json()['completed_count']==1
        assert client.put(f'/api/planner/items/{task["id"]}',json={'status':'bad'}).status_code==422
        assert client.put('/api/planner/items/missing',json={'status':'done'}).status_code==404
        assert client.get('/api/planner/days/2026-10-10').json()['completed_count']==1
        assert client.post('/api/planner/days',json={'study_date':'2026-10-10','refresh':True}).json()['completed_count']==1


def test_planner_frontend_contract():
    from pathlib import Path
    root=Path(__file__).resolve().parents[1]/'app'/'static'
    html=(root/'index.html').read_text()
    scripts=(root/'planner.js').read_text()
    assert 'data-view="planner"' in html and 'data-nav="planner"' in html
    for control in ['plannerPrefs','plannerBudget','plannerPath','plannerDate','plannerCreate','plannerItems','plannerTrack']:
        assert f'id="{control}"' in html
    from tests.web_assets import assert_tool_shipped
    assert_tool_shipped('planner')
    assert 'textContent' in scripts and 'setPlannerItem' in scripts
