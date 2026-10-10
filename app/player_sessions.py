"""One visible player per account, shared by native and embedded playback."""
import secrets
import time
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from . import auth
from .db import connect, fetch_video, utcnow

router = APIRouter()
LEASE_SECONDS = 30


class OpenPlayer(BaseModel):
    mode: Literal['native', 'embedded'] = 'native'
    take_over: bool = False


class Claim(BaseModel):
    take_over: bool = False


class Heartbeat(BaseModel):
    sequence: int = Field(ge=1, le=10**9)
    visible: bool = True
    closed: bool = False


def owned(db, sid, user):
    row = db.execute('''SELECT p.*,v.course FROM player_sessions p JOIN videos v ON v.id=p.video_id
        WHERE p.id=? AND p.user_id=? AND p.auth_session_id=?''',
        (sid, user['id'], user['session_id'])).fetchone()
    if not row:
        raise HTTPException(404, 'Player session not found')
    auth.require_course(user, row['course'])
    if row['closed'] or row['expires_at'] <= utcnow():
        raise HTTPException(403, 'This player session has ended. Reopen the lesson.')
    return row


def is_owner(db, sid):
    return bool(db.execute('''SELECT 1 FROM player_ownership o JOIN player_sessions p ON p.id=o.session_id
        JOIN auth_sessions a ON a.id=p.auth_session_id JOIN users u ON u.id=p.user_id
        JOIN videos v ON v.id=p.video_id WHERE p.id=? AND o.expires_at>? AND p.closed=0
        AND p.expires_at>? AND a.expires_at>? AND u.verified=1 AND u.suspended=0
        AND (u.role='admin' OR EXISTS (SELECT 1 FROM enrollments e JOIN course_publication c ON c.course=e.course
        WHERE e.user_id=p.user_id AND e.course=v.course AND c.published=1))''',
        (sid, time.time(), utcnow(), utcnow())).fetchone())


def claim(db, row, user, take_over=False):
    old = db.execute('''SELECT p.id,p.video_id,v.title,p.mode FROM player_ownership o
        JOIN player_sessions p ON p.id=o.session_id JOIN videos v ON v.id=p.video_id
        WHERE o.user_id=?''', (user['id'],)).fetchone()
    if old and old['id'] != row['id'] and is_owner(db, old['id']):
        if not take_over:
            raise HTTPException(409, {'code': 'player_conflict', 'message': 'Your account has a player open in another window.',
                'player': {'title': old['title'], 'mode': old['mode']}})
        db.execute('UPDATE player_sessions SET closed=1 WHERE id=?', (old['id'],))
        db.execute("UPDATE native_sessions SET closed=1,state='closed' WHERE player_session_id=?", (old['id'],))
        db.execute('DELETE FROM native_leases WHERE user_id=?',(user['id'],))
        db.execute('DELETE FROM activity_leases WHERE user_id=?',(user['id'],))
        db.execute('UPDATE activity_sessions SET closed=1 WHERE player_session_id=?',(old['id'],))
        db.execute('''INSERT INTO learning_events(user_id,video_id,event_type,details,created_at)
            VALUES(?,?,?,?,?)''', (user['id'], row['video_id'], 'player_takeover', 'Confirmed account player transfer', utcnow()))
    # Reclaiming an expired/hidden lease always establishes a fresh baseline.
    if not is_owner(db, row['id']):
        db.execute("UPDATE native_sessions SET state='pause',last_heartbeat=? WHERE player_session_id=? AND closed=0",
            (time.time(), row['id']))
    db.execute('''INSERT INTO player_ownership VALUES(?,?,?) ON CONFLICT(user_id)
        DO UPDATE SET session_id=excluded.session_id,expires_at=excluded.expires_at''',
        (user['id'], row['id'], time.time()+LEASE_SECONDS))


def create(video_id, mode, request, take_over=False):
    user = auth.require_user(request)
    video = fetch_video(video_id)
    if not video:
        raise HTTPException(404, 'Video not found')
    auth.require_course(user, video['course'])
    sid = 'ps_'+secrets.token_hex(16)
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        db.execute('''INSERT INTO player_sessions(id,user_id,auth_session_id,video_id,mode,expires_at,created_at)
            VALUES(?,?,?,?,?,?,?)''', (sid,user['id'],user['session_id'],video_id,mode,auth.expiry(6),utcnow()))
        claim(db, owned(db,sid,user),user,take_over)
    return sid


def binding(video_id, mode, sid, request):
    if not sid:
        return create(video_id, mode, request)
    user = auth.require_user(request)
    with connect() as db:
        row = owned(db,sid,user)
        if row['video_id'] != video_id or not is_owner(db,sid):
            raise HTTPException(409, 'This window no longer owns playback. Reopen the lesson.')
        db.execute('UPDATE player_sessions SET mode=? WHERE id=?',(mode,sid))
    return sid


@router.post('/api/videos/{video_id}/player-session', status_code=201)
def open_player(video_id: str, body: OpenPlayer, request: Request):
    auth.rate_limit('player-open:'+auth.require_user(request)['id'],60,60)
    return {'id':create(video_id,body.mode,request,body.take_over), 'lease_seconds':LEASE_SECONDS}


@router.post('/api/player-sessions/{sid}/claim')
def claim_player(sid: str, body: Claim, request: Request):
    user = auth.require_user(request)
    auth.rate_limit('player-claim:'+user['id'],60,60)
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        claim(db, owned(db,sid,user),user,body.take_over)
    return {'active':True,'lease_seconds':LEASE_SECONDS}


@router.post('/api/player-sessions/{sid}/heartbeat')
def heartbeat(sid: str, body: Heartbeat, request: Request):
    user = auth.require_user(request)
    auth.rate_limit('player-lease:'+user['id'],180,60)
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        row = owned(db,sid,user)
        active = is_owner(db,sid)
        if body.sequence <= row['last_sequence']:
            return {'active':active,'duplicate':True}
        db.execute('UPDATE player_sessions SET last_sequence=? WHERE id=?',(body.sequence,sid))
        if body.closed or not body.visible:
            db.execute('DELETE FROM player_ownership WHERE user_id=? AND session_id=?',(user['id'],sid))
            db.execute("UPDATE native_sessions SET state='hidden' WHERE player_session_id=? AND closed=0",(sid,))
            if body.closed:
                db.execute('UPDATE player_sessions SET closed=1 WHERE id=?',(sid,))
                db.execute("UPDATE native_sessions SET closed=1,state='closed' WHERE player_session_id=?",(sid,))
            return {'active':False,'released':True}
        if active:
            db.execute('UPDATE player_ownership SET expires_at=? WHERE session_id=?',(time.time()+LEASE_SECONDS,sid))
        return {'active':active,'needs_claim':not active}


class Preferences(BaseModel):
    speed: float = Field(default=1,ge=.5,le=3,allow_inf_nan=False)
    autoplay: bool = False
    theater: bool = False


@router.get('/api/me/player-preferences')
def get_preferences(request: Request):
    user = auth.require_user(request)
    with connect() as db:
        row = db.execute('SELECT speed,autoplay,theater FROM player_preferences WHERE user_id=?',(user['id'],)).fetchone()
    return {'speed':row['speed'],'autoplay':bool(row['autoplay']),'theater':bool(row['theater'])} if row else Preferences().model_dump()


@router.put('/api/me/player-preferences')
def save_preferences(body: Preferences, request: Request):
    user = auth.require_user(request)
    with connect() as db:
        db.execute('''INSERT INTO player_preferences VALUES(?,?,?,?,?) ON CONFLICT(user_id)
            DO UPDATE SET speed=excluded.speed,autoplay=excluded.autoplay,theater=excluded.theater,updated_at=excluded.updated_at''',
            (user['id'],body.speed,int(body.autoplay),int(body.theater),utcnow()))
    return body.model_dump()
