"""Private daily habits, credited only by accepted learning actions."""
from datetime import datetime, timedelta, timezone, time
from typing import Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from . import auth
from .db import connect, utcnow

router = APIRouter()


def now():
    return datetime.now(timezone.utc)


def preferences(db, uid):
    row = db.execute('SELECT * FROM habit_preferences WHERE user_id=?', (uid,)).fetchone()
    return dict(row) if row else {'goal':'minutes','timezone':'UTC','reminder_email':0,'initialized':False}


def credit(db, uid, *, seconds=0, kind=None, resource=None, instant=None):
    """Called in the learning transaction. Duplicate events earn no extra credit."""
    if seconds<=0 and kind is None:return
    if not db.execute('SELECT 1 FROM users WHERE id=?', (uid,)).fetchone():return
    instant = instant or now()
    pref = preferences(db, uid)
    if pref.get('initialized') is False:
        db.execute('INSERT OR IGNORE INTO habit_preferences VALUES(?,?,?,?,?)', (uid,'minutes','UTC',0,utcnow()))
    zone = ZoneInfo(pref['timezone'])
    def add(day, watched=0, activity=None):
        if activity:
            result = db.execute('INSERT OR IGNORE INTO habit_actions VALUES(?,?,?,?)', (uid,activity,str(resource),day))
            if not result.rowcount:return
        db.execute('INSERT OR IGNORE INTO habit_days(user_id,day) VALUES(?,?)', (uid,day))
        column = {'lesson':'lessons','quiz':'quizzes','review':'reviews'}.get(activity)
        if column:db.execute(f'UPDATE habit_days SET {column}={column}+1 WHERE user_id=? AND day=?', (uid,day))
        if watched:db.execute('UPDATE habit_days SET watched_seconds=watched_seconds+? WHERE user_id=? AND day=?', (watched,uid,day))
        check_goal(db, uid, day, pref['goal'])
    if seconds>0:
        cursor = instant-timedelta(seconds=seconds)
        while cursor<instant:
            local = cursor.astimezone(zone)
            boundary = datetime.combine(local.date()+timedelta(days=1),time.min,zone).astimezone(timezone.utc)
            stop=min(instant,boundary)
            add(local.date().isoformat(), (stop-cursor).total_seconds())
            cursor=stop
    if kind in ('lesson','quiz','review'):
        add(instant.astimezone(zone).date().isoformat(), activity=kind)


def check_goal(db, uid, day, goal):
    rule = 'watched_seconds>=900' if goal=='minutes' else 'lessons+quizzes+reviews>=1'
    db.execute(f'UPDATE habit_days SET goal_met=1 WHERE user_id=? AND day=? AND ({rule})', (uid,day))


def summary(uid, instant=None):
    instant=instant or now()
    with connect() as db:
        pref=preferences(db,uid);today=instant.astimezone(ZoneInfo(pref['timezone'])).date()
        row=db.execute('SELECT * FROM habit_days WHERE user_id=? AND day=?', (uid,today.isoformat())).fetchone()
        day=dict(row) if row else {'watched_seconds':0,'lessons':0,'quizzes':0,'reviews':0,'goal_met':0}
        achieved={r[0] for r in db.execute('SELECT day FROM habit_days WHERE user_id=? AND goal_met=1', (uid,))}
        cursor=today if today.isoformat() in achieved else today-timedelta(days=1)
        streak=0
        while cursor.isoformat() in achieved:streak+=1;cursor-=timedelta(days=1)
        best=run=0;previous=None
        for value in sorted(achieved):
            date=datetime.fromisoformat(value).date()
            run=run+1 if previous==date-timedelta(days=1) else 1
            best=max(best,run);previous=date
        week=db.execute('''SELECT COALESCE(SUM(watched_seconds),0) watched_seconds,
            COALESCE(SUM(lessons),0) lessons,COALESCE(SUM(quizzes),0) quizzes,
            COALESCE(SUM(reviews),0) reviews,COUNT(*) active_days FROM habit_days
            WHERE user_id=? AND day BETWEEN ? AND ?''',(uid,(today-timedelta(days=6)).isoformat(),today.isoformat())).fetchone()
    return {'day':today.isoformat(),'today':day,'streak':streak,'best_streak':best,
            'preferences':pref,'week':dict(week),'email_available':auth.mail_configured()}


class HabitPreferences(BaseModel):
    goal: Literal['minutes','lesson']='minutes'
    timezone: str=Field(default='UTC',max_length=100)
    reminder_email: bool=False


@router.get('/api/me/habits')
def my_habits(request: Request):
    return summary(auth.require_user(request)['id'])


@router.put('/api/me/habit-preferences')
def save_preferences(body: HabitPreferences, request: Request):
    uid=auth.require_user(request)['id']
    try:ZoneInfo(body.timezone)
    except (ZoneInfoNotFoundError,ValueError):raise HTTPException(422,'Choose a valid learning-day timezone')
    with connect() as db:
        # The timezone is chosen once; device timezone changes cannot duplicate
        # days, delete achievements, or break an existing streak.
        db.execute('''INSERT INTO habit_preferences VALUES(?,?,?,?,?) ON CONFLICT(user_id)
            DO UPDATE SET goal=excluded.goal,reminder_email=excluded.reminder_email,updated_at=excluded.updated_at''',
            (uid,body.goal,body.timezone,int(body.reminder_email),utcnow()))
        pref=preferences(db,uid);day=now().astimezone(ZoneInfo(pref['timezone'])).date().isoformat()
        check_goal(db,uid,day,body.goal)
    return summary(uid)


def send_reminders():
    """Opt-in weekly mail, once per anchored week, only with working SMTP."""
    if not auth.mail_configured():return
    from email.message import EmailMessage
    import os
    with connect() as db:
        recipients=[dict(r) for r in db.execute('''SELECT u.id,u.email,u.name,p.timezone FROM users u
            JOIN habit_preferences p ON p.user_id=u.id WHERE p.reminder_email=1
            AND u.verified=1 AND u.suspended=0 AND u.role='student' ''')]
    for user in recipients:
        local=now().astimezone(ZoneInfo(user['timezone']))
        if local.weekday()!=6 or local.hour<18:continue
        week=(local.date()-timedelta(days=6)).isoformat()
        with connect() as db:
            claimed=db.execute('INSERT OR IGNORE INTO reminder_deliveries VALUES(?,?,?,?)', (user['id'],week,'reserved',utcnow())).rowcount
        if not claimed:continue
        recap=summary(user['id'])['week'];minutes=int(recap['watched_seconds']//60)
        message=EmailMessage();message['Subject']='Your week of learning on CourseForge'
        message['From']=os.environ['SMTP_FROM'];message['To']=user['email']
        message.set_content(f"Hi {user['name']},\n\nYou watched {minutes} minutes and finished {recap['lessons']} lessons this week.\nYour next lesson is ready whenever you are.\n\n{os.environ['PUBLIC_BASE_URL'].rstrip('/')}/#dashboard\n\nYou opted in to weekly reminders. Turn them off in Settings at any time.")
        try:auth.deliver_email(message);status='sent'
        except Exception:status='failed'
        with connect() as db:db.execute('UPDATE reminder_deliveries SET status=?,updated_at=? WHERE user_id=? AND week=?',(status,utcnow(),user['id'],week))
