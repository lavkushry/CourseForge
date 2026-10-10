"""Public catalog, enrollment, honest lesson activity and administrator reporting."""
import asyncio
from datetime import datetime,timedelta,timezone
import json
import logging
import secrets
import time

from fastapi import APIRouter, HTTPException, Request, Query
from pydantic import BaseModel,Field

from . import auth, course_metadata
from .db import connect,fetch_video,utcnow,learner_id,learner_courses
from .media import sync_provider_mappings

router=APIRouter()
log=logging.getLogger(__name__)


def learning_event(uid: str,kind: str,video_id=None,details=''):
    with connect() as db:
        db.execute('INSERT INTO learning_events(user_id,video_id,event_type,details,created_at) VALUES(?,?,?,?,?)',
                   (uid,video_id,kind,details[:300],utcnow()))


def catalog_record(course: str,details=False,user=None):
    try: record=course_metadata.get_course(course)
    except course_metadata.UnknownCourse:raise HTTPException(404,'Course not found')
    with connect() as db:
        publication=db.execute('SELECT * FROM course_publication WHERE course=?',(course,)).fetchone()
        if not publication or not publication['published']:raise HTTPException(404,'Course not found')
        record['description']=publication['description']
        record['enrolled']=bool(user and db.execute('SELECT 1 FROM enrollments WHERE user_id=? AND course=?',(user['id'],course)).fetchone())
        record['available_lessons']=db.execute('SELECT COUNT(*) FROM videos v JOIN lecture_providers p ON p.video_id=v.id WHERE v.course=?',(course,)).fetchone()[0]
        if details:
            record['lessons']=[dict(r) for r in db.execute('''SELECT v.id,v.title,v.duration,
                CASE WHEN p.video_id IS NULL THEN 0 ELSE 1 END available FROM videos v
                LEFT JOIN lecture_providers p ON p.video_id=v.id WHERE v.course=? ORDER BY v.title COLLATE NOCASE''',(course,))]
    return record


@router.get('/api/public/courses')
def public_catalog(request: Request):
    with connect() as db:
        names=[r['course'] for r in db.execute('SELECT course FROM course_publication WHERE published=1 ORDER BY course')]
    records=[]
    for name in names:
        try:records.append(catalog_record(name,user=getattr(request.state,'user',None)))
        except HTTPException:continue
    return {'courses':records}


@router.get('/api/public/courses/{course_id}')
def public_course(course_id: str,request: Request):
    return catalog_record(course_id,details=True,user=getattr(request.state,'user',None))


@router.post('/api/courses/{course_id}/enroll',status_code=201)
def enroll(course_id: str,request: Request):
    user=auth.require_user(request)
    catalog_record(course_id)
    with connect() as db:
        db.execute('INSERT OR IGNORE INTO enrollments VALUES(?,?,?)',(user['id'],course_id,utcnow()))
    learning_event(user['id'],'enrolled',details=course_id)
    return {'enrolled':True}


@router.get('/api/me/learning')
def my_learning(request: Request):
    user=auth.require_user(request)
    with connect() as db:
        rows=db.execute('''SELECT e.course,e.created_at,l.video_id last_video_id,l.updated_at last_opened,
            COUNT(v.id) lessons,SUM(COALESCE(p.completed,0)) completed FROM enrollments e
            JOIN course_publication cp ON cp.course=e.course AND cp.published=1
            JOIN videos v ON v.course=e.course
            LEFT JOIN video_progress p ON p.video_id=v.id AND p.user_id=e.user_id
            LEFT JOIN lesson_visits l ON l.course=e.course AND l.user_id=e.user_id
            WHERE e.user_id=? GROUP BY e.course ORDER BY l.updated_at DESC,e.created_at DESC''',(user['id'],)).fetchall()
        seconds=db.execute('SELECT COALESCE(SUM(activity_seconds),0) FROM lesson_activity_totals WHERE user_id=?',(user['id'],)).fetchone()[0]
    return {'courses':[dict(r)|{'metadata':course_metadata.get_course(r['course'])} for r in rows],
            'activity_seconds':seconds,'time_basis':'visible_lesson_activity','completion_basis':'self_reported'}


@router.post('/api/videos/{video_id}/activity-session',status_code=201)
def open_activity(video_id: str,request: Request):
    user=auth.require_user(request);video=fetch_video(video_id)
    if not video:raise HTTPException(404,'Video not found')
    auth.rate_limit('activity-open:'+user['id'],90,60)
    sid='act_'+secrets.token_hex(16);now=time.time()
    with connect() as db:
        db.execute('''INSERT INTO activity_sessions(id,user_id,auth_session_id,video_id,last_heartbeat,created_at,device,ip)
            VALUES(?,?,?,?,?,?,?,?)''',(sid,user['id'],user['session_id'],video_id,now,utcnow(),
            request.headers.get('user-agent','')[:220],auth.client_ip(request)))
        db.execute('''INSERT INTO lesson_visits VALUES(?,?,?,?) ON CONFLICT(user_id,course)
            DO UPDATE SET video_id=excluded.video_id,updated_at=excluded.updated_at''',(user['id'],video['course'],video_id,utcnow()))
        db.execute('INSERT OR IGNORE INTO activity_leases VALUES(?,?,?)',(user['id'],sid,now+20))
    learning_event(user['id'],'lesson_opened',video_id)
    return {'id':sid,'activity_seconds':0,'basis':'visible_lesson_activity'}


class HeartbeatBody(BaseModel):
    sequence: int=Field(ge=1,le=10**9)
    visible: bool
    elapsed_seconds: float=Field(ge=0,le=20,allow_inf_nan=False)
    ended: bool=False


@router.post('/api/activity/{sid}/heartbeat')
def heartbeat(sid: str,body: HeartbeatBody,request: Request):
    user=auth.require_user(request);now=time.time()
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        row=db.execute('''SELECT * FROM activity_sessions WHERE id=? AND user_id=? AND auth_session_id=?''',
                       (sid,user['id'],user['session_id'])).fetchone()
        if not row:raise HTTPException(404,'Activity session not found')
        video=db.execute('SELECT course FROM videos WHERE id=?',(row['video_id'],)).fetchone()
        auth.require_course(user,video['course'])
        if row['closed'] or body.sequence<=row['last_sequence']:
            return {'activity_seconds':row['activity_seconds'],'accepted':False,'basis':'visible_lesson_activity'}
        lease=db.execute('SELECT * FROM activity_leases WHERE user_id=?',(user['id'],)).fetchone()
        eligible=not lease or lease['expires_at']<=now or lease['activity_id']==sid
        # A gap longer than a normal heartbeat isn't evidence that the lesson
        # stayed visible while the browser was sleeping or disconnected.
        gap=now-row['last_heartbeat']
        credited=min(body.elapsed_seconds,max(0,gap),20) if body.visible and eligible and gap<=30 else 0
        if body.visible and eligible and not body.ended:
            db.execute('''INSERT INTO activity_leases VALUES(?,?,?) ON CONFLICT(user_id)
                DO UPDATE SET activity_id=excluded.activity_id,expires_at=excluded.expires_at''',(user['id'],sid,now+20))
        elif not body.visible or body.ended:
            db.execute('DELETE FROM activity_leases WHERE user_id=? AND activity_id=?',(user['id'],sid))
        db.execute('UPDATE activity_sessions SET last_sequence=?,last_heartbeat=?,activity_seconds=activity_seconds+?,closed=? WHERE id=?',
                   (body.sequence,now,credited,int(body.ended),sid))
        if credited:
            db.execute('''INSERT INTO lesson_activity_totals VALUES(?,?,?,?) ON CONFLICT(user_id,video_id)
                DO UPDATE SET activity_seconds=activity_seconds+excluded.activity_seconds,updated_at=excluded.updated_at''',
                (user['id'],row['video_id'],credited,utcnow()))
    return {'activity_seconds':row['activity_seconds']+credited,'accepted':True,'basis':'visible_lesson_activity'}


class BookmarkBody(BaseModel):
    position: float=Field(ge=0,lt=1e9,allow_inf_nan=False)
    label: str=Field(min_length=1,max_length=160)


class ResumePointBody(BaseModel):
    position: float=Field(ge=0,lt=1e9,allow_inf_nan=False)


@router.put('/api/videos/{video_id}/resume-point')
def resume_point(video_id: str,body: ResumePointBody,request: Request):
    user=auth.require_user(request)
    video=fetch_video(video_id)
    if not video:raise HTTPException(404,'Video not found')
    if video.get('duration') and body.position>video['duration']:
        raise HTTPException(422,'Resume point exceeds the lecture duration')
    with connect() as db:
        db.execute('''INSERT INTO video_progress(user_id,video_id,position,updated_at) VALUES(?,?,?,?)
            ON CONFLICT(user_id,video_id) DO UPDATE SET position=excluded.position,updated_at=excluded.updated_at''',
            (user['id'],video_id,body.position,utcnow()))
    learning_event(user['id'],'resume_point_saved',video_id,f'{body.position}s')
    return {'position':body.position,'basis':'manually_saved_resume_point'}


@router.get('/api/videos/{video_id}/bookmarks')
def bookmarks(video_id: str,request: Request):
    user=auth.require_user(request)
    with connect() as db:
        rows=db.execute('SELECT id,position,label,created_at FROM bookmarks WHERE user_id=? AND video_id=? ORDER BY position',(user['id'],video_id)).fetchall()
    return {'bookmarks':[dict(r) for r in rows]}


@router.post('/api/videos/{video_id}/bookmarks',status_code=201)
def add_bookmark(video_id: str,body: BookmarkBody,request: Request):
    user=auth.require_user(request)
    if not fetch_video(video_id):raise HTTPException(404,'Video not found')
    if not body.label.strip():raise HTTPException(422,'Enter a bookmark label')
    bid='bm_'+secrets.token_hex(16)
    with connect() as db:db.execute('INSERT INTO bookmarks VALUES(?,?,?,?,?,?)',(bid,user['id'],video_id,body.position,body.label.strip(),utcnow()))
    return {'id':bid,'position':body.position,'label':body.label.strip()}


@router.delete('/api/bookmarks/{bid}')
def delete_bookmark(bid: str,request: Request):
    user=auth.require_user(request)
    with connect() as db:
        deleted=db.execute('DELETE FROM bookmarks WHERE id=? AND user_id=?',(bid,user['id'])).rowcount
    if not deleted:raise HTTPException(404,'Bookmark not found')
    return {'ok':True}


@router.get('/api/admin/overview')
def overview(request: Request):
    auth.require_admin(request)
    with connect() as db:
        scalar=lambda sql:db.execute(sql).fetchone()[0]
        totals={'students':scalar("SELECT COUNT(*) FROM users WHERE role='student'"),
                'verified_students':scalar("SELECT COUNT(*) FROM users WHERE role='student' AND verified=1"),
                'suspended_students':scalar("SELECT COUNT(*) FROM users WHERE role='student' AND suspended=1"),
                'enrollments':scalar('SELECT COUNT(*) FROM enrollments'),
                'completed_lessons':scalar('SELECT COUNT(*) FROM video_progress WHERE completed=1'),
                'activity_seconds':scalar('SELECT COALESCE(SUM(activity_seconds),0) FROM lesson_activity_totals'),
                'playing_seconds':scalar('SELECT COALESCE(SUM(playing_seconds),0) FROM native_totals'),
                'courses':scalar('SELECT COUNT(DISTINCT course) FROM videos'),
                'available_lectures':scalar('SELECT COUNT(*) FROM lecture_providers'),
                'lectures':scalar('SELECT COUNT(*) FROM videos'),
                'active_sessions':db.execute('SELECT COUNT(*) FROM auth_sessions WHERE expires_at>? AND last_seen>?',
                    (utcnow(),(datetime.now(timezone.utc)-timedelta(minutes=5)).isoformat(timespec='seconds'))).fetchone()[0]}
        events=[dict(r) for r in db.execute('''SELECT e.*,u.name,v.title FROM learning_events e
            JOIN users u ON u.id=e.user_id LEFT JOIN videos v ON v.id=e.video_id ORDER BY e.id DESC LIMIT 30''')]
        access=[dict(r) for r in db.execute('SELECT * FROM access_events ORDER BY id DESC LIMIT 30')]
        funnels=[dict(r) for r in db.execute('''SELECT e.course,COUNT(DISTINCT e.user_id) enrolled,
            COUNT(DISTINCT l.user_id) started FROM enrollments e LEFT JOIN lesson_visits l
            ON l.user_id=e.user_id AND l.course=e.course GROUP BY e.course''')]
    return {'summary':totals,'recent_activity':events,'access_events':access,'funnels':funnels,
            'activity_basis':'Visible lesson activity; not verified video watch time',
            'completion_basis':'Self-reported lesson completion'}


@router.get('/api/admin/users')
def users(request: Request,q: str=Query(default='',max_length=120),offset: int=Query(default=0,ge=0),limit: int=Query(default=25,ge=1,le=100)):
    auth.require_admin(request)
    where="WHERE name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\'"
    needle='%'+q.replace('\\','\\\\').replace('%','\\%').replace('_','\\_')+'%'
    with connect() as db:
        total=db.execute('SELECT COUNT(*) FROM users '+where,(needle,needle)).fetchone()[0]
        rows=db.execute('''SELECT u.id,u.email,u.name,u.role,u.verified,u.suspended,u.created_at,
            (SELECT COUNT(*) FROM enrollments e WHERE e.user_id=u.id) enrollments,
            (SELECT COUNT(*) FROM video_progress p WHERE p.user_id=u.id AND p.completed=1) completed_lessons,
            (SELECT COALESCE(SUM(activity_seconds),0) FROM lesson_activity_totals a WHERE a.user_id=u.id) activity_seconds,
            (SELECT MAX(last_seen) FROM auth_sessions s WHERE s.user_id=u.id) last_seen
            FROM users u '''+where+' ORDER BY u.created_at DESC LIMIT ? OFFSET ?',(needle,needle,limit,offset)).fetchall()
    return {'users':[dict(r) for r in rows],'total':total,'offset':offset,'limit':limit}


@router.get('/api/admin/users/{uid}')
def user_detail(uid: str,request: Request):
    auth.require_admin(request)
    with connect() as db:
        user=db.execute('SELECT * FROM users WHERE id=?',(uid,)).fetchone()
        if not user:raise HTTPException(404,'User not found')
        result={'user':auth.public_user(user)}
        queries={
            'enrollments':('SELECT course,created_at FROM enrollments WHERE user_id=?',),
            'lessons':('''SELECT v.title,v.course,p.percent,p.completed,p.updated_at FROM video_progress p
                JOIN videos v ON v.id=p.video_id WHERE p.user_id=? ORDER BY p.updated_at DESC''',),
            'recent_lessons':('''SELECT v.title,l.course,l.updated_at FROM lesson_visits l JOIN videos v ON v.id=l.video_id
                WHERE l.user_id=? ORDER BY l.updated_at DESC''',),
            'assessments':('''SELECT a.step_id,t.score,t.correct_count,t.total_count,t.completed_at
                FROM topic_assessment_attempts t JOIN topic_assessments a ON a.id=t.assessment_id
                WHERE t.user_id=? ORDER BY t.completed_at DESC LIMIT 50''',),
            'labs':('SELECT id,slug,status,result_json,updated_at FROM lab_sessions WHERE user_id=? ORDER BY updated_at DESC LIMIT 50',),
            'sessions':('SELECT id,device,ip,created_at,last_seen,expires_at FROM auth_sessions WHERE user_id=? ORDER BY last_seen DESC',),
            'activity':('''SELECT e.event_type,e.details,e.created_at,v.title FROM learning_events e
                LEFT JOIN videos v ON v.id=e.video_id WHERE e.user_id=? ORDER BY e.id DESC LIMIT 100''',),
            'access':('SELECT event_type,ip,device,created_at FROM access_events WHERE user_id=? ORDER BY id DESC LIMIT 50',),
            'focus':('SELECT title,mode,status,duration_seconds,created_at,updated_at FROM focus_sessions WHERE user_id=? ORDER BY created_at DESC LIMIT 30',),
            'reviews':('SELECT quality,reviewed_at FROM review_attempts WHERE user_id=? ORDER BY reviewed_at DESC LIMIT 50',),
            'plans':('SELECT study_date,budget_minutes,updated_at FROM daily_plans WHERE user_id=? ORDER BY study_date DESC LIMIT 30',),
        }
        for key,(sql,) in queries.items():result[key]=[dict(r) for r in db.execute(sql,(uid,))]
        result['activity_seconds']=db.execute('SELECT COALESCE(SUM(activity_seconds),0) FROM lesson_activity_totals WHERE user_id=?',(uid,)).fetchone()[0]
        result['lesson_activity']=[dict(r) for r in db.execute('''SELECT v.title,v.course,t.activity_seconds,t.updated_at
            FROM lesson_activity_totals t JOIN videos v ON v.id=t.video_id WHERE t.user_id=? ORDER BY t.updated_at DESC''',(uid,))]
        result['note_count']=db.execute('SELECT COUNT(*) FROM video_notes WHERE user_id=?',(uid,)).fetchone()[0]
    from .native_player import playback_totals
    result['playback']=playback_totals(uid)
    return result


class AdminUserBody(BaseModel):
    name: str=Field(min_length=1,max_length=120)
    email: str=Field(max_length=254)
    password: str=Field(min_length=12,max_length=128)


@router.post('/api/admin/users',status_code=201)
def create_user(body: AdminUserBody,request: Request):
    auth.require_admin(request)
    email=auth.normalize_email(body.email);auth.validate_password(body.password)
    auth.require_mail_configuration()
    if not body.name.strip():raise HTTPException(422,'Enter a name')
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        if db.execute('SELECT 1 FROM users WHERE email=?',(email,)).fetchone():raise HTTPException(409,'Email is already registered')
        uid='usr_'+secrets.token_hex(16)
        db.execute('INSERT INTO users VALUES(?,?,?,?,?,0,0,?)',(uid,email,body.name.strip(),auth.hasher.hash(body.password),'student',utcnow()))
        token=auth.account_token(db,uid,'verify')
    auth.send_account_email(email,token,'verify')
    return {'user_id':uid,'message':'Account created. Verification email sent.'}


class AdminStatusBody(BaseModel):
    suspended: bool


@router.patch('/api/admin/users/{uid}')
def set_user_status(uid: str,body: AdminStatusBody,request: Request):
    admin=auth.require_admin(request)
    with connect() as db:
        row=db.execute('SELECT role FROM users WHERE id=?',(uid,)).fetchone()
        if not row:raise HTTPException(404,'User not found')
        if uid==admin['id'] or row['role']=='admin':raise HTTPException(409,'Administrator accounts cannot be suspended here')
        db.execute('UPDATE users SET suspended=? WHERE id=?',(int(body.suspended),uid))
        if body.suspended:db.execute('DELETE FROM auth_sessions WHERE user_id=?',(uid,))
    auth.access_event(request,'account_suspended' if body.suspended else 'account_restored',uid)
    return {'ok':True}


@router.delete('/api/admin/users/{uid}/sessions')
def revoke_user_sessions(uid: str,request: Request):
    auth.require_admin(request)
    with connect() as db:db.execute('DELETE FROM auth_sessions WHERE user_id=?',(uid,))
    auth.access_event(request,'admin_revoked_sessions',uid)
    return {'ok':True}


class EnrollmentBody(BaseModel):
    course: str=Field(min_length=1,max_length=200)
    enrolled: bool


@router.put('/api/admin/users/{uid}/enrollments')
def manage_enrollment(uid: str,body: EnrollmentBody,request: Request):
    auth.require_admin(request)
    try:course_metadata.get_course(body.course)
    except course_metadata.UnknownCourse:raise HTTPException(404,'Course not found')
    with connect() as db:
        if not db.execute('SELECT 1 FROM users WHERE id=?',(uid,)).fetchone():raise HTTPException(404,'User not found')
        if body.enrolled:db.execute('INSERT OR IGNORE INTO enrollments VALUES(?,?,?)',(uid,body.course,utcnow()))
        else:db.execute('DELETE FROM enrollments WHERE user_id=? AND course=?',(uid,body.course))
    return {'ok':True}


@router.get('/api/admin/courses')
def admin_courses(request: Request):
    auth.require_admin(request)
    records=course_metadata.list_courses()
    with connect() as db:
        for record in records:
            publication=db.execute('SELECT * FROM course_publication WHERE course=?',(record['id'],)).fetchone()
            record.update(dict(publication) if publication else {'published':0,'description':''})
            record['available_lessons']=db.execute('SELECT COUNT(*) FROM videos v JOIN lecture_providers p ON p.video_id=v.id WHERE v.course=?',(record['id'],)).fetchone()[0]
    return {'courses':records}


class PublicationBody(BaseModel):
    published: bool
    description: str=Field(default='',max_length=5000)


@router.put('/api/admin/courses/{course_id}/publication')
def publish_course(course_id: str,body: PublicationBody,request: Request):
    auth.require_admin(request)
    try:course_metadata.get_course(course_id)
    except course_metadata.UnknownCourse:raise HTTPException(404,'Course not found')
    with connect() as db:
        db.execute('''INSERT INTO course_publication VALUES(?,?,?,?) ON CONFLICT(course)
            DO UPDATE SET published=excluded.published,description=excluded.description,updated_at=excluded.updated_at''',
            (course_id,int(body.published),body.description.strip(),utcnow()))
    return {'published':body.published}


class ProviderBody(BaseModel):
    claim_name: str=Field(pattern=r'^[A-Za-z0-9_-]+$',max_length=200)
    claim_id: str=Field(pattern=r'^[0-9a-fA-F]{40}$')


@router.put('/api/admin/videos/{video_id}/provider')
def map_provider(video_id: str,body: ProviderBody,request: Request):
    auth.require_admin(request)
    if not fetch_video(video_id):raise HTTPException(404,'Video not found')
    with connect() as db:
        db.execute('''INSERT INTO lecture_providers VALUES(?,?,?,?) ON CONFLICT(video_id)
            DO UPDATE SET claim_name=excluded.claim_name,claim_id=excluded.claim_id,updated_at=excluded.updated_at''',
            (video_id,body.claim_name,body.claim_id,utcnow()))
    return {'ok':True}


def cleanup_records():
    now=datetime.now(timezone.utc)
    with connect() as db:
        db.execute('DELETE FROM access_events WHERE created_at<?',((now-timedelta(days=30)).isoformat(),))
        cutoff=(now-timedelta(days=90)).isoformat()
        db.execute('DELETE FROM learning_events WHERE created_at<?',(cutoff,))
        db.execute('DELETE FROM admin_audit WHERE created_at<?',(cutoff,))
        db.execute('DELETE FROM activity_sessions WHERE created_at<?',(cutoff,))
        db.execute('DELETE FROM activity_leases WHERE expires_at<?',(time.time(),))
        db.execute('DELETE FROM native_sessions WHERE created_at<?',(cutoff,))
        db.execute('DELETE FROM native_leases WHERE expires_at<?',(time.time(),))
        db.execute('DELETE FROM auth_sessions WHERE expires_at<?',(utcnow(),))
        db.execute('DELETE FROM account_tokens WHERE expires_at<?',(utcnow(),))
        db.execute('DELETE FROM playback_sessions WHERE expires_at<?',(utcnow(),))
        db.execute('DELETE FROM rate_limits WHERE reset_at<?',(time.time(),))


async def maintenance_loop():
    while True:
        try:
            await asyncio.to_thread(sync_provider_mappings)
            await asyncio.to_thread(cleanup_records)
        except Exception:
            log.exception('Academy maintenance failed')
        await asyncio.sleep(45)
