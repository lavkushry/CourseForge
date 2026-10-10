"""Administrator account provisioning, operational checks, and session reporting."""
import csv
from datetime import datetime, timedelta, timezone
import io
import json
import os
import secrets
import time
from typing import Literal
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field

from . import auth, course_metadata
from .db import connect, utcnow
from .media import sync_provider_mappings
from .native_player import CAPABILITIES

router = APIRouter()


def audit(actor: str, action: str, resource: str):
    with connect() as db:
        db.execute('INSERT INTO admin_audit(actor_id,action,resource,created_at) VALUES(?,?,?,?)',
                   (actor, action[:100], resource[:300], utcnow()))


def audit_change(actor: str, method: str, path: str, body: dict):
    """Describe the action without persisting request bodies or credentials."""
    if path.endswith('/role'):return
    action=method+' '+path
    yes=lambda key:str(body.get(key,'')).casefold() in ('true','1','on','yes','y','t')
    if path=='/api/admin/invitations':action='Student invited'
    elif path.endswith('/account-link'):action='Account link issued'
    elif path=='/api/admin/users':action='Student account created'
    elif path.endswith('/enrollments'):action='Course access granted' if yes('enrolled') else 'Course access revoked'
    elif path.endswith('/publication'):action='Course published' if yes('published') else 'Course unpublished'
    elif path.endswith('/provider'):action='Lecture mapping updated'
    elif path=='/api/admin/provider-sync':action='Provider mappings refreshed'
    elif path.startswith('/api/admin/users/') and method=='PATCH':action='Account suspended' if yes('suspended') else 'Account restored'
    elif path.endswith('/sessions'):action='Account sessions revoked'
    elif path.endswith('/cover'):action='Course cover restored' if method=='DELETE' else 'Course cover updated'
    elif path.startswith('/api/courses/'):action='Course metadata updated'
    elif path=='/api/scan':action='Library scanned'
    elif path.endswith('/reindex'):action='Lecture indexing queued'
    audit(actor,action,path)


def service_check(name: str, summary: dict, error: str = ''):
    now = utcnow()
    with connect() as db:
        db.execute('''INSERT INTO service_checks VALUES(?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET
            last_attempt=excluded.last_attempt,last_success=COALESCE(excluded.last_success,service_checks.last_success),
            summary_json=excluded.summary_json,last_error=excluded.last_error''',
                   (name, now, None if error else now, json.dumps(summary), error))


def account_link(token: str, action: str) -> str:
    base = os.getenv('PUBLIC_BASE_URL', '').rstrip('/')
    url = urlsplit(base)
    if url.scheme != 'https' or not url.hostname or url.username or url.password or url.query or url.fragment:
        raise HTTPException(503, 'Set PUBLIC_BASE_URL to your HTTPS site before issuing account links')
    # Fragments are never included in HTTP requests or referrer headers.
    return f'{base}/#{action}?token={token}'


class InviteBody(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    email: str = Field(max_length=254)
    course: str | None = Field(default=None, max_length=200)


@router.post('/api/admin/invitations', status_code=201)
def invite_student(body: InviteBody, request: Request):
    admin = auth.require_admin(request)
    auth.rate_limit('admin-invite:'+admin['id'], 60, 3600)
    email = auth.normalize_email(body.email)
    name = body.name.strip()
    if not name:
        raise HTTPException(422, 'Enter a name')
    if body.course:
        try:
            course_metadata.get_course(body.course)
        except course_metadata.UnknownCourse:
            raise HTTPException(404, 'Course not found')
    # Validate configuration before committing any account.
    account_link('configuration-check', 'activate')
    uid = 'usr_'+secrets.token_hex(16)
    encoded = auth.hasher.hash(secrets.token_urlsafe(48))
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        if db.execute('SELECT 1 FROM users WHERE email=?', (email,)).fetchone():
            raise HTTPException(409, 'Email is already registered. Open that account to issue a new link.')
        db.execute('INSERT INTO users VALUES(?,?,?,?,?,0,0,?)', (uid, email, name, encoded, 'student', utcnow()))
        token = auth.account_token(db, uid, 'invite')
        if body.course:
            db.execute('INSERT INTO enrollments VALUES(?,?,?)', (uid, body.course, utcnow()))
    return {'user_id':uid, 'activation_url':account_link(token, 'activate'), 'expires_at':auth.expiry(24),
            'message':'Invitation created. Share this private, one-time link with the student. They choose their password.'}


@router.post('/api/admin/users/{uid}/account-link')
def issue_account_link(uid: str, request: Request):
    admin = auth.require_admin(request)
    auth.rate_limit('admin-account-link:'+admin['id'], 30, 3600)
    account_link('configuration-check', 'activate')
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        user = db.execute('SELECT role,verified,suspended FROM users WHERE id=?', (uid,)).fetchone()
        if not user:
            raise HTTPException(404, 'Account not found')
        if user['role'] == 'admin' or user['suspended']:
            raise HTTPException(409, 'Account links are available for active student accounts only')
        kind = 'reset' if user['verified'] else 'invite'
        # Invalidate all previous invitation/recovery links, including emailed ones.
        db.execute('DELETE FROM account_tokens WHERE user_id=?', (uid,))
        token = auth.account_token(db, uid, kind)
    action = 'reset' if kind == 'reset' else 'activate'
    return {'account_url':account_link(token, action), 'expires_at':auth.expiry(1 if kind == 'reset' else 24),
            'message':'Share this private link only after confirming the student’s identity. Previous account links are invalid.'}


@router.get('/api/public/account-options')
def account_options():
    return {'email_registration':auth.mail_configured(), 'admin_invitations':True}


@router.post('/api/auth/activate')
def activate_account(body: auth.ResetBody, request: Request):
    auth.rate_limit('activate:'+auth.client_ip(request), 20, 900)
    auth.validate_password(body.password)
    encoded = auth.hasher.hash(body.password)
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        row = db.execute('''SELECT t.user_id FROM account_tokens t JOIN users u ON u.id=t.user_id
            WHERE t.token_hash=? AND t.kind='invite' AND t.expires_at>? AND u.suspended=0 AND u.role='student' ''',
                         (auth.digest(body.token), utcnow())).fetchone()
        if not row:
            raise HTTPException(400, 'This invitation is invalid or expired. Ask the administrator for a new link.')
        db.execute('UPDATE users SET password_hash=?,verified=1 WHERE id=?', (encoded, row['user_id']))
        db.execute('DELETE FROM account_tokens WHERE user_id=?', (row['user_id'],))
        db.execute('DELETE FROM auth_sessions WHERE user_id=?', (row['user_id'],))
    auth.access_event(request, 'invitation_accepted', row['user_id'])
    return {'message':'Account activated by administrator invitation. Sign in with your new password.'}


def activity_report(days: int, q: str, course: str, status: str, offset: int, limit: int):
    cutoff = (datetime.now(timezone.utc)-timedelta(days=days)).isoformat(timespec='seconds')
    where = ['a.created_at>=?']
    params = [cutoff]
    if q:
        needle = '%'+q.replace('\\','\\\\').replace('%','\\%').replace('_','\\_')+'%'
        where.append("(u.name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\' OR v.title LIKE ? ESCAPE '\\')")
        params.extend([needle]*3)
    if course:
        where.append('v.course=?');params.append(course)
    live = '''a.closed=0 AND l.activity_id=a.id AND l.expires_at>? AND s.expires_at>?
        AND u.suspended=0 AND u.verified=1 AND (u.role='admin' OR EXISTS (SELECT 1 FROM enrollments e
        JOIN course_publication p ON p.course=e.course WHERE e.user_id=a.user_id AND e.course=v.course AND p.published=1))
        AND (a.player_session_id IS NULL OR EXISTS (SELECT 1 FROM player_ownership po JOIN player_sessions ps ON ps.id=po.session_id
        WHERE po.session_id=a.player_session_id AND ps.closed=0 AND po.expires_at>?))'''
    live_params = [time.time(), utcnow(), time.time()]
    if status == 'live':
        where.append('('+live+')');params.extend(live_params)
    joins = '''FROM activity_sessions a JOIN users u ON u.id=a.user_id JOIN videos v ON v.id=a.video_id
        LEFT JOIN activity_leases l ON l.user_id=a.user_id LEFT JOIN auth_sessions s ON s.id=a.auth_session_id'''
    conditions = ' WHERE '+' AND '.join(where)
    with connect() as db:
        total = db.execute('SELECT COUNT(*) '+joins+conditions, params).fetchone()[0]
        summary = dict(db.execute('''SELECT COUNT(DISTINCT a.user_id) learners,
            COALESCE(SUM(a.activity_seconds),0) activity_seconds,COUNT(DISTINCT a.video_id) lectures '''+joins+conditions, params).fetchone())
        rows = [dict(r) for r in db.execute('''SELECT a.id,a.user_id,u.name,u.email,u.role,v.title,v.course,a.activity_seconds,
            a.created_at,a.last_heartbeat,a.ip,a.device,CASE WHEN '''+live+''' THEN 1 ELSE 0 END live
            '''+joins+conditions+' ORDER BY a.last_heartbeat DESC,a.id LIMIT ? OFFSET ?', live_params+params+[limit,offset])]
    for row in rows:
        row['last_active'] = datetime.fromtimestamp(row.pop('last_heartbeat'),timezone.utc).isoformat(timespec='seconds')
    return {'sessions':rows, 'total':total, 'offset':offset, 'limit':limit, 'summary':summary,
            'basis':'Visible lesson activity; not verified playback or attention.',
            'period':f'Sessions opened in the last {days} days (UTC)', 'retention_days':90}


@router.get('/api/admin/player-activity')
def player_activity(request: Request, days: int=Query(30,ge=1,le=90), q: str=Query('',max_length=120),
                    course: str=Query('',max_length=200), status: str=Query('all',pattern='^(all|live)$'),
                    offset: int=Query(0,ge=0), limit: int=Query(25,ge=1,le=100)):
    auth.require_admin(request)
    return activity_report(days,q,course,status,offset,limit)


def csv_cell(value):
    text = str(value if value is not None else '')
    # CSV quoting alone does not stop spreadsheet formula execution.
    return "'"+text if text.lstrip().startswith(('=','+','-','@','\t','\r')) else text


@router.get('/api/admin/player-activity/export')
def export_activity(request: Request, days: int=Query(30,ge=1,le=90), q: str=Query('',max_length=120),
                    course: str=Query('',max_length=200), status: str=Query('all',pattern='^(all|live)$')):
    admin = auth.require_admin(request)
    auth.rate_limit('activity-export:'+admin['id'], 10, 3600)
    report = activity_report(days,q,course,status,0,10001)
    if report['total']>10000:
        raise HTTPException(422,'More than 10,000 sessions match. Narrow the period or filters before exporting.')
    output = io.StringIO();writer = csv.writer(output)
    fields = ['name','email','title','course','activity_seconds','created_at','last_active','ip','device','live']
    writer.writerow(['Student','Email','Lecture','Course','Visible activity seconds','Session opened (UTC)',
                     'Last heartbeat (UTC)','IP address','Device','Live lesson page'])
    for row in report['sessions']:
        writer.writerow([csv_cell(round(row[f],2) if f=='activity_seconds' else row[f]) for f in fields])
    audit(admin['id'],'activity_exported',f'{report["total"]} sessions / {days} days')
    return Response(output.getvalue(),media_type='text/csv',headers={'Content-Disposition':'attachment; filename="courseforge-lesson-activity.csv"'})


@router.get('/api/admin/system')
def system_status(request: Request):
    auth.require_admin(request)
    with connect() as db:
        checks = {r['name']:dict(r)|{'summary':json.loads(r['summary_json'])} for r in db.execute('SELECT * FROM service_checks')}
        for check in checks.values():check.pop('summary_json')
        counts = {r['status']:r['count'] for r in db.execute('SELECT status,COUNT(*) count FROM task_queue GROUP BY status')}
        courses = [dict(r) for r in db.execute('''SELECT v.course,COUNT(*) lessons,COUNT(p.video_id) mapped,
            SUM(CASE WHEN v.duration>0 THEN 1 ELSE 0 END) measured_durations,MAX(COALESCE(cp.published,0)) published
            FROM videos v LEFT JOIN lecture_providers p ON p.video_id=v.id
            LEFT JOIN course_publication cp ON cp.course=v.course GROUP BY v.course''')]
        invites = db.execute("SELECT COUNT(*) FROM account_tokens WHERE kind='invite' AND expires_at>?",(utcnow(),)).fetchone()[0]
        audit_rows = [dict(r) for r in db.execute('''SELECT a.action,a.resource,a.created_at,u.name actor
            FROM admin_audit a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT 50''')]
    return {'email':{'provider':os.getenv('SMTP_PROVIDER','brevo'), 'configured':auth.mail_configured(),
                     'required_settings':['PUBLIC_BASE_URL','SMTP_HOST','SMTP_FROM','SMTP_USER','SMTP_PASSWORD']},
            'provider_configured':bool(os.getenv('ODYSEE_AUTH_TOKEN') and os.getenv('ODYSEE_CHANNEL_ID')),
            'player':CAPABILITIES,'service_checks':checks,'tasks':counts,'courses':courses,
            'pending_invitations':invites,'audit':audit_rows, 'retention':{'access_days':30,'session_days':90,'admin_audit_days':90}}


@router.post('/api/admin/provider-sync')
def provider_sync(request: Request):
    admin=auth.require_admin(request)
    auth.rate_limit('provider-sync:'+admin['id'],1,60)
    return sync_provider_mappings()


class RoleBody(BaseModel):
    role: Literal['admin','student']
    current_password: str=Field(min_length=1,max_length=128)


@router.put('/api/admin/users/{uid}/role')
def change_role(uid: str,body: RoleBody,request: Request):
    admin=auth.require_admin(request)
    auth.rate_limit('admin-role:'+admin['id'],5,900)
    if not auth.check_password(admin['password_hash'],body.current_password):
        raise HTTPException(403,'Your current password is incorrect')
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        target=db.execute('SELECT role,verified,suspended FROM users WHERE id=?',(uid,)).fetchone()
        if not target:raise HTTPException(404,'Account not found')
        if target['role']==body.role:return {'changed':False,'role':body.role,'session_revoked':False}
        if body.role=='admin' and (not target['verified'] or target['suspended']):
            raise HTTPException(409,'Activate and restore the account before promoting it.')
        if body.role=='student' and db.execute("SELECT COUNT(*) FROM users WHERE role='admin' AND verified=1 AND suspended=0").fetchone()[0]<=1:
            raise HTTPException(409,'The last active administrator cannot be demoted.')
        db.execute('UPDATE users SET role=? WHERE id=?',(body.role,uid))
        db.execute('DELETE FROM auth_sessions WHERE user_id=?',(uid,))
        db.execute('DELETE FROM account_tokens WHERE user_id=?',(uid,))
        db.execute('INSERT INTO admin_audit(actor_id,action,resource,created_at) VALUES(?,?,?,?)',
            (admin['id'],'Account role changed',f"{uid} / {target['role']} to {body.role}",utcnow()))
    return {'changed':True,'role':body.role,'session_revoked':uid==admin['id']}
