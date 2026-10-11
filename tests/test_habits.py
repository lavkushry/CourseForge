from datetime import datetime, timezone
from app import db, habits, engagement, auth
from tests.test_academy import academy_env


def pref(client, **changes):
    response=client.put('/api/me/habit-preferences',json={'goal':'lesson','timezone':'Asia/Kolkata',**changes})
    assert response.status_code==200,response.text
    return response.json()


def test_completion_credits_once_and_habits_are_private(academy_env):
    _,_,_,student,_=academy_env
    a,user=student();b,_=student('other-habit@courseforge.test')
    pref(a)
    for percent in [100,100,0,100]:
        assert a.put('/api/videos/lecture/progress',json={'percent':percent,'position':120}).status_code==200
    data=a.get('/api/me/habits').json()
    assert data['today']['lessons']==1 and data['today']['goal_met']==1 and data['streak']==1
    assert b.get('/api/me/habits').json()['streak']==0
    assert b.get('/api/me/habits').json()['today']['lessons']==0
    assert a.put('/api/me/habit-preferences',json={'goal':'lesson'},headers={'x-csrf-token':''}).status_code==403


def test_timezone_travel_does_not_reset_or_duplicate_days(academy_env,monkeypatch):
    _,_,_,student,_=academy_env;c,user=student()
    instant=datetime(2026,10,10,18,30,10,tzinfo=timezone.utc)
    monkeypatch.setattr(habits,'now',lambda:instant)
    pref(c,goal='minutes')
    with db.connect() as conn:habits.credit(conn,user['id'],seconds=20,instant=instant)
    with db.connect() as conn:
        rows=conn.execute('SELECT day,watched_seconds FROM habit_days WHERE user_id=? ORDER BY day',(user['id'],)).fetchall()
        assert [(r[0],r[1]) for r in rows]==[('2026-10-10',10),('2026-10-11',10)]
        habits.credit(conn,user['id'],seconds=890,instant=datetime(2026,10,10,12,tzinfo=timezone.utc))
        habits.credit(conn,user['id'],seconds=900,instant=datetime(2026,10,10,20,tzinfo=timezone.utc))
    result=pref(c,goal='minutes',timezone='America/New_York')
    assert result['preferences']['timezone']=='Asia/Kolkata'
    assert result['streak']==2 and result['best_streak']==2
    assert result['week']['watched_seconds']==1810
    monkeypatch.setattr(habits,'now',lambda:datetime(2026,10,13,12,tzinfo=timezone.utc))
    assert c.get('/api/me/habits').json()['streak']==0
    assert c.get('/api/me/habits').json()['best_streak']==2
    assert c.get('/api/me/habits').json()['week']['watched_seconds']==1810


def test_invalid_zone_and_existing_autoplay_opt_out(academy_env):
    _,_,_,student,_=academy_env;c,_=student()
    assert c.put('/api/me/habit-preferences',json={'timezone':'Not/A/Zone'}).status_code==422
    assert c.get('/api/me/player-preferences').json()['autoplay'] is True
    assert c.put('/api/me/player-preferences',json={'autoplay':False}).status_code==200
    assert c.get('/api/me/player-preferences').json()['autoplay'] is False


def test_opt_in_can_be_saved_before_email_and_delivery_is_once(academy_env,monkeypatch):
    _,_,admin,student,_=academy_env;c,user=student();b,other=student('suspended-habit@courseforge.test')
    instant=datetime(2026,10,11,19,tzinfo=timezone.utc)
    monkeypatch.setattr(habits,'now',lambda:instant)
    monkeypatch.setattr(auth,'mail_configured',lambda:False)
    data=pref(c,timezone='UTC',reminder_email=True)
    assert data['preferences']['reminder_email']==1 and data['email_available'] is False
    sent=[];monkeypatch.setattr(auth,'deliver_email',sent.append)
    habits.send_reminders();assert not sent
    monkeypatch.setattr(auth,'mail_configured',lambda:True)
    pref(b,timezone='UTC',reminder_email=True)
    assert admin.patch('/api/admin/users/'+other['id'],json={'suspended':True}).status_code==200
    habits.send_reminders();habits.send_reminders()
    assert len(sent)==1 and sent[0]['To']==user['email']
    assert 'Turn them off in Settings' in sent[0].get_content()


def test_admin_engagement_uses_real_denominators_and_excludes_admins(academy_env,monkeypatch):
    _,admin_user,admin,student,_=academy_env;c,user=student();other,second=student('new-habit@courseforge.test')
    instant=datetime(2026,10,10,12,tzinfo=timezone.utc)
    monkeypatch.setattr(engagement,'now',lambda:instant)
    with db.connect() as conn:
        for uid,day in [(user['id'],'2026-10-03'),(user['id'],'2026-10-10'),(second['id'],'2026-10-10'),(admin_user['id'],'2026-10-10')]:
            conn.execute('INSERT INTO learning_events(user_id,event_type,created_at) VALUES(?,?,?)',(uid,'note_saved',day+'T12:00:00+00:00'))
    report=admin.get('/api/admin/overview').json()['engagement']
    assert report['daily_active_students']==2
    assert report['return_cohort']==1 and report['returning_students']==1
    assert report['seven_day_return_rate']==100
    assert report['sessions']==0 and report['average_session_minutes']==0
    assert c.get('/api/admin/overview').status_code==403
