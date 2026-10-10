"""Account lifecycle and the central HTTP authorization boundary."""
from datetime import datetime, timedelta, timezone
import hashlib
import ipaddress
import os
import re
import secrets
import smtplib
import ssl
import time
from email.message import EmailMessage
from urllib.parse import unquote, urlsplit

from argon2 import PasswordHasher
from argon2.exceptions import VerificationError, InvalidHashError
from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from .db import connect, utcnow
from .migrations import PERSONAL_TABLES

router = APIRouter()
hasher = PasswordHasher(time_cost=2, memory_cost=19456, parallelism=1)
_DUMMY_HASH = hasher.hash(secrets.token_urlsafe(32))
COOKIE = 'cf_session'


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def expiry(hours: int) -> str:
    return (datetime.now(timezone.utc) + timedelta(hours=hours)).isoformat(timespec='seconds')


def public_user(row) -> dict:
    return {k: row[k] for k in ('id', 'email', 'name', 'role', 'verified', 'suspended', 'created_at')}


def client_ip(request: Request) -> str:
    peer = request.client.host if request.client else ''
    try:
        address = ipaddress.ip_address(peer)
        trusted = any(address in ipaddress.ip_network(net.strip()) for net in
                      os.getenv('TRUSTED_PROXY_CIDRS', '').split(',') if net.strip())
        candidate = ((request.headers.get('x-forwarded-for') or '').split(',')[0].strip()
                     if trusted else peer)
        return str(ipaddress.ip_address(candidate or peer))
    except ValueError:
        return peer[:80]


def access_event(request: Request, kind: str, user_id: str | None = None):
    with connect() as db:
        db.execute('INSERT INTO access_events(user_id,event_type,ip,device,created_at) VALUES(?,?,?,?,?)',
                   (user_id, kind, client_ip(request), request.headers.get('user-agent', '')[:220], utcnow()))


def rate_limit(key: str, limit: int, seconds: int):
    now = time.time()
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        row = db.execute('SELECT count,reset_at FROM rate_limits WHERE key=?', (key,)).fetchone()
        if row and row['reset_at'] > now and row['count'] >= limit:
            raise HTTPException(429, 'Too many requests. Please try again later.', headers={'Retry-After':str(seconds)})
        count = row['count'] + 1 if row and row['reset_at'] > now else 1
        reset = row['reset_at'] if row and row['reset_at'] > now else now + seconds
        db.execute('INSERT INTO rate_limits VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET count=excluded.count,reset_at=excluded.reset_at',
                   (key, count, reset))


def normalize_email(value: str) -> str:
    email = value.strip().casefold()
    if len(email) > 254 or not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', email):
        raise HTTPException(422, 'Enter a valid email address')
    return email


def validate_password(value: str):
    if not 12 <= len(value) <= 128:
        raise HTTPException(422, 'Use a password between 12 and 128 characters')


def check_password(encoded: str, value: str) -> bool:
    try:
        return hasher.verify(encoded, value)
    except (VerificationError, InvalidHashError):
        return False


def mail_configured() -> bool:
    ready=bool(os.getenv('PUBLIC_BASE_URL') and os.getenv('SMTP_HOST') and os.getenv('SMTP_FROM'))
    if os.getenv('SMTP_HOST','').casefold()=='smtp-relay.brevo.com':
        ready=ready and bool(os.getenv('SMTP_USER') and os.getenv('SMTP_PASSWORD'))
    return ready


def registration_mode() -> str:
    """Email verification is the default; immediate access is an explicit choice."""
    mode = os.getenv('REGISTRATION_MODE', 'email').strip().casefold()
    return mode if mode in ('email', 'open', 'invite') else 'invite'


def account_options() -> dict:
    mode = registration_mode()
    email_ready = mail_configured()
    return {'registration_enabled':mode == 'open' or (mode == 'email' and email_ready),
            'registration_mode':mode, 'email_registration':mode == 'email' and email_ready,
            'email_delivery':email_ready, 'admin_invitations':True}


def require_mail_configuration():
    if not mail_configured():
        raise HTTPException(503, 'Account email is not configured. Please contact the administrator.')


def send_account_email(email: str, token: str, kind: str):
    require_mail_configuration()
    base = os.getenv('PUBLIC_BASE_URL', '').rstrip('/')
    host = os.getenv('SMTP_HOST', '')
    if not base or not host or not os.getenv('SMTP_FROM'):
        raise HTTPException(503, 'Account email is not configured. Please contact the administrator.')
    link = f'{base}/#{kind}?token={token}'
    msg = EmailMessage()
    msg['Subject'] = 'Verify your CourseForge email' if kind == 'verify' else 'Reset your CourseForge password'
    msg['From'] = os.environ['SMTP_FROM']
    msg['To'] = email
    msg.set_content(f'Open this link to {"verify your email" if kind == "verify" else "reset your password"}:\n{link}\n\nIf you did not request this, ignore this email.')
    try:
        with smtplib.SMTP(host, int(os.getenv('SMTP_PORT', '587')), timeout=8) as smtp:
            smtp.starttls(context=ssl.create_default_context())
            if os.getenv('SMTP_USER'):
                smtp.login(os.environ['SMTP_USER'], os.getenv('SMTP_PASSWORD', ''))
            smtp.send_message(msg)
    except (OSError, smtplib.SMTPException) as exc:
        raise HTTPException(503, 'Unable to send account email. Please try again later.') from exc


def account_token(db, uid: str, kind: str) -> str:
    token = secrets.token_urlsafe(32)
    db.execute('DELETE FROM account_tokens WHERE user_id=? AND kind=?', (uid, kind))
    db.execute('INSERT INTO account_tokens VALUES(?,?,?,?)', (digest(token), uid, kind, expiry(24 if kind in ('verify','invite') else 1)))
    return token


def bootstrap_admin(email: str, name: str, password: str, path=None) -> dict:
    email = normalize_email(email)
    validate_password(password)
    with connect(path) as db:
        db.execute('BEGIN IMMEDIATE')
        db.execute('PRAGMA defer_foreign_keys=ON')
        if db.execute("SELECT 1 FROM users WHERE role='admin'").fetchone():
            raise ValueError('An administrator already exists; use account management to create additional admins')
        if db.execute('SELECT 1 FROM users WHERE email=?', (email,)).fetchone():
            raise ValueError('This email is already registered')
        uid = 'usr_' + secrets.token_hex(16)
        db.execute('INSERT INTO users VALUES(?,?,?,?,?,1,0,?)', (uid,email,name,hasher.hash(password),'admin',utcnow()))
        for table in PERSONAL_TABLES:
            db.execute(f"UPDATE {table} SET user_id=? WHERE user_id='legacy'", (uid,))
        return public_user(db.execute('SELECT * FROM users WHERE id=?', (uid,)).fetchone())


def authenticate(request: Request) -> dict | None:
    token = request.cookies.get(COOKIE)
    if not token or len(token) > 100:
        return None
    with connect() as db:
        row = db.execute('''SELECT u.*,s.id session_id,s.csrf_token,s.last_seen
            FROM auth_sessions s JOIN users u ON u.id=s.user_id
            WHERE s.token_hash=? AND s.expires_at>? AND u.suspended=0''', (digest(token),utcnow())).fetchone()
        if not row:
            return None
        if (datetime.now(timezone.utc)-datetime.fromisoformat(row['last_seen'])).total_seconds()>60:
            db.execute('UPDATE auth_sessions SET last_seen=? WHERE id=?', (utcnow(),row['session_id']))
        return dict(row)


def require_user(request: Request, verified=True) -> dict:
    user = getattr(request.state, 'user', None)
    if not user:
        raise HTTPException(401, 'Please sign in')
    if verified and not user['verified']:
        raise HTTPException(403, 'Verify your email to start learning')
    return user


def require_admin(request: Request) -> dict:
    user = require_user(request)
    if user['role'] != 'admin':
        raise HTTPException(403, 'Administrator access required')
    return user


def check_origin(request: Request):
    origin = request.headers.get('origin')
    if origin:
        expected = os.getenv('PUBLIC_BASE_URL', str(request.base_url)).rstrip('/')
        expected_origin = urlsplit(expected)
        if origin.rstrip('/') != f'{expected_origin.scheme}://{expected_origin.netloc}':
            raise HTTPException(403, 'Cross-origin request rejected')
    if request.headers.get('sec-fetch-site') == 'cross-site':
        raise HTTPException(403, 'Cross-origin request rejected')


def enrolled(uid: str, course: str) -> bool:
    with connect() as db:
        return bool(db.execute('''SELECT 1 FROM enrollments e JOIN course_publication p ON p.course=e.course
            WHERE e.user_id=? AND e.course=? AND p.published=1''', (uid,course)).fetchone())


def require_course(user: dict, course: str):
    if user['role'] != 'admin' and not enrolled(user['id'], course):
        raise HTTPException(403, 'Enroll in this published course to access its lessons')


async def authorize(request: Request) -> dict | None:
    """Deny by default. Public endpoints are explicitly enumerated."""
    user = await run_in_threadpool(authenticate, request)
    request.state.user = user
    path = request.url.path
    mutation = request.method not in ('GET','HEAD','OPTIONS')
    if mutation:
        check_origin(request)
        # Logged-in auth actions also require the session CSRF token. Account
        # verification/reset tokens intentionally work without an existing login.
        if user and path not in ('/api/auth/verify','/api/auth/reset','/api/auth/activate'):
            supplied = request.headers.get('x-csrf-token','')
            if not secrets.compare_digest(supplied, user['csrf_token']):
                raise HTTPException(403, 'Invalid CSRF token')
    if not path.startswith('/api/'):
        return user
    public = path in ('/api/health','/api/public/courses','/api/auth/register','/api/auth/login',
                      '/api/auth/verify','/api/auth/forgot','/api/auth/reset','/api/auth/resend',
                      '/api/auth/activate','/api/public/account-options')
    public = public or (request.method in ('GET','HEAD') and path.startswith('/api/public/courses/'))
    public = public or (request.method in ('GET','HEAD') and re.fullmatch(r'/api/courses/[^/]+/cover',path) is not None)
    if public:
        if '/cover' in path:
            course = unquote(path.split('/')[3])
            with connect() as db:
                published = db.execute('SELECT published FROM course_publication WHERE course=?',(course,)).fetchone()
            if not (user and user['role']=='admin') and not (published and published['published']):
                raise HTTPException(404,'Course not found')
        return user
    require_user(request, verified=not (path.startswith('/api/auth/') or path=='/api/me'))
    admin_only = (path.startswith('/api/admin/') or path in ('/api/scan','/api/jobs','/api/docs','/api/openapi.json')
                  or path.startswith('/api/analytics/') or path.endswith('/reindex')
                  or (path.startswith('/api/courses/') and mutation and not path.endswith('/enroll'))
                  or path=='/api/syllabus/generate')
    if admin_only:
        require_admin(request)
    if user['role'] != 'admin':
        # Check resource references before calling any learning subsystem.
        courses = []
        parts = path.split('/')
        if len(parts)>3 and parts[2]=='materials':
            courses.append(unquote(parts[3]))
        ids = []
        if len(parts)>3 and parts[2]=='videos':
            ids.append(parts[3])
        if len(parts)>3 and parts[2]=='chunks':
            with connect() as db:
                row = db.execute('SELECT video_id FROM chunks WHERE id=?',(parts[3],)).fetchone()
            if row: ids.append(row['video_id'])
        query = dict(request.query_params)
        if query.get('course'): courses.append(query['course'])
        if query.get('video_id'): ids.append(query['video_id'])
        if mutation:
            try:
                body = await request.json()
            except (ValueError, UnicodeDecodeError):
                body = {}
            if isinstance(body,dict):
                if isinstance(body.get('course'),str):courses.append(body['course'])
                if isinstance(body.get('courses'),list):courses.extend(c for c in body['courses'] if isinstance(c,str))
                if isinstance(body.get('video_id'),str):ids.append(body['video_id'])
        with connect() as db:
            for vid in ids:
                video = db.execute('SELECT course FROM videos WHERE id=?',(vid,)).fetchone()
                if not video: raise HTTPException(404,'Video not found')
                courses.append(video['course'])
        for course in courses: require_course(user,course)
    return user


class Credentials(BaseModel):
    email: str = Field(max_length=254)
    password: str = Field(min_length=1,max_length=128)


class Registration(Credentials):
    name: str = Field(min_length=1,max_length=120)


class EmailBody(BaseModel):
    email: str = Field(max_length=254)


class TokenBody(BaseModel):
    token: str = Field(min_length=20,max_length=100)


class ResetBody(TokenBody):
    password: str = Field(min_length=12,max_length=128)


@router.post('/api/auth/register',status_code=201)
def register(body: Registration, request: Request, response: Response):
    rate_limit('register:'+client_ip(request),5,3600)
    email = normalize_email(body.email)
    validate_password(body.password)
    mode = registration_mode()
    if mode == 'invite':
        raise HTTPException(403, 'Registration is by administrator invitation. Ask for an activation link.')
    if mode == 'email':
        require_mail_configuration()
    name = body.name.strip()
    if not name: raise HTTPException(422,'Enter your name')
    password_hash = hasher.hash(body.password)
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        if db.execute('SELECT 1 FROM users WHERE email=?',(email,)).fetchone():
            return {'message':'If you already have an account, sign in or request account recovery.'}
        uid = 'usr_'+secrets.token_hex(16)
        # The legacy verified flag means activated access (invitations also set
        # it). Open registration does not establish ownership of the email.
        db.execute('INSERT INTO users VALUES(?,?,?,?,?,?,0,?)',
                   (uid,email,name,password_hash,'student',int(mode == 'open'),utcnow()))
        if mode == 'email':
            token = account_token(db,uid,'verify')
        user = db.execute('SELECT * FROM users WHERE id=?', (uid,)).fetchone()
    access_event(request, 'registered', uid)
    if mode == 'open':
        return start_session(user, request, response) | {'message':'Account created. Choose a course to start learning.'}
    send_account_email(email,token,'verify')
    return {'message':'Check your email to verify your account, then sign in.'}


def start_session(user, request: Request, response: Response) -> dict:
    token = secrets.token_urlsafe(32)
    csrf = secrets.token_urlsafe(32)
    sid = 'ses_'+secrets.token_hex(16)
    with connect() as db:
        # Rotate the browser's old session on sign-in or immediate registration.
        if request.cookies.get(COOKIE):
            db.execute('DELETE FROM auth_sessions WHERE token_hash=?',(digest(request.cookies[COOKIE]),))
        db.execute('INSERT INTO auth_sessions VALUES(?,?,?,?,?,?,?,?,?)',
                   (sid,user['id'],digest(token),csrf,utcnow(),expiry(168),utcnow(),request.headers.get('user-agent','')[:220],client_ip(request)))
    response.set_cookie(COOKIE,token,max_age=604800,httponly=True,secure=os.getenv('COOKIE_SECURE','1')=='1',samesite='lax',path='/')
    access_event(request,'login',user['id'])
    return {'user':public_user(user),'csrf_token':csrf,'session_id':sid}


@router.post('/api/auth/login')
def login(body: Credentials, request: Request, response: Response):
    email = normalize_email(body.email)
    rate_limit('login-ip:'+client_ip(request),30,900)
    rate_limit('login-account:'+digest(email),10,900)
    with connect() as db:
        user = db.execute('SELECT * FROM users WHERE email=?',(email,)).fetchone()
    valid = check_password(user['password_hash'] if user else _DUMMY_HASH,body.password)
    if not user or not valid or user['suspended']:
        access_event(request,'login_failed')
        raise HTTPException(401,'Email or password is incorrect')
    return start_session(user, request, response)


@router.get('/api/me')
def me(request: Request):
    user = require_user(request,verified=False)
    return {'user':public_user(user),'csrf_token':user['csrf_token'],'session_id':user['session_id']}


@router.post('/api/auth/logout')
def logout(request: Request,response: Response):
    user = require_user(request,verified=False)
    with connect() as db: db.execute('DELETE FROM auth_sessions WHERE id=?',(user['session_id'],))
    response.delete_cookie(COOKIE,path='/')
    access_event(request,'logout',user['id'])
    return {'ok':True}


@router.post('/api/auth/verify')
def verify(body: TokenBody):
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        row = db.execute("SELECT user_id FROM account_tokens WHERE token_hash=? AND kind='verify' AND expires_at>?",(digest(body.token),utcnow())).fetchone()
        if not row: raise HTTPException(400,'This verification link is invalid or expired')
        db.execute('UPDATE users SET verified=1 WHERE id=?',(row['user_id'],))
        db.execute('DELETE FROM account_tokens WHERE token_hash=?',(digest(body.token),))
    return {'message':'Email verified. You can now sign in and enroll.'}


@router.post('/api/auth/forgot')
@router.post('/api/auth/resend')
def request_email(body: EmailBody, request: Request):
    email = normalize_email(body.email)
    rate_limit('email-ip:'+client_ip(request),10,3600)
    rate_limit('email-account:'+digest(email),3,3600)
    require_mail_configuration()
    kind = 'reset' if request.url.path.endswith('/forgot') else 'verify'
    token = None
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        user = db.execute('SELECT * FROM users WHERE email=? AND suspended=0',(email,)).fetchone()
        if user and (kind=='reset' or not user['verified']):
            token = account_token(db,user['id'],kind)
    if token:
        send_account_email(email,token,kind)
    return {'message':'If this account needs the requested email, it has been sent.'}


@router.post('/api/auth/reset')
def reset(body: ResetBody):
    validate_password(body.password)
    encoded = hasher.hash(body.password)
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        row = db.execute("SELECT user_id FROM account_tokens WHERE token_hash=? AND kind='reset' AND expires_at>?",(digest(body.token),utcnow())).fetchone()
        if not row: raise HTTPException(400,'This password reset link is invalid or expired')
        db.execute('UPDATE users SET password_hash=? WHERE id=?',(encoded,row['user_id']))
        db.execute('DELETE FROM account_tokens WHERE user_id=?',(row['user_id'],))
        db.execute('DELETE FROM auth_sessions WHERE user_id=?',(row['user_id'],))
    return {'message':'Password reset. Sign in with your new password.'}


@router.get('/api/auth/sessions')
def sessions(request: Request):
    user=require_user(request,verified=False)
    with connect() as db:
        rows=db.execute('SELECT id,device,created_at,last_seen FROM auth_sessions WHERE user_id=? AND expires_at>? ORDER BY last_seen DESC',(user['id'],utcnow())).fetchall()
    return {'sessions':[dict(r)|{'current':r['id']==user['session_id']} for r in rows]}


@router.delete('/api/auth/sessions/{sid}')
def revoke(sid: str,request: Request):
    user=require_user(request,verified=False)
    with connect() as db:
        deleted=db.execute('DELETE FROM auth_sessions WHERE id=? AND user_id=?',(sid,user['id'])).rowcount
    if not deleted:raise HTTPException(404,'Session not found')
    access_event(request,'session_revoked',user['id'])
    return {'ok':True}


class ProfileBody(BaseModel):
    name: str = Field(min_length=1,max_length=120)
    current_password: str | None = Field(default=None,max_length=128)
    password: str | None = Field(default=None,min_length=12,max_length=128)


@router.patch('/api/me')
def update_profile(body: ProfileBody,request: Request):
    user=require_user(request,verified=False)
    if not body.name.strip():raise HTTPException(422,'Enter your name')
    if body.password and not check_password(user['password_hash'],body.current_password or ''):
        raise HTTPException(403,'Current password is incorrect')
    with connect() as db:
        db.execute('UPDATE users SET name=? WHERE id=?',(body.name.strip(),user['id']))
        if body.password:
            db.execute('UPDATE users SET password_hash=? WHERE id=?',(hasher.hash(body.password),user['id']))
            db.execute('DELETE FROM auth_sessions WHERE user_id=? AND id!=?',(user['id'],user['session_id']))
        row=db.execute('SELECT * FROM users WHERE id=?',(user['id'],)).fetchone()
    return {'user':public_user(row)}


class DeleteAccountBody(BaseModel):
    password: str = Field(max_length=128)


@router.delete('/api/me')
def delete_account(body: DeleteAccountBody,request: Request,response: Response):
    user=require_user(request,verified=False)
    if not check_password(user['password_hash'],body.password):raise HTTPException(403,'Password is incorrect')
    if user['role']=='admin':raise HTTPException(409,'Administrators must transfer administration before deletion')
    with connect() as db:
        # Children first: old learning tables intentionally have no users FK
        # so the pre-account records can be migrated without a fabricated user.
        for table in reversed(PERSONAL_TABLES):
            db.execute(f'DELETE FROM {table} WHERE user_id=?',(user['id'],))
        db.execute('DELETE FROM access_events WHERE user_id=?',(user['id'],))
        db.execute('DELETE FROM users WHERE id=?',(user['id'],))
    response.delete_cookie(COOKIE,path='/')
    return {'ok':True}
