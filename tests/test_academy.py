"""Real account/access flows, ownership, player tokens and admin visibility."""
from dataclasses import replace
from contextlib import contextmanager
import json
import sqlite3
import time
import pytest
from fastapi.testclient import TestClient
from app import main,db,auth,media,labs,study,planner,weekly,focus,learning_paths,assessments,academy_worker,academy
from app import migrations

PASSWORD='An actual long test password 124'


@pytest.fixture
def academy_env(tmp_path,monkeypatch):
    config=replace(db.settings,data_dir=tmp_path/'data',courses_dir=tmp_path/'courses')
    for mod in (main,db,media,labs,academy_worker):monkeypatch.setattr(mod,'settings',config)
    monkeypatch.setenv('PUBLIC_BASE_URL','https://testserver')
    monkeypatch.setenv('COOKIE_SECURE','1')
    monkeypatch.setenv('SMTP_HOST','localhost')
    monkeypatch.setenv('SMTP_FROM','accounts@courseforge.test')
    sent=[]
    monkeypatch.setattr(auth,'send_account_email',lambda email,token,kind:sent.append((email,token,kind)))
    db.init_db();admin=auth.bootstrap_admin('admin@courseforge.test','Owner',PASSWORD)
    config.courses_dir.mkdir();(config.courses_dir/'SQL').mkdir();(config.courses_dir/'Private').mkdir()
    (config.courses_dir/'SQL'/'notes.txt').write_text('Actual course resource')
    (config.courses_dir/'Private'/'private.txt').write_text('Private course resource')
    with db.connect() as conn:
        for vid,course in [('lecture','SQL'),('private','Private')]:
            conn.execute('INSERT INTO videos(id,path,course,title,bytes,mtime_ns,status,duration,created_at) VALUES(?,?,?,?,?,?,?,120,?)',
                (vid,str(config.courses_dir/course/'lecture.mp4'),course,'SQL joins' if course=='SQL' else 'Private lecture',0,1,'done',db.utcnow()))
        conn.execute('INSERT INTO course_publication VALUES(?,1,?,?)',('SQL','Relational queries',db.utcnow()))
        conn.execute('INSERT INTO lecture_providers VALUES(?,?,?,?)',('lecture','lecture-claim','a'*40,db.utcnow()))
        syllabus={'course':'SQL','source_fingerprint':'fp','topics':[{'title':'SQL joins','objectives':['Understand joins'],
            'sources':[{'video_id':'lecture','video_title':'SQL joins','start':25}]}]}
        conn.execute('INSERT INTO syllabi VALUES(?,?,?,?)',('SQL',json.dumps(syllabus),db.utcnow(),'fp'))
        conn.execute('INSERT INTO chunks VALUES(?,?,?,?,?,?,?)',('chunk','lecture','speech',25,90,'Inner joins match rows from both tables.',None))
    def login(email):
        c=TestClient(main.app,base_url='https://testserver')
        r=c.post('/api/auth/login',json={'email':email,'password':PASSWORD});assert r.status_code==200,r.text
        c.headers['x-csrf-token']=r.json()['csrf_token']
        return c,r.json()['user']
    def student(email='student@courseforge.test',verify=True,enroll=True):
        guest=TestClient(main.app,base_url='https://testserver')
        r=guest.post('/api/auth/register',json={'email':email,'name':email.split('@')[0],'password':PASSWORD});assert r.status_code==201,r.text
        if verify:
            token=next(t for e,t,k in reversed(sent) if e==email and k=='verify')
            assert guest.post('/api/auth/verify',json={'token':token}).status_code==200
        c,u=login(email)
        if enroll:assert c.post('/api/courses/SQL/enroll',json={}).status_code==201
        return c,u
    admin_client,_=login('admin@courseforge.test')
    return config,admin,admin_client,student,sent


def test_accounts_verification_reset_csrf_sessions(academy_env):
    _,_,admin,student,sent=academy_env
    c,user=student(verify=False,enroll=False)
    assert c.get('/api/videos').status_code==403
    assert c.post('/api/courses/SQL/enroll',json={}).status_code==403
    guest=TestClient(main.app,base_url='https://testserver')
    verify_token=sent[-1][1]
    assert guest.post('/api/auth/verify',json={'token':verify_token}).status_code==200
    assert guest.post('/api/auth/verify',json={'token':verify_token}).status_code==400
    assert c.post('/api/courses/SQL/enroll',json={},headers={'x-csrf-token':''}).status_code==403
    assert c.post('/api/courses/SQL/enroll',json={},headers={'origin':'https://evil.test'}).status_code==403
    assert c.post('/api/courses/SQL/enroll',json={}).status_code==201
    assert guest.post('/api/auth/forgot',json={'email':user['email']}).status_code==200
    reset=sent[-1][1]
    assert guest.post('/api/auth/reset',json={'token':reset,'password':PASSWORD+' new'}).status_code==200
    assert c.get('/api/me').status_code==401
    assert guest.post('/api/auth/reset',json={'token':reset,'password':PASSWORD+' new'}).status_code==400


def test_cookie_and_unauthenticated_boundary(academy_env):
    c=TestClient(main.app,base_url='https://testserver')
    r=c.post('/api/auth/login',json={'email':'admin@courseforge.test','password':PASSWORD})
    cookie=r.headers['set-cookie'].lower()
    assert 'httponly' in cookie and 'secure' in cookie and 'samesite=lax' in cookie
    c.cookies.clear()
    for url in ['/api/videos','/api/progress','/api/admin/overview','/api/admin/users','/api/jobs','/api/materials','/api/docs']:
        assert c.get(url).status_code==401,url
    assert c.get('/api/health').json()=={'status':'ok','version':'0.4.0'}
    assert len(c.get('/api/public/courses').json()['courses'])==1
    assert c.get('/api/public/courses/Private').status_code==404


def test_missing_mail_configuration_is_reported_without_creating_an_account(academy_env,monkeypatch):
    monkeypatch.delenv('SMTP_HOST')
    guest=TestClient(main.app,base_url='https://testserver')
    assert guest.post('/api/auth/register',json={'email':'unsent@courseforge.test','name':'Learner','password':PASSWORD}).status_code==503
    assert guest.post('/api/auth/forgot',json={'email':'unsent@courseforge.test'}).status_code==503
    with db.connect() as conn:
        assert not conn.execute('SELECT 1 FROM users WHERE email=?',('unsent@courseforge.test',)).fetchone()


def test_student_admin_and_course_boundaries(academy_env):
    _,_,admin,student,_=academy_env
    c,user=student(enroll=False)
    assert c.get('/api/videos').json()['videos']==[]
    assert c.get('/api/videos/lecture').status_code==403
    assert c.post('/api/scan').status_code==403
    assert c.get('/api/admin/overview').status_code==403
    assert c.post('/api/courses/SQL/enroll',json={}).status_code==201
    assert [v['id'] for v in c.get('/api/videos').json()['videos']]==['lecture']
    assert [p['video_id'] for p in c.get('/api/progress').json()['progress']]==['lecture']
    assert {m['course'] for m in c.get('/api/materials').json()['materials']}=={'SQL'}
    assert c.get('/api/materials/Private/private.txt').status_code==403
    assert c.get('/api/videos/private').status_code==403
    assert admin.put('/api/admin/users/'+user['id']+'/enrollments',json={'course':'SQL','enrolled':False}).status_code==200
    assert c.get('/api/videos/lecture').status_code==403


def test_progress_notes_bookmarks_are_independent(academy_env):
    _,_,admin,student,_=academy_env
    a,ua=student('alice@courseforge.test');b,ub=student('bob@courseforge.test')
    assert a.put('/api/videos/lecture/progress',json={'percent':100,'position':0}).status_code==200
    assert b.get('/api/progress').json()['progress'][0]['completed']==0
    note=a.post('/api/videos/lecture/notes',json={'content':'My private note','position':25}).json()
    assert b.get('/api/videos/lecture/notes').json()['notes']==[]
    assert b.delete('/api/notes/'+note['id']).status_code==404
    bookmark=a.post('/api/videos/lecture/bookmarks',json={'label':'Join example','position':25}).json()
    assert b.get('/api/videos/lecture/bookmarks').json()['bookmarks']==[]
    assert b.delete('/api/bookmarks/'+bookmark['id']).status_code==404
    report=admin.get('/api/admin/users/'+ua['id']).json()
    assert report['lessons'][0]['completed']==1 and report['note_count']==1
    assert len(report['enrollments'])==1
    assert admin.get('/api/admin/users/'+ub['id']).json()['lessons']==[]
    assert admin.get('/api/admin/overview').json()['summary']['students']==2


@contextmanager
def owner(uid):
    token=db.learner_id.set(uid)
    try:yield
    finally:db.learner_id.reset(token)


def test_every_learning_subsystem_is_owned(academy_env,monkeypatch):
    config,_,_,student,_=academy_env
    a,ua=student('alice@courseforge.test');b,ub=student('bob@courseforge.test')
    with owner(ua['id']):
        path=learning_paths.generate(['SQL'],'Understand joins',use_ai=False)
        card=study.add_cards('SQL',[{'video_id':'lecture','question':'What does an inner join return?', 'answer':'Matching rows','source_start':25}])[0]
        study.grade_card(card['id'],4)
        lab=labs.start_lab('python-log-analysis')
        planner.save_preferences(60,path['id']);day=planner.generate('2026-10-12')
        weekly.save_preferences([30]*7);week=weekly.build('2026-10-12',0)
        timer=focus.start(duration_minutes=10,video_id='lecture')
        with db.connect() as conn:
            conn.execute('INSERT INTO topic_assessments(user_id,id,path_id,step_id,source_fingerprint,content_json,created_at) VALUES(?,?,?,?,?,?,?)',
                (ua['id'],'assessment',path['id'],path['steps'][0]['id'],'fp',json.dumps({'id':'assessment','questions':[]}),db.utcnow()))
    with owner(ub['id']):
        assert learning_paths.list_paths()==[]
        with pytest.raises(learning_paths.PathNotFound):learning_paths.get_path(path['id'])
        assert study.due_cards()==[]
        with pytest.raises(KeyError):study.grade_card(card['id'],5)
        with pytest.raises(KeyError):labs.get_lab(lab['session_id'])
        assert planner.preferences()['daily_minutes']==45
        assert planner.get_day(day['study_date']) is None
        if day['items']:
            with pytest.raises(planner.PlannerNotFound):planner.set_item_status(day['items'][0]['id'],'done')
        assert weekly.preferences()['weekday_minutes']!=[30]*7
        assert weekly.get_week(week['week_start']) is None
        assert focus.active()['session'] is None
        with pytest.raises(focus.FocusNotFound):focus.transition(timer['id'],'pause')
        with pytest.raises(assessments.AssessmentNotFound):assessments.get('assessment')
        other=learning_paths.generate(['SQL'],'Understand joins',use_ai=False)
        assert other['id']!=path['id']
        # Both users may have an active timer and a plan on the same date.
        focus.start(duration_minutes=10,video_id='lecture');planner.generate('2026-10-12')
    assert b.get('/api/lab-sessions/'+lab['session_id']).status_code==404
    assert b.get('/api/assessments/assessment').status_code==404


def test_activity_is_bounded_idempotent_and_not_playback(academy_env,monkeypatch):
    _,_,admin,student,_=academy_env
    c,user=student();clock=[1000.0];monkeypatch.setattr(academy.time,'time',lambda:clock[0])
    a=c.post('/api/videos/lecture/activity-session',json={}).json()['id']
    second=c.post('/api/videos/lecture/activity-session',json={}).json()['id']
    clock[0]+=15
    hb={'sequence':1,'visible':True,'elapsed_seconds':15}
    r=c.post('/api/activity/'+a+'/heartbeat',json=hb).json()
    assert r['activity_seconds']==15 and r['basis']=='visible_lesson_activity'
    assert c.post('/api/activity/'+a+'/heartbeat',json=hb).json()['accepted'] is False
    assert c.post('/api/activity/'+second+'/heartbeat',json=hb).json()['activity_seconds']==0
    clock[0]+=15
    assert c.post('/api/activity/'+a+'/heartbeat',json={'sequence':2,'visible':False,'elapsed_seconds':15}).json()['activity_seconds']==15
    clock[0]+=60
    assert c.post('/api/activity/'+a+'/heartbeat',json={'sequence':3,'visible':True,'elapsed_seconds':20}).json()['activity_seconds']==15
    assert c.get('/api/progress').json()['progress'][0]['completed']==0
    capabilities=c.get('/api/videos/lecture/player-capabilities').json()
    assert capabilities['verified_playback_events'] is False
    assert admin.get('/api/admin/users/'+user['id']).json()['activity_seconds']==15
    assert c.post('/api/auth/logout',json={}).status_code==200
    assert admin.get('/api/admin/users/'+user['id']).json()['activity_seconds']==15


def test_playback_tokens_are_bound_and_single_use(academy_env,monkeypatch):
    _,_,_,student,_=academy_env
    a,ua=student('alice@courseforge.test');b,_=student('bob@courseforge.test')
    monkeypatch.setattr(media,'signed_embed',lambda _: 'https://odysee.com/$/embed/lecture/'+'a'*40+'?signature=authorized')
    session=a.post('/api/videos/lecture/playback-session',json={}).json()
    assert b.get(session['vault_url']).status_code==403
    frame=a.get(session['vault_url']);assert frame.status_code==200 and 'iframe' in frame.text
    assert a.get(session['vault_url']).status_code==403
    assert 'frame-ancestors' in frame.headers['content-security-policy']
    session=a.post('/api/videos/lecture/playback-session',json={'player_session_id':session['player_session_id']}).json()
    with db.connect() as conn:conn.execute("UPDATE playback_sessions SET expires_at='2000-01-01' WHERE user_id=?",(ua['id'],))
    assert a.get(session['vault_url']).status_code==403
    assert a.get('/api/videos/lecture/stream').status_code==409


def test_suspension_and_revocation_take_effect(academy_env):
    _,_,admin,student,_=academy_env
    c,user=student()
    assert admin.patch('/api/admin/users/'+user['id'],json={'suspended':True}).status_code==200
    assert c.get('/api/me').status_code==401
    assert c.post('/api/auth/login',json={'email':user['email'],'password':PASSWORD}).status_code==401
    assert admin.patch('/api/admin/users/'+user['id'],json={'suspended':False}).status_code==200
    result=c.post('/api/auth/login',json={'email':user['email'],'password':PASSWORD});c.headers['x-csrf-token']=result.json()['csrf_token']
    assert admin.delete('/api/admin/users/'+user['id']+'/sessions').status_code==200
    assert c.get('/api/me').status_code==401


def test_account_deletion_cleans_owned_records(academy_env):
    _,_,admin,student,_=academy_env
    c,user=student()
    c.post('/api/videos/lecture/notes',json={'content':'Delete this note','position':0})
    c.post('/api/videos/lecture/activity-session',json={})
    result=c.request('DELETE','/api/me',json={'password':PASSWORD})
    assert result.status_code==200,result.text
    with db.connect() as conn:
        assert conn.execute('SELECT 1 FROM users WHERE id=?',(user['id'],)).fetchone() is None
        for table in migrations.PERSONAL_TABLES:
            assert conn.execute(f'SELECT COUNT(*) FROM {table} WHERE user_id=?',(user['id'],)).fetchone()[0]==0
    assert admin.get('/api/admin/users/'+user['id']).status_code==404


def test_tasks_are_owned_bounded_and_persist_results(academy_env,monkeypatch):
    _,_,admin,student,_=academy_env
    a,_=student('alice@courseforge.test');b,_=student('bob@courseforge.test')
    monkeypatch.setattr(academy_worker.tutor,'ask',lambda **_: {'answer':'Indexed answer','sources':[]})
    result=a.post('/api/ask',json={'question':'Explain joins','video_id':'lecture'})
    assert result.status_code==202;tid=result.json()['task_id']
    assert b.get('/api/tasks/'+tid).status_code==404
    assert academy_worker.process_one()
    assert a.get('/api/tasks/'+tid).json()['result']['answer']=='Indexed answer'
    for _ in range(3):assert a.post('/api/ask',json={'question':'Explain joins','video_id':'lecture'}).status_code==202
    assert a.post('/api/ask',json={'question':'Explain joins','video_id':'lecture'}).status_code==429


def test_material_escape_is_rejected(academy_env,tmp_path):
    config,_,admin,student,_=academy_env
    external=tmp_path/'private.txt';external.write_text('Outside course root')
    (config.courses_dir/'SQL'/'escape.txt').symlink_to(external)
    c,_=student()
    assert c.get('/api/materials/SQL/escape.txt').status_code==404
    (config.courses_dir/'SQL'/'other-course.txt').symlink_to(config.courses_dir/'Private'/'private.txt')
    assert c.get('/api/materials/SQL/other-course.txt').status_code==404
    (config.courses_dir/'SQL'/'active.html').write_text('<script>alert(1)</script>')
    response=c.get('/api/materials/SQL/active.html')
    assert 'attachment' in response.headers['content-disposition']


def test_upgrade_preserves_pre_account_data(tmp_path,monkeypatch):
    p=tmp_path/'legacy.sqlite3'
    with monkeypatch.context() as m:
        m.setattr(migrations,'migrate',lambda *_:None);db.init_db(p)
    with db.connect(p) as conn:
        conn.execute("INSERT INTO videos(id,path,course,title,bytes,mtime_ns,created_at) VALUES('old','/old.mp4','SQL','Old lecture',1,1,?)",(db.utcnow(),))
        conn.execute("INSERT INTO video_progress VALUES('old',100,50,1,?)",(db.utcnow(),))
        conn.execute("INSERT INTO video_notes VALUES('note','old',25,'Keep this note',?)",(db.utcnow(),))
        conn.execute("INSERT INTO daily_plans VALUES('2026-10-12',NULL,45,0,?,?)",(db.utcnow(),db.utcnow()))
        conn.execute("INSERT INTO daily_plan_items(id,study_date,item_key,kind,title,description,minutes,action_json,status,updated_at) VALUES('old-item','2026-10-12','lesson:old','lesson','Old lesson','Keep this plan',15,'{}','pending',?)",(db.utcnow(),))
    migrations.migrate(p);migrations.migrate(p)
    user=auth.bootstrap_admin('owner@courseforge.test','Owner',PASSWORD,p)
    with db.connect(p) as conn:
        assert [r[0] for r in conn.execute('SELECT version FROM schema_migrations ORDER BY version')]==[1,2,3,4]
        assert conn.execute('SELECT user_id FROM video_notes').fetchone()[0]==user['id']
        assert conn.execute('SELECT percent,position FROM video_progress').fetchone()[:]==(100,50)
        assert conn.execute('SELECT user_id FROM daily_plan_items').fetchone()[0]==user['id']
        assert conn.execute('PRAGMA foreign_key_check').fetchall()==[]


def link_token(url):
    from urllib.parse import urlsplit,parse_qs
    return parse_qs(urlsplit(url).fragment.split('?',1)[1])['token'][0]


def test_admin_invitation_works_without_email_and_is_single_use(academy_env,monkeypatch):
    _,_,admin,_,_=academy_env
    monkeypatch.delenv('SMTP_HOST')
    guest=TestClient(main.app,base_url='https://testserver')
    assert guest.get('/api/public/account-options').json()['email_registration'] is False
    assert guest.post('/api/admin/invitations',json={'name':'Invited','email':'invited@courseforge.test'}).status_code==401
    r=admin.post('/api/admin/invitations',json={'name':'Invited learner','email':'invited@courseforge.test','course':'SQL'})
    assert r.status_code==201,r.text
    token=link_token(r.json()['activation_url']);uid=r.json()['user_id']
    with db.connect() as conn:
        row=conn.execute('SELECT * FROM users WHERE id=?',(uid,)).fetchone()
        assert not row['verified'] and row['role']=='student'
        assert conn.execute('SELECT token_hash FROM account_tokens WHERE user_id=?',(uid,)).fetchone()[0]==auth.digest(token)
    assert guest.post('/api/auth/activate',json={'token':token,'password':PASSWORD}).status_code==200
    assert guest.post('/api/auth/activate',json={'token':token,'password':PASSWORD}).status_code==400
    assert guest.post('/api/auth/login',json={'email':'invited@courseforge.test','password':PASSWORD}).status_code==200
    assert [v['id'] for v in guest.get('/api/videos').json()['videos']]==['lecture']
    audit=admin.get('/api/admin/system').json()['audit']
    assert any(e['action']=='Student invited' for e in audit)
    assert token not in json.dumps(audit) and PASSWORD not in json.dumps(audit)


def test_reissued_invitation_and_admin_recovery_revoke_old_links_and_sessions(academy_env,monkeypatch):
    _,_,admin,_,_=academy_env
    monkeypatch.delenv('SMTP_HOST')
    guest=TestClient(main.app,base_url='https://testserver')
    first=admin.post('/api/admin/invitations',json={'name':'Learner','email':'invite@courseforge.test'}).json()
    uid=first['user_id'];old=link_token(first['activation_url'])
    second=admin.post(f'/api/admin/users/{uid}/account-link',json={}).json()
    token=link_token(second['account_url'])
    assert guest.post('/api/auth/activate',json={'token':old,'password':PASSWORD}).status_code==400
    assert guest.post('/api/auth/activate',json={'token':token,'password':PASSWORD}).status_code==200
    guest.post('/api/auth/login',json={'email':'invite@courseforge.test','password':PASSWORD})
    recovery=admin.post(f'/api/admin/users/{uid}/account-link',json={}).json()
    other=TestClient(main.app,base_url='https://testserver')
    token=link_token(recovery['account_url'])
    assert other.post('/api/auth/reset',json={'token':token,'password':PASSWORD+' changed'}).status_code==200
    assert guest.get('/api/me').status_code==401
    assert other.post('/api/auth/reset',json={'token':token,'password':PASSWORD}).status_code==400
    pending=admin.post('/api/admin/invitations',json={'name':'Pending','email':'pending@courseforge.test'}).json()
    admin.patch('/api/admin/users/'+pending['user_id'],json={'suspended':True})
    assert other.post('/api/auth/activate',json={'token':link_token(pending['activation_url']),'password':PASSWORD}).status_code==400
    assert admin.post('/api/admin/users/'+pending['user_id']+'/account-link',json={}).status_code==409


def test_invitation_expiry_and_bad_configuration_do_not_activate(academy_env,monkeypatch):
    _,_,admin,_,_=academy_env
    first=admin.post('/api/admin/invitations',json={'name':'Learner','email':'invite@courseforge.test'}).json()
    with db.connect() as conn:conn.execute("UPDATE account_tokens SET expires_at='2000-01-01'")
    guest=TestClient(main.app,base_url='https://testserver')
    assert guest.post('/api/auth/activate',json={'token':link_token(first['activation_url']),'password':PASSWORD}).status_code==400
    monkeypatch.delenv('PUBLIC_BASE_URL')
    assert admin.post('/api/admin/invitations',json={'name':'No URL','email':'no-url@courseforge.test'}).status_code==503
    with db.connect() as conn:assert not conn.execute("SELECT 1 FROM users WHERE email='no-url@courseforge.test'").fetchone()


def test_manual_resume_preserves_completion_and_is_private(academy_env,monkeypatch):
    _,_,admin,student,_=academy_env
    a,_=student('alice@courseforge.test');b,_=student('bob@courseforge.test')
    a.put('/api/videos/lecture/progress',json={'percent':100,'position':10})
    assert a.put('/api/videos/lecture/resume-point',json={'position':35}).status_code==200
    progress=a.get('/api/progress').json()['progress'][0]
    assert progress['position']==35 and progress['completed']==1
    assert b.get('/api/progress').json()['progress'][0]['position']==0
    assert b.put('/api/videos/private/resume-point',json={'position':35}).status_code==403
    assert a.put('/api/videos/lecture/resume-point',json={'position':121}).status_code==422
    monkeypatch.setattr(media,'signed_embed',lambda _: 'https://odysee.com/$/embed/lecture/'+'a'*40+'?signature=authorized')
    player=a.post('/api/videos/lecture/playback-session',json={'start_pos':35}).json()
    assert player['capabilities']['timestamp_launch'] is True
    frame=a.get(player['vault_url'])
    assert '&amp;t=35.0' in frame.text
    assert 'start=' in player['vault_url']


def test_player_reports_close_sessions_safely_and_preserve_lifetime_totals(academy_env,monkeypatch):
    _,_,admin,student,_=academy_env
    c,user=student();clock=[time.time()];monkeypatch.setattr(academy.time,'time',lambda:clock[0])
    sid=c.post('/api/videos/lecture/activity-session',json={},headers={'user-agent':'Actual browser'}).json()['id']
    clock[0]+=15
    c.post('/api/activity/'+sid+'/heartbeat',json={'sequence':1,'visible':True,'elapsed_seconds':15})
    live=admin.get('/api/admin/player-activity?status=live').json()
    assert live['total']==1 and live['sessions'][0]['device']=='Actual browser'
    assert c.get('/api/admin/player-activity').status_code==403
    assert admin.get('/api/admin/player-activity?q=%25').json()['total']==0
    clock[0]+=8
    ended={'sequence':2,'visible':True,'elapsed_seconds':8,'ended':True}
    assert c.post('/api/activity/'+sid+'/heartbeat',json=ended).json()['activity_seconds']==23
    clock[0]+=15
    assert c.post('/api/activity/'+sid+'/heartbeat',json={'sequence':3,'visible':True,'elapsed_seconds':15}).json()['accepted'] is False
    assert admin.get('/api/admin/player-activity?status=live').json()['total']==0
    report=admin.get('/api/admin/player-activity?course=SQL').json()
    assert report['summary']['activity_seconds']==23
    assert c.get('/api/progress').json()['progress'][0]['completed']==0
    c.patch('/api/me',json={'name':'=dangerous spreadsheet formula'})
    exported=admin.get('/api/admin/player-activity/export')
    assert exported.status_code==200 and 'attachment' in exported.headers['content-disposition']
    assert "'=dangerous spreadsheet formula" in exported.text
    assert c.get('/api/admin/player-activity/export').status_code==403
    with db.connect() as conn:conn.execute("UPDATE activity_sessions SET created_at='2000-01-01'")
    academy.cleanup_records()
    assert admin.get('/api/admin/player-activity').json()['total']==0
    assert admin.get('/api/admin/users/'+user['id']).json()['activity_seconds']==23
    assert c.get('/api/me/learning').json()['activity_seconds']==23
    assert c.request('DELETE','/api/me',json={'password':PASSWORD}).status_code==200
    with db.connect() as conn:assert conn.execute('SELECT COUNT(*) FROM lesson_activity_totals').fetchone()[0]==0


def test_console_upgrade_preserves_existing_session_totals_and_device(tmp_path,monkeypatch):
    path=tmp_path/'v1.sqlite3'
    with monkeypatch.context() as m:
        m.setattr(migrations,'migrate_console',lambda *_:None)
        m.setattr(migrations,'migrate_player_ownership',lambda *_:None)
        db.init_db(path)
    user=auth.bootstrap_admin('owner@courseforge.test','Owner',PASSWORD,path)
    with db.connect(path) as conn:
        conn.execute("INSERT INTO videos(id,path,course,title,bytes,mtime_ns,created_at) VALUES('v','/v.mp4','SQL','SQL',1,1,?)",(db.utcnow(),))
        conn.execute('INSERT INTO auth_sessions VALUES(?,?,?,?,?,?,?,?,?)',('s',user['id'],'hash','csrf',db.utcnow(),auth.expiry(1),db.utcnow(),'Browser','127.0.0.1'))
        conn.execute('INSERT INTO activity_sessions VALUES(?,?,?,?,?,?,?,?)',('a',user['id'],'s','v',1,time.time(),17,db.utcnow()))
    migrations.migrate(path);migrations.migrate(path)
    with db.connect(path) as conn:
        assert conn.execute('SELECT activity_seconds FROM lesson_activity_totals').fetchone()[0]==17
        assert conn.execute('SELECT device FROM activity_sessions').fetchone()[0]=='Browser'
        conn.execute('DELETE FROM auth_sessions')
        assert conn.execute('SELECT activity_seconds FROM lesson_activity_totals').fetchone()[0]==17
        assert conn.execute('PRAGMA foreign_key_check').fetchone() is None


def test_provider_sync_imports_real_duration_and_reports_failures(academy_env,monkeypatch):
    _,_,admin,_,_=academy_env
    from types import SimpleNamespace
    monkeypatch.setenv('ODYSEE_AUTH_TOKEN','test-only-provider-token')
    payload={'result':{'items':[{'claim_id':'b'*40,'name':'updated-lecture','value':{'title':'SQL joins','video':{'duration':155}}}]}}
    class Client:
        def __init__(self,**_):pass
        def __enter__(self):return self
        def __exit__(self,*_):pass
        def post(self,*_,**__):return SimpleNamespace(raise_for_status=lambda:None,json=lambda:payload)
    monkeypatch.setattr(media.httpx,'Client',Client)
    with db.connect() as conn:conn.execute('UPDATE videos SET duration=NULL WHERE id=?',('lecture',))
    result=media.sync_provider_mappings()
    assert result['durations_added']==1
    assert admin.get('/api/videos/lecture').json()['video']['duration']==155
    payload.clear();payload['error']={'message':'Provider rejected refresh'}
    result=media.sync_provider_mappings()
    assert result['mapped']==1 and result['error']
    system=admin.get('/api/admin/system').json()
    assert system['service_checks']['odysee_sync']['last_error']
    assert 'test-only-provider-token' not in json.dumps(system)
