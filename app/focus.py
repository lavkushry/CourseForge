"""Local focus sessions and objectively *clock-measured* time (not verified attention).

The backend computes durations from its own UTC clock; the client never submits
elapsed seconds. Each run interval is persisted so pauses and midnight crossings
can be attributed accurately. Measured time does not confer topic mastery.
"""
from __future__ import annotations

import math
import sqlite3
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from .db import connect
from . import planner

class FocusInputError(ValueError):
    pass

class FocusNotFound(KeyError):
    pass

class FocusConflict(RuntimeError):
    pass


def clock() -> datetime:
    return datetime.now(timezone.utc)


def _now(at: datetime | None = None) -> datetime:
    value = at if at is not None else clock()
    if value.tzinfo is None:
        raise FocusInputError('Timestamps must be timezone aware')
    return value.astimezone(timezone.utc)


def _parse(raw: str) -> datetime:
    dt = datetime.fromisoformat(raw)
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)


def ensure_schema(path: Path | None = None) -> None:
    with connect(path) as db:
        db.executescript('''
        CREATE TABLE IF NOT EXISTS focus_sessions (
            id TEXT PRIMARY KEY,
            mode TEXT NOT NULL CHECK(mode IN ('focus','break')),
            status TEXT NOT NULL CHECK(status IN ('running','paused','finished','cancelled')),
            duration_seconds INTEGER NOT NULL CHECK(duration_seconds BETWEEN 60 AND 7200),
            planner_item_id TEXT REFERENCES daily_plan_items(id) ON DELETE SET NULL,
            video_id TEXT REFERENCES videos(id) ON DELETE SET NULL,
            lab_session_id TEXT REFERENCES lab_sessions(id) ON DELETE SET NULL,
            title TEXT NOT NULL,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS focus_intervals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL REFERENCES focus_sessions(id) ON DELETE CASCADE,
            began_at TEXT NOT NULL,
            ended_at TEXT
        );
        CREATE INDEX IF NOT EXISTS focus_interval_session_idx ON focus_intervals(session_id,id);
        CREATE UNIQUE INDEX IF NOT EXISTS focus_running_unique ON focus_sessions(status) WHERE status='running';
        ''')


def _row(db, sid: str):
    record = db.execute('SELECT * FROM focus_sessions WHERE id=?', (sid,)).fetchone()
    if record is None:
        raise FocusNotFound('Focus session not found')
    return record


def _intervals(db, sid: str):
    return db.execute('SELECT * FROM focus_intervals WHERE session_id=? ORDER BY id', (sid,)).fetchall()


def _seconds(db, row, now: datetime) -> float:
    value = sum(max(0.0, ((_parse(x['ended_at']) if x['ended_at'] else now) - _parse(x['began_at'])).total_seconds())
                for x in _intervals(db, row['id']))
    return min(row['duration_seconds'], value)


def _close(db, sid: str, now: datetime):
    db.execute('UPDATE focus_intervals SET ended_at=? WHERE session_id=? AND ended_at IS NULL', (now.isoformat(), sid))


def _reconcile(db, now: datetime):
    # Expire abandoned sessions at their bounded target time. This prevents
    # an overnight forgotten browser tab from accumulating unlimited hours.
    active = db.execute("SELECT * FROM focus_sessions WHERE status='running'").fetchone()
    if active and _seconds(db, active, now) >= active['duration_seconds']:
        # End at the point when configured duration was exhausted, not at now.
        running = db.execute('SELECT * FROM focus_intervals WHERE session_id=? AND ended_at IS NULL', (active['id'],)).fetchone()
        if running:
            historical = sum(max(0.0, (_parse(i['ended_at'])-_parse(i['began_at'])).total_seconds())
                             for i in _intervals(db, active['id']) if i['ended_at'])
            cutoff = _parse(running['began_at']) + timedelta(seconds=max(0, active['duration_seconds']-historical))
            _close(db, active['id'], cutoff)
        db.execute("UPDATE focus_sessions SET status='finished',updated_at=? WHERE id=?", (now.isoformat(), active['id']))


def _snapshot(db, row, now: datetime) -> dict:
    measured = _seconds(db, row, now)
    return {'id':row['id'], 'mode':row['mode'], 'status':row['status'],
            'title':row['title'], 'duration_seconds':row['duration_seconds'],
            'elapsed_seconds':round(measured, 2),
            'remaining_seconds':round(max(0, row['duration_seconds']-measured), 2),
            'planner_item_id':row['planner_item_id'], 'video_id':row['video_id'],
            'lab_session_id':row['lab_session_id'], 'created_at':row['created_at'],
            'updated_at':row['updated_at'], 'server_now':now.isoformat()}


def start(*, mode: str='focus', duration_minutes: int=25, planner_item_id: str | None=None,
          video_id: str | None=None, lab_session_id: str | None=None, title: str='',
          db_path: Path | None=None, at: datetime | None=None) -> dict:
    if mode not in ('focus','break') or type(duration_minutes) is not int or not 1 <= duration_minutes <= 120:
        raise FocusInputError('Choose focus or break and a duration of 1–120 whole minutes')
    if len(title) > 160:
        raise FocusInputError('Title must be at most 160 characters')
    if sum(bool(x) for x in (planner_item_id, video_id, lab_session_id)) > 1:
        raise FocusInputError('Link at most one planner item, video or lab session')
    now = _now(at)
    sid = uuid.uuid4().hex
    with connect(db_path) as db:
        _reconcile(db, now)
        if db.execute("SELECT 1 FROM focus_sessions WHERE status='running'").fetchone():
            raise FocusConflict('Pause or finish your running timer first')
        if planner_item_id:
            row = db.execute('SELECT title FROM daily_plan_items WHERE id=?',(planner_item_id,)).fetchone()
            if row is None: raise FocusNotFound('Planner item not found')
            title = title or row['title']
        if video_id:
            row = db.execute('SELECT title FROM videos WHERE id=?',(video_id,)).fetchone()
            if row is None: raise FocusNotFound('Video not found')
            title = title or row['title']
        if lab_session_id:
            row = db.execute('SELECT slug FROM lab_sessions WHERE id=?',(lab_session_id,)).fetchone()
            if row is None: raise FocusNotFound('Lab session not found')
            title = title or row['slug']
        try:
            db.execute('''INSERT INTO focus_sessions
                (id,mode,status,duration_seconds,planner_item_id,video_id,lab_session_id,title,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?)''',
                (sid,mode,'running',duration_minutes*60,planner_item_id,video_id,lab_session_id,
                 title.strip() or ('Rest break' if mode=='break' else 'Focused study'),now.isoformat(),now.isoformat()))
            db.execute('INSERT INTO focus_intervals(session_id,began_at) VALUES(?,?)',(sid,now.isoformat()))
        except sqlite3.IntegrityError as exc:
            raise FocusConflict('Another timer is running') from exc
        return _snapshot(db, _row(db,sid), now)


def transition(sid: str, action: str, db_path: Path | None=None, at: datetime | None=None) -> dict:
    if action not in ('pause','resume','finish','cancel'):
        raise FocusInputError('Choose pause, resume, finish or cancel')
    now = _now(at)
    with connect(db_path) as db:
        _reconcile(db,now)
        row = _row(db,sid)
        old=row['status']
        if old in ('finished','cancelled'):
            raise FocusConflict('This session is already closed')
        if action == 'pause' and old!='running': raise FocusConflict('Only running sessions can be paused')
        if action == 'resume' and old!='paused': raise FocusConflict('Only paused sessions can resume')
        if action == 'resume' and db.execute("SELECT 1 FROM focus_sessions WHERE status='running'").fetchone():
            raise FocusConflict('Another timer is running')
        if action != 'resume' and old=='running': _close(db,sid,now)
        new_status={'pause':'paused','resume':'running','finish':'finished','cancel':'cancelled'}[action]
        if action == 'resume':
            db.execute('INSERT INTO focus_intervals(session_id,began_at) VALUES(?,?)',(sid,now.isoformat()))
        db.execute('UPDATE focus_sessions SET status=?,updated_at=? WHERE id=?',(new_status,now.isoformat(),sid))
        return _snapshot(db,_row(db,sid),now)


def active(db_path: Path | None=None, at: datetime | None=None) -> dict:
    now=_now(at)
    with connect(db_path) as db:
        _reconcile(db,now)
        row=db.execute("SELECT * FROM focus_sessions WHERE status IN ('running','paused') ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END,created_at DESC LIMIT 1").fetchone()
        return {'session':_snapshot(db,row,now) if row else None}


def history(db_path: Path | None=None, *, limit: int=30, at: datetime | None=None) -> dict:
    now=_now(at)
    if type(limit) is not int or not 1 <= limit <= 200: raise FocusInputError('Limit must be 1–200')
    with connect(db_path) as db:
        _reconcile(db,now)
        rows=db.execute('SELECT * FROM focus_sessions ORDER BY created_at DESC LIMIT ?', (limit,)).fetchall()
        return {'sessions':[_snapshot(db,r,now) for r in rows]}


def analytics(week_start: str, tz_offset_minutes: int, db_path: Path | None=None,
              at: datetime | None=None) -> dict:
    start=planner._study_date(week_start)
    if start.weekday()!=0: raise FocusInputError('Week must start on Monday')
    if type(tz_offset_minutes) is not int or not -840 <= tz_offset_minutes <= 840:
        raise FocusInputError('Timezone offset must be between -840 and 840')
    now=_now(at)
    zone=timezone(timedelta(minutes=-tz_offset_minutes))
    days=[{'date':(start+timedelta(days=i)).isoformat(), 'measured_seconds':0.0,
           'self_reported_minutes':0, 'planned_minutes':0} for i in range(7)]
    with connect(db_path) as db:
        _reconcile(db,now)
        sessions=db.execute("SELECT * FROM focus_sessions WHERE mode='focus' AND status!='cancelled'").fetchall()
        for s in sessions:
            remaining=float(s['duration_seconds'])
            for x in _intervals(db,s['id']):
                left=_parse(x['began_at']).astimezone(zone)
                right=(_parse(x['ended_at']) if x['ended_at'] else now).astimezone(zone)
                duration=max(0.0,(right-left).total_seconds())
                right=left+timedelta(seconds=min(duration,remaining))
                remaining-=min(duration,remaining)
                while left<right:
                    next_day=datetime.combine(left.date()+timedelta(days=1),datetime.min.time(),zone)
                    finish=min(right,next_day)
                    i=(left.date()-start).days
                    if 0<=i<7: days[i]['measured_seconds']+=(finish-left).total_seconds()
                    left=finish
                if remaining<=0: break
        for i,day in enumerate(days):
            d=day['date']
            row=db.execute('''SELECT COALESCE(SUM(i.minutes),0) planned,
                       COALESCE(SUM(i.actual_minutes),0) actual
                       FROM daily_plan_items i WHERE study_date=?''',(d,)).fetchone()
            day['planned_minutes']=row['planned'] or 0
            day['self_reported_minutes']=row['actual'] or 0
            day['measured_seconds']=round(day['measured_seconds'],2)
            day['measured_minutes']=round(day['measured_seconds']/60,2)
            day['consistency']=day['measured_seconds']>=60
    return {'week_start':start.isoformat(),'days':days,
            'planned_minutes':sum(x['planned_minutes'] for x in days),
            'self_reported_minutes':sum(x['self_reported_minutes'] for x in days),
            'measured_minutes':round(sum(x['measured_seconds'] for x in days)/60,2),
            'active_days':sum(x['consistency'] for x in days),
            'disclaimer':'Measured time is active timer wall-clock time, not proof of attention. Self-reported time is separate and must not be added to measured time.'}
