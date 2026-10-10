"""Weekly P1 tests: no fabricated time, due dates, repeated lessons or lost history."""
from dataclasses import replace
from datetime import datetime, timezone
from client_helpers import TestClient
import pytest
from app import db, weekly, planner, study, main
from test_daily_planner import seed


def test_weekday_preference_validation_and_calendar_empty(tmp_path, monkeypatch):
    config = replace(db.settings,data_dir=tmp_path/'data',courses_dir=tmp_path/'courses')
    monkeypatch.setattr(db, 'settings', config)
    db.init_db(config.db_path)
    assert weekly.preferences(config.db_path)['weekday_minutes'] == [45,45,45,45,45,0,0]
    for budgets in ([0]*7, [20]*6, [45,45,45,45,45,-1,0], [45,True,45,45,0,0,0]):
        with pytest.raises(planner.PlannerInputError):
            weekly.save_preferences(budgets, config.db_path)
    assert weekly.save_preferences([30,0,30,0,30,0,0],config.db_path)['weekday_minutes'][1]==0
    assert weekly.get_week('2026-10-05',config.db_path) is None
    with pytest.raises(planner.PlannerInputError):
        weekly.get_week('2026-10-06',config.db_path)
    with pytest.raises(planner.PlannerInputError):
        weekly.build('2026-10-05',900,db_path=config.db_path)
    empty=weekly.build('2026-10-05',-330,db_path=config.db_path)
    assert len(empty['days'])==7 and empty['planned_minutes']==0
    assert empty['days'][1]['rest_day']


def test_review_forecast_matches_local_dates_and_study_day(tmp_path, monkeypatch):
    config,path,videos=seed(tmp_path,monkeypatch)
    study.add_cards('Data Engineering', [
        {'video_id':videos[0]['id'],'question':'What is a valid primary key?','answer':'A unique row identifier'},
        {'video_id':videos[0]['id'],'question':'What does JOIN do in SQL?','answer':'Combines rows'},
    ], config.db_path)
    # 2026-10-07 UTC 22:00 => Thu 2026-10-08 03:30 IST, next active day Fri.
    with db.connect(config.db_path) as conn:
        ids=[r['id'] for r in conn.execute('SELECT id FROM review_cards ORDER BY id')]
        conn.execute('UPDATE review_cards SET due_at=? WHERE id=?',('2026-10-07T22:00:00+00:00',ids[0]))
        conn.execute('UPDATE review_cards SET due_at=? WHERE id=?',('2026-10-05T06:00:00+00:00',ids[1]))
    weekly.save_preferences([30,0,0,0,30,0,0],config.db_path)
    cal=weekly.build('2026-10-05',-330,db_path=config.db_path)
    assert cal['days'][0]['forecast_reviews']==1
    assert cal['days'][4]['forecast_reviews']==1
    assert cal['forecast_reviews']==2
    mon=planner.get_day('2026-10-05',config.db_path)
    fri=planner.get_day('2026-10-09',config.db_path)
    assert any(x['kind']=='review' and x['action']['due_card_ids']==[ids[1]] for x in mon['items'])
    assert any(x['kind']=='review' and x['action']['due_card_ids']==[ids[0]] for x in fri['items'])


def test_week_tasks_unique_and_prerequisite_locked(tmp_path,monkeypatch):
    config,path,_=seed(tmp_path,monkeypatch)
    planner.save_preferences(45,path['id'],config.db_path)
    weekly.save_preferences([45]*7,config.db_path)
    week=weekly.build('2026-10-05',-330,db_path=config.db_path)
    all_items=[]
    for d in week['days']:
        day=planner.get_day(d['date'],config.db_path)
        assert day['planned_minutes']<=45
        all_items.extend(day['items'])
    assert len({x['item_key'] for x in all_items})==len(all_items)
    assert len([x for x in all_items if x['kind']=='lesson'])<=1  # second topic locked
    assert weekly.build('2026-10-05',-330,db_path=config.db_path)['week_start']=='2026-10-05'


def test_recorded_time_survives_calendar_refresh_and_does_not_change_mastery(tmp_path,monkeypatch):
    config,path,videos=seed(tmp_path,monkeypatch)
    planner.save_preferences(60,path['id'],config.db_path)
    weekly.save_preferences([60,0,0,0,0,0,0],config.db_path)
    week=weekly.build('2026-10-05',-330,db_path=config.db_path)
    item=planner.get_day('2026-10-05',config.db_path)['items'][0]
    planner.set_item_actual_minutes(item['id'],37,config.db_path)
    planner.set_item_status(item['id'],'done',config.db_path)
    same=weekly.build('2026-10-05',-330,refresh=True,db_path=config.db_path)
    today=planner.get_day('2026-10-05',config.db_path)
    assert same['actual_minutes']==37 and today['completed_count']==1
    assert next(x for x in today['items'] if x['id']==item['id'])['actual_minutes']==37
    assert not any(x['completed'] for x in study.get_progress(path=config.db_path))
    assert weekly.build('2026-10-05',-330,db_path=config.db_path)['actual_minutes']==37
    for wrong in (True,-1,601,1.5):
        with pytest.raises(planner.PlannerInputError):
            planner.set_item_actual_minutes(item['id'],wrong,config.db_path)


def test_week_api_validation_and_persistence(tmp_path, monkeypatch):
    config,path,_=seed(tmp_path,monkeypatch)
    with TestClient(main.app) as client:
        assert client.get('/api/planner/week-preferences').status_code==200
        assert client.put('/api/planner/week-preferences',json={'weekday_minutes':[0]*7}).status_code==422
        assert client.put('/api/planner/week-preferences',json={'weekday_minutes':[30,0,30,0,0,0,0]}).status_code==200
        assert client.get('/api/planner/weeks/2026-10-05').status_code==404
        assert client.get('/api/planner/weeks/2026-10-06').status_code==422
        assert client.post('/api/planner/weeks',json={'week_start':'2026-10-06'}).status_code==422
        bad_origin=client.post('/api/planner/weeks',json={'week_start':'2026-10-05'},headers={'Origin':'http://evil.example'})
        assert bad_origin.status_code==403
        created=client.post('/api/planner/weeks',json={'week_start':'2026-10-05','tz_offset_minutes':-330})
        assert created.status_code==201
        assert client.get('/api/planner/weeks/2026-10-05').json()['days'][1]['rest_day']
        day=client.get('/api/planner/days/2026-10-05').json()
        assert day['items']
        item=day['items'][0]
        actual=client.put(f'/api/planner/items/{item["id"]}/actual',json={'actual_minutes':26})
        assert actual.status_code==200 and actual.json()['actual_minutes']==26
        assert client.put(f'/api/planner/items/{item["id"]}/actual',json={'actual_minutes':601}).status_code==422
        assert client.put('/api/planner/items/no-such-item/actual',json={'actual_minutes':1}).status_code==404
        assert client.get('/api/planner/weeks/2026-10-05').json()['actual_minutes']==26


def test_weekly_frontend_controls_exist():
    from pathlib import Path
    root=Path(__file__).resolve().parents[1]/'app'/'static'
    html=(root/'index.html').read_text()
    for name in ['weekForm','weekStart','weekDaysInput','weekBuild','weekCards','weekMessage','weekTotals']:
        assert f'id="{name}"' in html
    from tests.web_assets import assert_tool_shipped
    assert_tool_shipped('weekly')
    assert 'savePlannerActual' in (root/'services.js').read_text()
