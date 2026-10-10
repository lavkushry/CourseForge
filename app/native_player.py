"""Authorized Odysee byte ranges and browser-reported playback accounting.

Provider URLs stay on the server. This is access control, not encrypted DRM.
Watching is measured from browser events and cannot establish attention.
"""
import asyncio
import json
import math
import re
import secrets
import threading
import time
from typing import Literal
from urllib.parse import urljoin, urlsplit, parse_qs

import httpx
from fastapi import APIRouter, HTTPException, Request, Query
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask
from starlette.concurrency import run_in_threadpool

from . import auth, media, player_sessions
from .db import connect, fetch_video, utcnow

router = APIRouter()
_SOURCES = {}
_SOURCE_LOCKS = tuple(threading.Lock() for _ in range(64))
CDN_HOSTS = frozenset({'secure.odycdn.com', 'player.odycdn.com'})
CAPABILITIES = dict(media.CAPABILITIES, mode='native', automatic_resume=True,
    programmatic_seek=True, playback_events=True, time_basis='browser_reported_playback')


def validate_source(url):
    try:
        parsed = urlsplit(url)
        valid = (parsed.scheme == 'https' and parsed.hostname in CDN_HOSTS and
                 parsed.port in (None, 443) and not parsed.username and not parsed.password)
    except (ValueError, TypeError):
        valid = False
    if not valid:
        raise HTTPException(503, 'The video provider returned an unsupported media address.')
    return url


def source_for(info):
    key = (info['claim_name'], info['claim_id'])
    # Share short-lived authorization across byte-range requests. No media is
    # cached and the provider's access signature never enters a public response.
    with _SOURCE_LOCKS[hash(key)%len(_SOURCE_LOCKS)]:
        cached = _SOURCES.get(key)
        if cached and cached[0] > time.time():
            return cached[1:]
        embed = media.signed_embed(info)
        signature = {k:v[0] for k,v in parse_qs(urlsplit(embed).query).items()}
        try:
            with httpx.Client(timeout=10) as client:
                result=media.sdk_call(client,'get',{'uri':f"lbry://{info['claim_name']}#{info['claim_id']}", **signature})
                source=validate_source(result.get('streaming_url'))
                # Odysee prepares a stream with HEAD before serving ranges;
                # requesting bytes first can return 429 for a cold upload.
                # Follow only approved CDN redirects and stop on rate limits.
                for hop in range(4):
                    probe=client.head(source,headers={'Referer':embed,'Origin':'https://odysee.com',
                        'User-Agent':'CourseForge/0.4'},timeout=25)
                    if probe.status_code in (301,302,303,307,308):
                        source=validate_source(urljoin(source,probe.headers.get('location','')))
                        continue
                    if probe.status_code>=400:
                        raise HTTPException(503,'Odysee is preparing this lecture. Retry shortly or use the embedded player.',headers={'Retry-After':'30'})
                    if not probe.headers.get('content-type','').split(';')[0].startswith(('video/','audio/','application/octet-stream')):
                        raise HTTPException(503,'This video format requires the embedded player.')
                    break
                else:raise HTTPException(503,'Odysee media preparation did not finish. Retry shortly.')
        except (httpx.HTTPError, ValueError, TypeError, AttributeError):
            raise HTTPException(503, 'Odysee could not authorize media. Retry or use the embedded player.') from None
        if len(_SOURCES) >= 512:
            _SOURCES.clear()
        _SOURCES[key] = (time.time()+120, source, embed)
        return source, embed


@router.post('/api/videos/{video_id}/native-session', status_code=201)
def create_native(video_id: str, body: media.PlaybackBody, request: Request):
    user = auth.require_user(request)
    video = fetch_video(video_id)
    if not video:raise HTTPException(404, 'Video not found')
    info = media.provider_info(video)
    if not info:raise HTTPException(409, 'This lecture is awaiting its Odysee upload.')
    auth.rate_limit('native-open:'+user['id'], 60, 60)
    psid=player_sessions.binding(video_id,'native',body.player_session_id,request)
    try:source_for(info)
    except HTTPException:
        from .academy import learning_event
        learning_event(user['id'],'playback_authorization_failed',video_id,'Provider authorization unavailable')
        raise
    token = secrets.token_urlsafe(32); sid = 'np_'+secrets.token_hex(16)
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        if not player_sessions.is_owner(db,psid):raise HTTPException(409,'Playback ownership expired. Reopen the lesson.')
        db.execute("UPDATE native_sessions SET closed=1,state='closed' WHERE player_session_id=?",(psid,))
        db.execute('DELETE FROM native_leases WHERE user_id=?',(user['id'],))
        db.execute("UPDATE player_sessions SET mode='native' WHERE id=?",(psid,))
        db.execute('''INSERT INTO native_sessions(id,user_id,auth_session_id,video_id,token_hash,
            expires_at,created_at,device,ip,last_heartbeat,position,duration,player_session_id)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)''',
            (sid,user['id'],user['session_id'],video_id,auth.digest(token),auth.expiry(6),utcnow(),
             request.headers.get('user-agent','')[:220],auth.client_ip(request),time.time(),body.start_pos,video['duration'] or 0,psid))
    from .academy import learning_event
    learning_event(user['id'],'native_player_opened',video_id)
    return {'id':sid,'player_session_id':psid,'media_url':f'/api/videos/{video_id}/media/{sid}?t={token}',
            'start_pos':body.start_pos,'watermark':f"{user['name']} · {user['id'][-6:]}",
            'capabilities':CAPABILITIES}


def authorize_media(video_id, sid, token, request):
    user = auth.require_user(request)
    video = fetch_video(video_id)
    if not video:raise HTTPException(404, 'Video not found')
    if len(token)>100:raise HTTPException(403, 'Invalid media session')
    with connect() as db:
        valid = db.execute('''SELECT id,player_session_id FROM native_sessions WHERE id=? AND token_hash=? AND user_id=?
            AND auth_session_id=? AND video_id=? AND expires_at>? AND closed=0''',
            (sid,auth.digest(token),user['id'],user['session_id'],video_id,utcnow())).fetchone()
        active=bool(valid and player_sessions.is_owner(db,valid['player_session_id']))
    if not active:raise HTTPException(403, 'Media session expired. Reopen the lesson.')
    info = media.provider_info(video)
    if not info:raise HTTPException(409, 'Lecture upload unavailable')
    return source_for(info)


def stream_session_active(sid):
    with connect() as db:
        row=db.execute('''SELECT n.user_id,u.role,v.course,n.player_session_id FROM native_sessions n
            JOIN auth_sessions s ON s.id=n.auth_session_id JOIN users u ON u.id=n.user_id
            JOIN videos v ON v.id=n.video_id WHERE n.id=? AND n.closed=0 AND n.expires_at>?
            AND s.expires_at>? AND u.verified=1 AND u.suspended=0''',(sid,utcnow(),utcnow())).fetchone()
        if not row or not player_sessions.is_owner(db,row['player_session_id']):return False
        if row['role']=='admin':return True
        return bool(db.execute('''SELECT 1 FROM enrollments e JOIN course_publication p ON p.course=e.course
            WHERE e.user_id=? AND e.course=? AND p.published=1''',(row['user_id'],row['course'])).fetchone())


@router.api_route('/api/videos/{video_id}/media/{sid}', methods=['GET','HEAD'])
async def media_bytes(video_id: str, sid: str, request: Request, t: str=Query(max_length=100)):
    source, embed = await run_in_threadpool(authorize_media, video_id, sid, t, request)
    if not await run_in_threadpool(stream_session_active,sid):
        raise HTTPException(403,'Playback ownership ended. Reopen the lesson.')
    range_value = request.headers.get('range','bytes=0-')
    if not re.fullmatch(r'bytes=(?:\d{1,16}-\d{0,16}|-\d{1,16})', range_value):
        raise HTTPException(416, 'One byte range is supported per request.')
    slots = getattr(request.app.state, 'media_slots', None)
    if slots:
        try:await asyncio.wait_for(slots.acquire(), timeout=2)
        except TimeoutError:raise HTTPException(503, 'Video capacity is busy. Retry shortly.', headers={'Retry-After':'5'}) from None
    client = httpx.AsyncClient(timeout=httpx.Timeout(20,connect=8),trust_env=False)
    upstream = None; closed = False
    async def cleanup():
        nonlocal closed
        if closed:return
        closed=True
        if upstream:await upstream.aclose()
        await client.aclose()
        if slots:slots.release()
    try:
        # Follow only provider CDN redirects; never forward a credential to an
        # arbitrary host. Client URLs and request cookies are not forwarded.
        for hop in range(4):
            validate_source(source)
            upstream = await client.send(client.build_request(request.method,source,headers={
                'Range':range_value,'User-Agent':request.headers.get('user-agent','')[:512],
                'Referer':embed,'Origin':'https://odysee.com','Accept-Encoding':'identity'}),stream=True)
            if upstream.status_code not in (301,302,303,307,308):break
            target = urljoin(source,upstream.headers.get('location',''))
            await upstream.aclose();upstream=None
            source=validate_source(target)
        if upstream is None or upstream.status_code not in (200,206,416):
            raise HTTPException(503, 'Odysee media is temporarily unavailable. Retry or use the embedded player.',headers={'Retry-After':'30'})
        headers = {k:upstream.headers[k] for k in ('content-length','content-range','accept-ranges','content-type') if k in upstream.headers}
        headers.update({'Cache-Control':'no-store','Referrer-Policy':'no-referrer'})
        if request.method=='HEAD' or upstream.status_code==416:
            status=upstream.status_code
            await cleanup()
            # A 416 provider body is not relayed; retain its size information.
            if status==416:headers.pop('content-length',None)
            return Response(status_code=status,headers=headers)
        if not headers.get('content-type','').split(';')[0].startswith(('video/','audio/','application/octet-stream')):
            raise HTTPException(503,'The provider did not return video media.')
        async def chunks():
            checked=time.monotonic()
            try:
                async for chunk in upstream.aiter_raw(chunk_size=128*1024):
                    if time.monotonic()-checked>=10:
                        if not await run_in_threadpool(stream_session_active,sid):return
                        checked=time.monotonic()
                    yield chunk
            except httpx.HTTPError:
                # Streaming headers have already been sent. End the response;
                # the player's error UI handles retry without logging secrets.
                return
            finally:await cleanup()
        return StreamingResponse(chunks(),status_code=upstream.status_code,headers=headers,
                                 background=BackgroundTask(cleanup))
    except BaseException as exc:
        await cleanup()
        if isinstance(exc,httpx.HTTPError):
            raise HTTPException(503,'Odysee media could not be reached. Retry shortly.') from None
        raise


class PlaybackEvent(BaseModel):
    sequence: int=Field(ge=1,le=10**9)
    event: Literal['playing','pause','seeking','seeked','waiting','ended','error','heartbeat','hidden','closed','ratechange','ready']
    position: float=Field(ge=0,lt=1e7,allow_inf_nan=False)
    duration: float=Field(ge=0,lt=1e7,allow_inf_nan=False)
    elapsed_seconds: float=Field(ge=0,le=20,allow_inf_nan=False)
    rate: float=Field(default=1,ge=.25,le=4,allow_inf_nan=False)
    playback_state: Literal['playing','pause','waiting','hidden'] | None = None


def merge_range(ranges, start, end):
    if end<=start:return ranges
    merged=[]
    for a,b in sorted(ranges+[[round(start,3),round(end,3)]]):
        if merged and a<=merged[-1][1]+.25:merged[-1][1]=max(merged[-1][1],b)
        else:merged.append([a,b])
    # Bound storage even after years of fragmented seeks. Discarding tiny
    # intervals can only undercount coverage; it never invents watched content.
    if len(merged)>2000:merged=sorted(sorted(merged,key=lambda r:r[1]-r[0],reverse=True)[:2000])
    return merged


@router.post('/api/player/{sid}/events')
def record_event(sid: str, body: PlaybackEvent, request: Request):
    user=auth.require_user(request);now=time.time()
    auth.rate_limit('player-events:'+user['id'],180,60)
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        row=db.execute('''SELECT n.*,v.course,v.duration measured_duration FROM native_sessions n
            JOIN videos v ON v.id=n.video_id WHERE n.id=? AND n.user_id=? AND n.auth_session_id=?''',
            (sid,user['id'],user['session_id'])).fetchone()
        if not row:raise HTTPException(404,'Player session not found')
        auth.require_course(user,row['course'])
        total=db.execute('SELECT * FROM native_totals WHERE user_id=? AND video_id=?',
            (user['id'],row['video_id'])).fetchone()
        ranges=json.loads(total['ranges_json']) if total else []
        lease=db.execute('SELECT * FROM native_leases WHERE user_id=?',(user['id'],)).fetchone()
        if not player_sessions.is_owner(db,row['player_session_id']):
            return {'accepted':False,'reason':'ownership_lost','tracking_active':False,'resume_saved':False}
        if body.event not in ('hidden','closed'):
            db.execute('UPDATE player_ownership SET expires_at=? WHERE session_id=?',(now+player_sessions.LEASE_SECONDS,row['player_session_id']))
        eligible=not lease or lease['expires_at']<=now or lease['session_id']==sid
        if row['closed'] or row['expires_at']<=utcnow() or body.sequence<=row['last_sequence']:
            reason=('closed' if row['closed'] else 'expired' if row['expires_at']<=utcnow()
                    else 'duplicate' if body.sequence==row['last_sequence'] else 'out_of_order')
            return {'accepted':False,'reason':reason,'playing_seconds':row['playing_seconds'],
                'position':row['position'],'coverage_percent':min(100,math.floor(
                    sum(b-a for a,b in ranges)/row['duration']*100)) if row['duration'] else 0,
                'tracking_active':reason=='duplicate' and eligible and row['state']=='playing',
                'resume_saved':reason=='duplicate' and eligible and row['state']!='standby',
                'basis':'browser_reported_playback'}
        duration=row['measured_duration'] or body.duration or row['duration']
        position=min(body.position,duration) if duration else body.position
        gap=now-row['last_heartbeat'];advance=position-row['position']
        # A seek can update resume position, but not watched coverage. Playback
        # must move at the declared rate within a normal server heartbeat gap.
        seconds=0
        if eligible and body.event!='seeking' and row['state']=='playing' and 0<gap<=30 and 0<advance<=min(gap,20)*body.rate+1:
            seconds=min(body.elapsed_seconds,gap,advance/body.rate,20)
        state = ((body.playback_state or row['state']) if body.event in ('heartbeat','ratechange')
                 else 'pause' if body.event=='seeked' else body.event)
        # A waiting tab must establish its own baseline before gaining time.
        # Otherwise its first heartbeat after takeover can double-count the
        # interval already recorded by the previous lease holder.
        if state=='standby':state='playing'
        if state=='playing' and not eligible:state='standby'
        closed=body.event=='closed'
        if eligible and not closed and state=='playing':
            db.execute('''INSERT INTO native_leases VALUES(?,?,?) ON CONFLICT(user_id)
                DO UPDATE SET session_id=excluded.session_id,expires_at=excluded.expires_at''',(user['id'],sid,now+20))
        elif state!='playing':db.execute('DELETE FROM native_leases WHERE user_id=? AND session_id=?',(user['id'],sid))
        db.execute('''UPDATE native_sessions SET last_sequence=?,last_heartbeat=?,position=?,duration=?,
            state=?,playing_seconds=playing_seconds+?,closed=? WHERE id=?''',
            (body.sequence,now,position,duration,state,seconds,int(closed),sid))
        if closed:db.execute('DELETE FROM native_leases WHERE user_id=? AND session_id=?',(user['id'],sid))
        if seconds:ranges=merge_range(ranges,max(row['position'],position-seconds*body.rate),position)
        # Another tab cannot overwrite the active tab's resume position.
        if eligible:
            db.execute('''INSERT INTO native_totals VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id,video_id)
                DO UPDATE SET playing_seconds=playing_seconds+excluded.playing_seconds,position=excluded.position,
                duration=excluded.duration,ranges_json=excluded.ranges_json,updated_at=excluded.updated_at''',
                (user['id'],row['video_id'],seconds,position,duration,json.dumps(ranges),utcnow()))
            # Completion remains an explicit learner action; coverage and
            # playback position update independently of completed status.
            coverage=min(100,math.floor(sum(b-a for a,b in ranges)/duration*100)) if duration else 0
            db.execute('''INSERT INTO video_progress(user_id,video_id,percent,position,completed,updated_at)
                VALUES(?,?,?,?,0,?) ON CONFLICT(user_id,video_id) DO UPDATE SET position=excluded.position,
                percent=CASE WHEN completed=1 THEN 100 ELSE excluded.percent END,updated_at=excluded.updated_at''',
                (user['id'],row['video_id'],coverage,position,utcnow()))
        if body.event not in ('heartbeat','ready'):
            db.execute('INSERT INTO learning_events(user_id,video_id,event_type,details,created_at) VALUES(?,?,?,?,?)',
                (user['id'],row['video_id'],'player_'+body.event,f'{position:.1f}s',utcnow()))
    return {'accepted':True,'playing_seconds':row['playing_seconds']+seconds,'position':position,
            'tracking_active':eligible and state=='playing','resume_saved':eligible,
            'coverage_percent':min(100,math.floor(sum(b-a for a,b in ranges)/duration*100)) if duration else 0,
            'basis':'browser_reported_playback'}


def playback_totals(uid):
    with connect() as db:
        rows=[dict(r) for r in db.execute('''SELECT t.*,v.title,v.course FROM native_totals t
            JOIN videos v ON v.id=t.video_id WHERE t.user_id=? ORDER BY t.updated_at DESC''',(uid,))]
    for r in rows:
        ranges=json.loads(r.pop('ranges_json'))
        r['coverage_percent']=min(100,math.floor(sum(b-a for a,b in ranges)/r['duration']*100)) if r['duration'] else 0
    return rows


@router.get('/api/me/playback')
def my_playback(request: Request):
    user=auth.require_user(request)
    return {'lessons':playback_totals(user['id']),'basis':'browser_reported_playback'}


_LIVE_PLAYBACK = '''EXISTS (SELECT 1 FROM player_ownership po JOIN player_sessions ps ON ps.id=po.session_id
    WHERE ps.id=n.player_session_id AND ps.closed=0 AND po.expires_at>?) AND n.closed=0 AND n.state='playing' AND l.session_id=n.id AND l.expires_at>?
    AND s.expires_at>? AND u.verified=1 AND u.suspended=0 AND (u.role='admin' OR EXISTS (
        SELECT 1 FROM enrollments e JOIN course_publication p ON p.course=e.course
        WHERE e.user_id=n.user_id AND e.course=v.course AND p.published=1))'''


@router.get('/api/admin/playback')
def playback_report(request: Request, days: int=Query(30,ge=1,le=90),q: str=Query('',max_length=120),
                    offset: int=Query(0,ge=0),limit: int=Query(25,ge=1,le=100),
                    course: str=Query('',max_length=200),status: Literal['all','live']='all'):
    auth.require_admin(request)
    from datetime import datetime,timezone,timedelta
    cutoff=(datetime.now(timezone.utc)-timedelta(days=days)).isoformat()
    needle='%'+q.replace('\\','\\\\').replace('%','\\%').replace('_','\\_')+'%'
    joins='''FROM native_sessions n JOIN users u ON u.id=n.user_id JOIN videos v ON v.id=n.video_id
        LEFT JOIN native_leases l ON l.user_id=n.user_id LEFT JOIN auth_sessions s ON s.id=n.auth_session_id'''
    where=" WHERE n.created_at>=? AND (u.name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\' OR v.title LIKE ? ESCAPE '\\')"
    args=[cutoff,needle,needle,needle]
    if course:where+=' AND v.course=?';args.append(course)
    if status=='live':
        where+=' AND ('+_LIVE_PLAYBACK+')'
        args.extend([time.time(),time.time(),utcnow()])
    with connect() as db:
        count=db.execute('SELECT COUNT(*) '+joins+where,args).fetchone()[0]
        rows=[dict(r) for r in db.execute('''SELECT n.id,n.user_id,u.name,u.email,v.title,v.course,n.state,
            n.playing_seconds,n.position,n.duration,n.device,n.ip,n.created_at,
            COALESCE(('''+_LIVE_PLAYBACK+'''),0) live '''+
            joins+where+' ORDER BY n.created_at DESC LIMIT ? OFFSET ?',(time.time(),time.time(),utcnow(),*args,limit,offset))]
    return {'sessions':rows,'total':count,'offset':offset,'basis':'Browser-reported playback; does not establish attention.'}


@router.get('/api/admin/playback/export')
def export_playback(request: Request, days: int=Query(30,ge=1,le=90),q: str=Query('',max_length=120),
                    course: str=Query('',max_length=200),status: Literal['all','live']='all'):
    import csv
    import io
    from .admin_console import csv_cell,audit
    admin=auth.require_admin(request)
    auth.rate_limit('playback-export:'+admin['id'],10,3600)
    report=playback_report(request,days,q,0,10001,course,status)
    if report['total']>10000:raise HTTPException(413,'Narrow the report to export up to 10,000 sessions.')
    output=io.StringIO();writer=csv.writer(output)
    writer.writerow(['Student','Email','Lecture','Course','Browser-reported playback seconds','Position seconds',
                     'Duration seconds','State','Session opened (UTC)','Device','IP'])
    for row in report['sessions']:
        writer.writerow([csv_cell(row[k]) for k in ('name','email','title','course','playing_seconds','position','duration','state','created_at','device','ip')])
    audit(admin['id'],'playback_exported',f'{report["total"]} sessions / {days} days')
    return Response(output.getvalue(),media_type='text/csv',headers={'Content-Disposition':'attachment; filename="courseforge-playback.csv"'})
