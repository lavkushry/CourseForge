"""Account-bound streaming and meaningful playback/seek regression checks."""
import json
import pytest
from app import native_player as native,db,main,academy,auth
from test_academy import academy_env,PASSWORD


def authorize(monkeypatch):
    monkeypatch.setattr(native,'source_for',lambda _:('https://secure.odycdn.com/authorized.mp4','https://odysee.com/embed'))


def test_media_requires_account_login_and_enrollment(academy_env,monkeypatch):
    import httpx
    _,_,admin,student,_=academy_env;a,user=student();b,_=student('other-native@courseforge.test');authorize(monkeypatch)
    calls=[]
    def provider(request):
        calls.append(request)
        return httpx.Response(206,stream=httpx.ByteStream(b'video bytes'),headers={'content-type':'video/mp4','content-range':'bytes 0-10/100','accept-ranges':'bytes'})
    original=httpx.AsyncClient
    monkeypatch.setattr(native.httpx,'AsyncClient',lambda **kw:original(transport=httpx.MockTransport(provider),**kw))
    session=a.post('/api/videos/lecture/native-session',json={}).json();url=session['media_url']
    assert 'odycdn' not in json.dumps(session)
    assert b.get(url).status_code==403
    assert native.stream_session_active(session['id']) is True
    r=a.get(url,headers={'range':'bytes=0-10','user-agent':'Actual browser'})
    assert r.status_code==206 and r.content==b'video bytes'
    assert r.headers['content-range']=='bytes 0-10/100'
    assert calls[-1].headers['range']=='bytes=0-10' and calls[-1].headers['origin']=='https://odysee.com'
    assert 'cookie' not in calls[-1].headers
    assert a.get(url,headers={'range':'bytes=0-10,20-30'}).status_code==416
    assert a.head(url).status_code==206
    assert admin.put('/api/admin/users/'+user['id']+'/enrollments',json={'course':'SQL','enrolled':False}).status_code==200
    assert a.get(url).status_code==403
    assert native.stream_session_active(session['id']) is False
    assert a.post('/api/player/'+session['id']+'/events',json={'sequence':1,'event':'playing','position':0,'duration':120,'elapsed_seconds':0}).status_code==403


def test_proxy_rejects_non_provider_redirects(academy_env,monkeypatch):
    import httpx
    _,_,_,student,_=academy_env;c,_=student();authorize(monkeypatch)
    for bad in ['http://secure.odycdn.com/file','https://secure.odycdn.com.attacker.test/file','https://127.0.0.1/file','https://user@secure.odycdn.com/file','https://secure.odycdn.com:8000/file',None]:
        with pytest.raises(main.HTTPException):native.validate_source(bad)
    seen=[]
    def redirect(request):
        seen.append(request.url.host)
        return httpx.Response(302,headers={'location':'http://127.0.0.1/private'})
    original=httpx.AsyncClient
    monkeypatch.setattr(native.httpx,'AsyncClient',lambda **kw:original(transport=httpx.MockTransport(redirect),**kw))
    url=c.post('/api/videos/lecture/native-session',json={}).json()['media_url']
    assert c.get(url).status_code==503 and seen==['secure.odycdn.com']


def test_tracking_separates_pauses_seeks_duplicates_and_tabs(academy_env,monkeypatch):
    _,_,admin,student,_=academy_env;c,user=student();authorize(monkeypatch)
    clock=[1000.];monkeypatch.setattr(native.time,'time',lambda:clock[0])
    session=c.post('/api/videos/lecture/native-session',json={}).json();sid=session['id'];sequence=[0]
    def event(kind,pos,elapsed=0,at=None):
        if at is not None:clock[0]=at
        sequence[0]+=1
        r=c.post('/api/player/'+sid+'/events',json={'sequence':sequence[0],'event':kind,'position':pos,'duration':120,'elapsed_seconds':elapsed})
        assert r.status_code==200,r.text
        return r.json()
    event('playing',0)
    assert event('heartbeat',10,10,1010)['playing_seconds']==10
    duplicate=c.post('/api/player/'+sid+'/events',json={'sequence':2,'event':'heartbeat','position':10,'duration':120,'elapsed_seconds':10}).json()
    assert duplicate['accepted'] is False
    assert event('pause',15,5,1015)['playing_seconds']==15
    assert event('heartbeat',15,10,1025)['playing_seconds']==15
    event('playing',15)
    assert event('seeking',100,5,1030)['playing_seconds']==15
    event('seeked',100);event('playing',100)
    assert event('heartbeat',110,10,1040)['playing_seconds']==25
    assert c.post('/api/videos/lecture/native-session',json={}).status_code==409
    totals=c.get('/api/me/playback').json()['lessons'][0]
    assert totals['position']==110 and totals['coverage_percent']==20
    assert event('heartbeat',120,10,1050)['playing_seconds']==35
    event('closed',120,0,1051)
    assert event('heartbeat',120,10,1061)['accepted'] is False
    assert c.get(session['media_url']).status_code==403
    assert c.get('/api/admin/playback').status_code==403
    assert admin.get('/api/admin/playback').json()['total']==1
    assert admin.get('/api/admin/playback?course=Private').json()['total']==0
    assert admin.get('/api/admin/users/'+user['id']).json()['playback'][0]['playing_seconds']==35
    exported=admin.get('/api/admin/playback/export')
    assert exported.status_code==200 and 'Browser-reported playback seconds' in exported.text
    assert c.get('/api/admin/playback/export').status_code==403
    progress=c.get('/api/progress').json()['progress'][0]
    assert progress['position']==120 and progress['percent']==29 and progress['completed']==0
    with db.connect() as conn:conn.execute("UPDATE native_sessions SET created_at='2000-01-01'")
    academy.cleanup_records()
    assert admin.get('/api/admin/playback').json()['total']==0
    assert c.get('/api/me/playback').json()['lessons'][0]['playing_seconds']==35
    assert c.request('DELETE','/api/me',json={'password':PASSWORD}).status_code==200
    with db.connect() as conn:assert conn.execute('SELECT COUNT(*) FROM native_totals WHERE user_id=?',(user['id'],)).fetchone()[0]==0


def test_completion_requires_watched_content_at_the_end_and_can_be_undone(academy_env,monkeypatch):
    _,_,_,student,_=academy_env;c,user=student();authorize(monkeypatch)
    clock=[1000.];monkeypatch.setattr(native.time,'time',lambda:clock[0])
    sid=c.post('/api/videos/lecture/native-session',json={}).json()['id'];sequence=0
    def send(event,position,elapsed=0):
        nonlocal sequence
        sequence+=1;clock[0]+=elapsed
        response=c.post('/api/player/'+sid+'/events',json={'sequence':sequence,'event':event,
            'position':position,'duration':120,'elapsed_seconds':elapsed})
        assert response.status_code==200,response.text
        return response.json()
    send('playing',0);send('seeking',120);send('seeked',120)
    assert send('ended',120)['completed'] is False
    send('seeking',0);send('seeked',0);send('playing',0)
    for position in range(10,121,10):send('heartbeat',position,10)
    result=send('ended',120)
    assert result['completed'] is True and result['coverage_percent']==100
    assert c.get('/api/progress').json()['progress'][0]['completed']==1
    send('ended',120)
    with db.connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM learning_events WHERE user_id=? AND event_type='lesson_completed'",(user['id'],)).fetchone()[0]==1
    assert c.put('/api/videos/lecture/progress',json={'percent':0,'position':120}).status_code==200
    assert send('heartbeat',120)['completed'] is False


def test_role_changes_require_admin_password_and_revoke_access(academy_env):
    from fastapi.testclient import TestClient
    _,_,admin,student,_=academy_env;c,user=student()
    path='/api/admin/users/'+user['id']+'/role'
    assert c.put(path,json={'role':'admin','current_password':PASSWORD}).status_code==403
    assert admin.put(path,json={'role':'admin','current_password':'incorrect'}).status_code==403
    assert admin.put(path,json={'role':'admin','current_password':PASSWORD}).json()['changed'] is True
    assert c.get('/api/me').status_code==401
    fresh=TestClient(main.app,base_url='https://testserver')
    r=fresh.post('/api/auth/login',json={'email':user['email'],'password':PASSWORD});assert r.status_code==200
    fresh.headers['x-csrf-token']=r.json()['csrf_token'];assert fresh.get('/api/admin/overview').status_code==200
    assert admin.put(path,json={'role':'student','current_password':PASSWORD}).status_code==200
    assert fresh.get('/api/me').status_code==401
    r=fresh.post('/api/auth/login',json={'email':user['email'],'password':PASSWORD});assert r.status_code==200
    fresh.headers['x-csrf-token']=r.json()['csrf_token'];assert fresh.get('/api/admin/overview').status_code==403
    with db.connect() as conn:
        audit=conn.execute("SELECT * FROM admin_audit WHERE action='Account role changed'").fetchall()
        assert len(audit)==2 and PASSWORD not in str([dict(r) for r in audit])


def test_last_admin_and_pending_account_role_guard(academy_env):
    _,admin_user,admin,student,_=academy_env
    assert admin.put('/api/admin/users/'+admin_user['id']+'/role',json={'role':'student','current_password':PASSWORD}).status_code==409
    _,pending=student('pending-native@courseforge.test',verify=False,enroll=False)
    assert admin.put('/api/admin/users/'+pending['id']+'/role',json={'role':'admin','current_password':PASSWORD}).status_code==409
    path='/api/admin/users/'+admin_user['id']+'/role'
    assert admin.put(path,json={'role':'admin','current_password':PASSWORD}).json()['changed'] is False
    assert admin.get('/api/me').status_code==200


def test_cold_stream_is_prepared_before_range_delivery(monkeypatch):
    import httpx
    monkeypatch.setattr(native.media,'signed_embed',lambda _: 'https://odysee.com/embed?signature=test&signature_ts=1')
    native._SOURCES.clear();seen=[]
    def provider(request):
        seen.append((request.method,request.url.host))
        if request.method=='POST':
            return httpx.Response(200,json={'result':{'streaming_url':'https://secure.odycdn.com/cold.mp4'}})
        assert 'x-lbry-auth-token' not in request.headers
        assert request.method=='HEAD'
        return httpx.Response(200,headers={'content-type':'video/mp4'})
    original=httpx.Client
    monkeypatch.setattr(native.httpx,'Client',lambda **kw:original(transport=httpx.MockTransport(provider),**kw))
    info={'claim_name':'cold','claim_id':'c'*40}
    source,embed=native.source_for(info)
    assert source=='https://secure.odycdn.com/cold.mp4'
    assert seen==[('POST','api.na-backend.odysee.com'),('HEAD','secure.odycdn.com')]
    native.source_for(info);assert len(seen)==2
    native._SOURCES.clear()


def test_tab_takeover_does_not_credit_the_previous_tabs_interval(academy_env,monkeypatch):
    from app import player_sessions
    _,_,_,student,_=academy_env;c,_=student();authorize(monkeypatch)
    clock=[1000.];monkeypatch.setattr(native.time,'time',lambda:clock[0])
    first=c.post('/api/videos/lecture/native-session',json={}).json()
    def event(sid,seq,kind,pos,elapsed,at):
        clock[0]=at
        r=c.post('/api/player/'+sid+'/events',json={'sequence':seq,'event':kind,'position':pos,
            'duration':120,'elapsed_seconds':elapsed})
        assert r.status_code==200,r.text
        return r.json()
    event(first['id'],1,'playing',0,0,1000)
    assert event(first['id'],2,'heartbeat',10,10,1010)['playing_seconds']==10
    clock[0]=1015
    conflict=c.post('/api/videos/lecture/player-session',json={})
    assert conflict.status_code==409
    shared=c.post('/api/videos/lecture/player-session',json={'take_over':True}).json()['id']
    second=c.post('/api/videos/lecture/native-session',json={'player_session_id':shared}).json()['id']
    assert event(first['id'],3,'heartbeat',20,10,1016)['reason']=='ownership_lost'
    assert native.stream_session_active(first['id']) is False
    assert event(second,1,'playing',10,5,1021)['playing_seconds']==0
    assert event(second,2,'heartbeat',20,10,1031)['playing_seconds']==10
    assert c.get('/api/me/playback').json()['lessons'][0]['playing_seconds']==20
    duplicate=event(second,2,'heartbeat',20,10,1032)
    assert duplicate['accepted'] is False and duplicate['reason']=='duplicate'
    assert duplicate['position']==20 and duplicate['playing_seconds']==10
    # A disconnected player loses ownership. Reclaim resets its time baseline.
    assert event(second,3,'heartbeat',60,20,1071)['reason']=='ownership_lost'
    assert c.post('/api/player-sessions/'+shared+'/claim',json={}).status_code==200
    assert event(second,4,'heartbeat',60,20,1071)['playing_seconds']==10
    event(second,5,'playing',60,0,1071)
    assert event(second,6,'heartbeat',70,10,1081)['playing_seconds']==20


def test_live_playback_report_excludes_revoked_course_access(academy_env,monkeypatch):
    _,_,admin,student,_=academy_env;c,user=student();authorize(monkeypatch)
    sid=c.post('/api/videos/lecture/native-session',json={}).json()['id']
    assert c.post('/api/player/'+sid+'/events',json={'sequence':1,'event':'playing',
        'position':0,'duration':120,'elapsed_seconds':0}).status_code==200
    assert admin.get('/api/admin/playback?status=live').json()['total']==1
    assert admin.put('/api/admin/users/'+user['id']+'/enrollments',
        json={'course':'SQL','enrolled':False}).status_code==200
    assert admin.get('/api/admin/playback?status=live').json()['total']==0
    assert admin.get('/api/admin/playback').json()['total']==1


def test_heartbeat_recovers_a_lost_pause_event(academy_env,monkeypatch):
    _,_,admin,student,_=academy_env;c,_=student();authorize(monkeypatch)
    sid=c.post('/api/videos/lecture/native-session',json={}).json()['id']
    clock=[1000.];monkeypatch.setattr(native.time,'time',lambda:clock[0])
    def send(seq,event,pos,elapsed,playback_state=None):
        body={'sequence':seq,'event':event,'position':pos,'duration':120,'elapsed_seconds':elapsed}
        if playback_state:body['playback_state']=playback_state
        r=c.post('/api/player/'+sid+'/events',json=body);assert r.status_code==200,r.text
        return r.json()
    send(1,'playing',0,0)
    clock[0]=1010
    send(2,'heartbeat',10,10,'playing')
    assert admin.get('/api/admin/playback?status=live').json()['total']==1
    # The browser paused, but that transition request never reached the server.
    clock[0]=1020
    pause=send(3,'heartbeat',10,0,'pause')
    assert pause['playing_seconds']==10 and pause['tracking_active'] is False
    assert admin.get('/api/admin/playback?status=live').json()['total']==0
    # The next heartbeat also repairs a missing playing transition, without
    # crediting the unverified interval before its new baseline.
    clock[0]=1030
    resume=send(4,'heartbeat',15,5,'playing')
    assert resume['playing_seconds']==10 and resume['tracking_active'] is True
    clock[0]=1040
    assert send(5,'heartbeat',25,10,'playing')['playing_seconds']==20


def test_provider_authorization_recovers_a_sleeping_wallet_once(monkeypatch):
    import httpx
    from app import media
    seen=[]
    def rpc(request):
        method=json.loads(request.content)['method'];seen.append(method)
        if len(seen)==1:
            return httpx.Response(200,json={'error':{'code':-32500,'data':{'name':'ComponentsNotStartedError'},'message':'Wallet not started'}})
        if method=='status':return httpx.Response(200,json={'result':{'is_running':True}})
        return httpx.Response(200,json={'result':{'signature':'signed','signing_ts':'1'}})
    with httpx.Client(transport=httpx.MockTransport(rpc)) as client:
        assert media.sdk_call(client,'channel_sign',{})['signature']=='signed'
    assert seen==['channel_sign','status','channel_sign']
    seen.clear()
    def failed(request):
        seen.append(json.loads(request.content)['method'])
        return httpx.Response(200,json={'error':{'data':{'name':'ComponentsNotStartedError'},'message':'secret account data'}})
    with httpx.Client(transport=httpx.MockTransport(failed)) as client:
        with pytest.raises(main.HTTPException) as exc:media.sdk_call(client,'channel_sign',{})
    assert seen==['channel_sign','status','channel_sign'] and 'secret' not in str(exc.value.detail)
