"""Exercise exclusive account playback through the authenticated API."""
from fastapi.testclient import TestClient
from app import db,main,media,native_player,player_sessions
from test_academy import academy_env,PASSWORD


def test_confirmed_takeover_is_shared_by_native_and_embedded(academy_env,monkeypatch):
    _,_,admin,student,_=academy_env;a,user=student();b,_=student('independent@courseforge.test')
    monkeypatch.setattr(native_player,'source_for',lambda _:('https://secure.odycdn.com/video','https://odysee.com/embed'))
    monkeypatch.setattr(media,'signed_embed',lambda _: 'https://odysee.com/embed?signature=redacted')
    first=a.post('/api/videos/lecture/player-session',json={}).json()['id']
    native=a.post('/api/videos/lecture/native-session',json={'player_session_id':first}).json()
    assert a.post('/api/videos/lecture/playback-session',json={}).status_code==409
    assert b.post('/api/videos/lecture/player-session',json={}).status_code==201
    assert b.post('/api/player-sessions/'+first+'/claim',json={'take_over':True}).status_code==404
    assert b.post('/api/videos/lecture/native-session',json={'player_session_id':first}).status_code==404
    conflict=a.post('/api/videos/lecture/player-session',json={'mode':'embedded'}).json()['detail']
    assert conflict['code']=='player_conflict' and conflict['player']['title']=='SQL joins'
    assert 'token' not in str(conflict) and 'auth_session' not in str(conflict)
    moved=a.post('/api/videos/lecture/player-session',json={'mode':'embedded','take_over':True}).json()['id']
    embed=a.post('/api/videos/lecture/playback-session',json={'player_session_id':moved}).json()
    assert a.get(embed['vault_url']).status_code==200
    assert native_player.stream_session_active(native['id']) is False
    assert a.get(native['media_url']).status_code==403
    assert a.post('/api/player-sessions/'+first+'/heartbeat',json={'sequence':1}).status_code==403
    with db.connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM learning_events WHERE user_id=? AND event_type='player_takeover'",(user['id'],)).fetchone()[0]==1


def test_visible_paused_ownership_release_expiry_and_reclaim(academy_env,monkeypatch):
    _,_,_,student,_=academy_env;c,_=student();clock=[1000.]
    monkeypatch.setattr(player_sessions.time,'time',lambda:clock[0])
    sid=c.post('/api/videos/lecture/player-session',json={}).json()['id']
    # Lease renewal has no playback credit and does not depend on playing.
    clock[0]=1020
    assert c.post('/api/player-sessions/'+sid+'/heartbeat',json={'sequence':1,'visible':True}).json()['active'] is True
    clock[0]=1040
    assert c.post('/api/videos/lecture/player-session',json={}).status_code==409
    released=c.post('/api/player-sessions/'+sid+'/heartbeat',json={'sequence':2,'visible':False}).json()
    assert released['released'] is True
    assert c.post('/api/player-sessions/'+sid+'/claim',json={}).status_code==200
    # Duplicate hidden heartbeats cannot revoke a subsequently reclaimed lease.
    assert c.post('/api/player-sessions/'+sid+'/heartbeat',json={'sequence':2,'visible':False}).json()['active'] is True
    clock[0]=1071
    assert c.post('/api/player-sessions/'+sid+'/heartbeat',json={'sequence':3}).json()['needs_claim'] is True
    assert c.post('/api/player-sessions/'+sid+'/claim',json={}).status_code==200
    assert c.post('/api/player-sessions/'+sid+'/heartbeat',json={'sequence':4,'closed':True}).json()['released'] is True
    assert c.post('/api/player-sessions/'+sid+'/claim',json={}).status_code==403


def test_player_ownership_requires_csrf_current_login_and_course_access(academy_env):
    _,_,admin,student,_=academy_env;c,user=student()
    guest=TestClient(main.app,base_url='https://testserver')
    assert guest.post('/api/videos/lecture/player-session',json={}).status_code==401
    assert c.post('/api/videos/lecture/player-session',json={},headers={'x-csrf-token':''}).status_code==403
    assert c.post('/api/videos/lecture/player-session',json={},headers={'origin':'https://elsewhere.test'}).status_code==403
    sid=c.post('/api/videos/lecture/player-session',json={}).json()['id']
    assert admin.put('/api/admin/users/'+user['id']+'/enrollments',json={'course':'SQL','enrolled':False}).status_code==200
    assert c.post('/api/player-sessions/'+sid+'/claim',json={}).status_code==403
    assert admin.put('/api/admin/users/'+user['id']+'/enrollments',json={'course':'SQL','enrolled':True}).status_code==200
    assert c.post('/api/auth/logout',json={}).status_code==200
    assert c.post('/api/player-sessions/'+sid+'/heartbeat',json={'sequence':1}).status_code==401
    with db.connect() as conn:assert not player_sessions.is_owner(conn,sid)


def test_player_preferences_are_private_validated_and_durable(academy_env):
    _,_,_,student,_=academy_env;a,_=student();b,_=student('preferences@courseforge.test')
    default={'speed':1,'autoplay':False,'theater':False}
    assert a.get('/api/me/player-preferences').json()==default
    body={'speed':2.5,'autoplay':True,'theater':True}
    assert a.put('/api/me/player-preferences',json=body).json()==body
    assert a.get('/api/me/player-preferences').json()==body
    assert b.get('/api/me/player-preferences').json()==default
    assert a.put('/api/me/player-preferences',json={'speed':3.5}).status_code==422
    assert a.put('/api/me/player-preferences',json=body,headers={'x-csrf-token':''}).status_code==403


def test_shared_activity_stops_counting_after_takeover_and_revocation(academy_env,monkeypatch):
    _,_,admin,student,_=academy_env;c,user=student();clock=[1000.]
    monkeypatch.setattr(player_sessions.time,'time',lambda:clock[0])
    first=c.post('/api/videos/lecture/player-session',json={}).json()['id']
    activity=c.post('/api/videos/lecture/activity-session',json={'player_session_id':first}).json()['id']
    clock[0]=1010
    assert c.post('/api/activity/'+activity+'/heartbeat',json={'sequence':1,'visible':True,'elapsed_seconds':10}).json()['activity_seconds']==10
    assert admin.get('/api/admin/player-activity?status=live').json()['total']==1
    second=c.post('/api/videos/lecture/player-session',json={'take_over':True}).json()['id']
    clock[0]=1020
    assert c.post('/api/activity/'+activity+'/heartbeat',json={'sequence':2,'visible':True,'elapsed_seconds':10}).json()['activity_seconds']==10
    assert admin.get('/api/admin/player-activity?status=live').json()['total']==0
    live=c.post('/api/videos/lecture/activity-session',json={'player_session_id':second}).json()['id']
    c.post('/api/activity/'+live+'/heartbeat',json={'sequence':1,'visible':True,'elapsed_seconds':0})
    assert admin.get('/api/admin/player-activity?status=live').json()['total']==1
    admin.put('/api/admin/users/'+user['id']+'/enrollments',json={'course':'SQL','enrolled':False})
    assert admin.get('/api/admin/player-activity?status=live').json()['total']==0


def test_reloading_native_or_switching_embed_invalidates_previous_media(academy_env,monkeypatch):
    _,_,_,student,_=academy_env;c,_=student()
    monkeypatch.setattr(native_player,'source_for',lambda _:('https://secure.odycdn.com/video','https://odysee.com/embed'))
    monkeypatch.setattr(media,'signed_embed',lambda _: 'https://odysee.com/embed?signature=redacted')
    psid=c.post('/api/videos/lecture/player-session',json={}).json()['id']
    first=c.post('/api/videos/lecture/native-session',json={'player_session_id':psid}).json()
    second=c.post('/api/videos/lecture/native-session',json={'player_session_id':psid}).json()
    assert native_player.stream_session_active(first['id']) is False
    assert native_player.stream_session_active(second['id']) is True
    assert c.get(first['media_url']).status_code==403
    assert c.post('/api/videos/lecture/playback-session',json={'player_session_id':psid}).status_code==200
    assert native_player.stream_session_active(second['id']) is False
