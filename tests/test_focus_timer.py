"""Focus sessions: server-measured intervals, safe links and non-inflated analytics."""
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
import pytest
from client_helpers import TestClient
from app import db, focus, main, planner, weekly
from test_daily_planner import seed

UTC=timezone.utc

def when(day, hour=0, minute=0, second=0):
    return datetime.fromisoformat(day).replace(hour=hour,minute=minute,second=second,tzinfo=UTC)

def test_start_pause_resume_finish_history_and_analytics(tmp_path,monkeypatch):
    cfg,path,videos=seed(tmp_path,monkeypatch)
    first=when('2026-10-05',10)
    item=planner.generate('2026-10-05',-330,db_path=cfg.db_path)['items'][0]
    s=focus.start(planner_item_id=item['id'],db_path=cfg.db_path,at=first,duration_minutes=25)
    assert s['status']=='running' and s['planner_item_id']==item['id']
    assert focus.active(cfg.db_path, at=first+timedelta(seconds=120))['session']['elapsed_seconds']==120
    paused=focus.transition(s['id'],'pause',cfg.db_path, at=first+timedelta(minutes=3))
    assert paused['elapsed_seconds']==180
    assert focus.active(cfg.db_path,at=first+timedelta(hours=2))['session']['elapsed_seconds']==180
    resumed=focus.transition(s['id'],'resume',cfg.db_path,at=first+timedelta(hours=2))
    assert resumed['status']=='running'
    finished=focus.transition(s['id'],'finish',cfg.db_path,at=first+timedelta(hours=2,minutes=7))
    assert finished['status']=='finished' and finished['elapsed_seconds']==600
    assert focus.active(cfg.db_path,at=first+timedelta(hours=3))['session'] is None
    assert focus.history(cfg.db_path)['sessions'][0]['elapsed_seconds']==600
    week=focus.analytics('2026-10-05',-330,cfg.db_path,at=first+timedelta(hours=3))
    assert week['measured_minutes']==10
    assert week['active_days']==1
    assert week['self_reported_minutes']==0
    assert week['planned_minutes']>0


def test_auto_expiration_is_bounded_and_break_excluded(tmp_path,monkeypatch):
    cfg,path,_=seed(tmp_path,monkeypatch)
    start=when('2026-10-05',12)
    session=focus.start(db_path=cfg.db_path,at=start,duration_minutes=5)
    assert focus.active(cfg.db_path,at=start+timedelta(hours=20))['session'] is None
    snap=focus.history(cfg.db_path,at=start+timedelta(hours=20))['sessions'][0]
    assert snap['elapsed_seconds']==300 and snap['status']=='finished'
    assert focus.analytics('2026-10-05',0,cfg.db_path,at=start+timedelta(hours=20))['measured_minutes']==5
    break_start=start+timedelta(hours=21)
    rest=focus.start(mode='break',duration_minutes=5,db_path=cfg.db_path,at=break_start)
    focus.transition(rest['id'],'finish',cfg.db_path,at=break_start+timedelta(minutes=4))
    assert focus.analytics('2026-10-05',0,cfg.db_path,at=break_start+timedelta(minutes=5))['measured_minutes']==5


def test_conflict_invalid_links_and_cancel(tmp_path,monkeypatch):
    cfg,path,videos=seed(tmp_path,monkeypatch)
    now=when('2026-10-05',11)
    with pytest.raises(focus.FocusInputError):
        focus.start(duration_minutes=True,db_path=cfg.db_path)
    with pytest.raises(focus.FocusInputError):
        focus.start(duration_minutes=130,db_path=cfg.db_path)
    with pytest.raises(focus.FocusInputError):
        focus.start(video_id=videos[0]['id'],planner_item_id='missing',db_path=cfg.db_path)
    with pytest.raises(focus.FocusNotFound):
        focus.start(video_id='does-not-exist',db_path=cfg.db_path)
    s=focus.start(video_id=videos[0]['id'],db_path=cfg.db_path,at=now)
    with pytest.raises(focus.FocusConflict):
        focus.start(db_path=cfg.db_path,at=now+timedelta(seconds=5))
    with pytest.raises(focus.FocusConflict):
        focus.transition(s['id'],'resume',cfg.db_path,at=now)
    focus.transition(s['id'],'cancel',cfg.db_path,at=now+timedelta(minutes=2))
    with pytest.raises(focus.FocusConflict):
        focus.transition(s['id'],'pause',cfg.db_path,at=now+timedelta(minutes=3))
    assert focus.analytics('2026-10-05',0,cfg.db_path,at=now+timedelta(minutes=4))['measured_minutes']==0


def test_cross_midnight_timezone_distribution_and_paused_gap(tmp_path,monkeypatch):
    cfg,path,_=seed(tmp_path,monkeypatch)
    # UTC 18:29 Monday => IST 23:59 Monday; 18:31 => IST 00:01 Tuesday.
    t=when('2026-10-05',18,29)
    s=focus.start(duration_minutes=10,db_path=cfg.db_path,at=t)
    focus.transition(s['id'],'pause',cfg.db_path,at=t+timedelta(minutes=2))
    focus.transition(s['id'],'resume',cfg.db_path,at=t+timedelta(hours=3))
    focus.transition(s['id'],'finish',cfg.db_path,at=t+timedelta(hours=3,minutes=2))
    a=focus.analytics('2026-10-05',-330,cfg.db_path,at=t+timedelta(hours=4))
    assert a['days'][0]['measured_minutes']==1
    assert a['days'][1]['measured_minutes']==3
    assert a['measured_minutes']==4
    assert a['active_days']==2


def test_manual_minutes_are_not_inflated_by_timer(tmp_path,monkeypatch):
    cfg,path,_=seed(tmp_path,monkeypatch)
    day=planner.generate('2026-10-05',0,db_path=cfg.db_path)
    item=day['items'][0]
    planner.set_item_actual_minutes(item['id'],42,cfg.db_path)
    s=focus.start(planner_item_id=item['id'],db_path=cfg.db_path,at=when('2026-10-05',13))
    focus.transition(s['id'],'finish',cfg.db_path,at=when('2026-10-05',13,12))
    a=focus.analytics('2026-10-05',0,cfg.db_path,at=when('2026-10-05',14))
    assert a['self_reported_minutes']==42 and a['measured_minutes']==12
    assert planner.get_day('2026-10-05',cfg.db_path)['actual_minutes']==42


def test_api_start_status_actions_validation_and_security(tmp_path,monkeypatch):
    cfg,path,videos=seed(tmp_path,monkeypatch)
    with TestClient(main.app) as client:
        assert client.post('/api/focus/sessions',json={'mode':'focus','duration_minutes':0}).status_code==422
        assert client.post('/api/focus/sessions',json={'video_id':'bad'}).status_code==404
        assert client.post('/api/focus/sessions',json={'duration_minutes':25},headers={'Origin':'http://evil.example'}).status_code==403
        result=client.post('/api/focus/sessions',json={'video_id':videos[0]['id'],'duration_minutes':25})
        assert result.status_code==201
        sid=result.json()['id']
        assert client.get('/api/focus/active').json()['session']['id']==sid
        assert client.post('/api/focus/sessions',json={}).status_code==409
        assert client.post(f'/api/focus/sessions/{sid}/actions',json={'action':'pause'}).status_code==200
        assert client.post(f'/api/focus/sessions/{sid}/actions',json={'action':'resume'}).status_code==200
        assert client.post(f'/api/focus/sessions/{sid}/actions',json={'action':'finish'}).status_code==200
        assert client.get('/api/focus/active').json()['session'] is None
        assert client.get('/api/focus/history').json()['sessions'][0]['id']==sid
        assert client.get('/api/focus/analytics/2026-10-06').status_code==422
        assert len(client.get('/api/focus/analytics/2026-10-05?tz_offset_minutes=-330').json()['days'])==7
        assert client.post('/api/focus/sessions/bad-id/actions',json={'action':'pause'}).status_code==404


def test_frontend_is_wired_and_use_original_theme_tokens():
    root=Path(__file__).resolve().parents[1]/'app'/'static'
    html=(root/'index.html').read_text()
    for element_id in ['focusClock','focusStart','focusPause','focusResume','focusFinish','focusCancel',
                       'focusVideo','focusLab','focusWeekLabel','focusBars','focusHistory','focusReported','focusMeasured']:
        assert f'id="{element_id}"' in html
    from tests.web_assets import assert_tool_shipped
    assert_tool_shipped('focus')
    assert 'beginFocus' in (root/'services.js').read_text()
    assert 'CourseForgeFocus' in (root/'planner.js').read_text()
    assert 'prefers-reduced-motion' in (root/'focus.css').read_text()
