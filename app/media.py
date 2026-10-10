"""Odysee mapping refresh and account-bound embedded playback."""
import html
import json
import logging
import math
import os
import re
import secrets
import time
import threading
from pathlib import Path
from urllib.parse import quote, urlencode

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field

from . import auth
from .config import settings
from .db import connect, fetch_video, utcnow

router = APIRouter()
log = logging.getLogger(__name__)
_SIGNATURES: dict[tuple[str,str],tuple[float,str]] = {}
_SYNC_LOCK=threading.Lock()
CAPABILITIES = {'provider':'odysee','verified_playback_events':False,'automatic_resume':False,
                'programmatic_seek':False,'timestamp_launch':True,
                'completion_basis':'self_reported','time_basis':'visible_lesson_activity'}


def provider_info(video: dict) -> dict | None:
    with connect() as db:
        row = db.execute('SELECT claim_name,claim_id FROM lecture_providers WHERE video_id=?',(video['id'],)).fetchone()
    return dict(row) if row else None


def sync_provider_mappings():
    if not _SYNC_LOCK.acquire(blocking=False):
        return {'in_progress':True}
    try:
        report=_sync_provider_mappings()
        from .admin_console import service_check
        service_check('odysee_sync',report,report.get('error',''))
        return report
    finally:
        _SYNC_LOCK.release()


def _sync_provider_mappings():
    """Run in maintenance only. Preserve mappings on provider failure."""
    entries = []
    error='';changed=0;durations=0
    for path in (settings.data_dir/'odysee_manifest.json',settings.courses_dir/'odysee_manifest.json'):
        if path.is_file():
            try:
                manifest=json.loads(path.read_text())
                for source,entry in manifest.items():
                    if isinstance(entry,dict):entries.append(dict(entry,source=source))
            except (OSError,ValueError,AttributeError):
                log.warning('Cannot read Odysee manifest; keeping existing mappings')
    token=os.getenv('ODYSEE_AUTH_TOKEN','')
    if token:
        try:
            with httpx.Client(timeout=8) as client:
                for page in range(1,21):
                    response=client.post('https://api.na-backend.odysee.com/api/v1/proxy?m=stream_list',
                        headers={'X-Lbry-Auth-Token':token},json={'jsonrpc':'2.0','id':1,'method':'stream_list',
                        'params':{'page':page,'page_size':250}})
                    response.raise_for_status()
                    payload=response.json()
                    if payload.get('error'):raise ValueError('Provider rejected mapping refresh')
                    items=(payload.get('result') or {}).get('items',[])
                    for item in items:
                        value=item.get('value') or {}
                        entries.append({'claim_id':item.get('claim_id'),'claim_name':item.get('name'),
                                        'title':value.get('title',''),'duration':(value.get('video') or value.get('audio') or {}).get('duration')})
                    if len(items)<250:break
        except (httpx.HTTPError,ValueError,TypeError):
            log.warning('Odysee refresh unavailable; keeping existing mappings')
            error='Odysee could not refresh uploads. Existing mappings have been preserved.'
    else:
        error='Odysee account credentials are not configured.'
    with connect() as db:
        videos=[dict(r) for r in db.execute('SELECT id,course,title,path FROM videos')]
        for entry in entries:
            name,cid=entry.get('claim_name',''),entry.get('claim_id','')
            if not isinstance(name,str) or not isinstance(cid,str) or not re.fullmatch(r'[A-Za-z0-9_-]+',name) or not re.fullmatch(r'[0-9a-fA-F]{40}',cid):continue
            source=entry.get('source','')
            title=entry.get('title') or Path(source).stem
            candidates=[v for v in videos if entry.get('video_id')==v['id'] or
                        (v['title']==title and (not entry.get('course') or entry['course']==v['course'])) or
                        (Path(v['path']).name==Path(source).name and source)]
            if len(candidates)!=1:
                match=re.match(r'\[(\d{3})\]',title)
                # Course-specific prefixes are only an import fallback; the
                # resulting mapping is persisted against an immutable video ID.
                prefix='agentic-genai-' if name.startswith('agentic-genai-') else 'mission-ade-2026-' if name.startswith('mission-ade-2026-') else None
                if match and prefix:
                    course='Advanced Agentic AI And Gen AI By Prudhvi Sir Nareshit 2026' if prefix=='agentic-genai-' else 'Deepak Data Engg'
                    candidates=[v for v in videos if v['course']==course and v['title'].startswith(f'[{match[1]}]')]
            if len(candidates)==1:
                vid=candidates[0]['id']
                previous=db.execute('SELECT claim_name,claim_id FROM lecture_providers WHERE video_id=?',(vid,)).fetchone()
                if not previous or previous['claim_name']!=name or previous['claim_id']!=cid:
                    db.execute('''INSERT INTO lecture_providers VALUES(?,?,?,?) ON CONFLICT(video_id)
                        DO UPDATE SET claim_name=excluded.claim_name,claim_id=excluded.claim_id,updated_at=excluded.updated_at''',
                        (vid,name,cid,utcnow()));changed+=1
                try:duration=float(entry.get('duration'))
                except (TypeError,ValueError):duration=0
                if math.isfinite(duration) and 0<duration<1e7:
                    durations+=db.execute('UPDATE videos SET duration=? WHERE id=? AND (duration IS NULL OR duration<=0)',(duration,vid)).rowcount
        total=db.execute('SELECT COUNT(*) FROM videos').fetchone()[0]
        mapped=db.execute('SELECT COUNT(*) FROM lecture_providers').fetchone()[0]
    return {'mapped':mapped,'lectures':total,'mappings_updated':changed,'durations_added':durations,'error':error}


def signed_embed(info: dict) -> str:
    key=(info['claim_name'],info['claim_id']);now=time.time()
    cached=_SIGNATURES.get(key)
    if cached and cached[0]>now:return cached[1]
    token=os.getenv('ODYSEE_AUTH_TOKEN','');channel=os.getenv('ODYSEE_CHANNEL_ID','')
    if not token or not channel:
        raise HTTPException(503,'Odysee playback is not configured. Please contact the administrator.')
    try:
        with httpx.Client(timeout=8) as client:
            response=client.post('https://api.na-backend.odysee.com/api/v1/proxy?m=channel_sign',
                headers={'X-Lbry-Auth-Token':token},json={'jsonrpc':'2.0','id':1,'method':'channel_sign',
                    'params':{'channel_id':channel,'hexdata':info['claim_id'].encode().hex()}})
            response.raise_for_status();result=response.json().get('result') or {}
            if not result.get('signature') or not result.get('signing_ts'):raise ValueError('No signature')
            url=f"https://odysee.com/$/embed/{quote(info['claim_name'],safe='')}/{quote(info['claim_id'],safe='')}?"+urlencode({'signature':result['signature'],'signature_ts':result['signing_ts']})
            _SIGNATURES[key]=(now+120,url)
            return url
    except (httpx.HTTPError,ValueError,TypeError) as exc:
        raise HTTPException(503,'Odysee could not authorize this lecture. Please retry shortly.') from exc


class PlaybackBody(BaseModel):
    start_pos: float = Field(default=0,ge=0,lt=1e9,allow_inf_nan=False)


@router.get('/api/videos/{video_id}/player-capabilities')
def capabilities(video_id: str):
    if not fetch_video(video_id):raise HTTPException(404,'Video not found')
    return CAPABILITIES


@router.post('/api/videos/{video_id}/vault-session')
@router.post('/api/videos/{video_id}/playback-session')
def create_playback(video_id: str, body: PlaybackBody, request: Request):
    user=auth.require_user(request)
    video=fetch_video(video_id)
    if not video:raise HTTPException(404,'Video not found')
    info=provider_info(video)
    from .academy import learning_event
    if not info:
        learning_event(user['id'],'playback_unavailable',video_id,'Upload pending')
        raise HTTPException(409,'This lecture has not been mapped to an Odysee upload yet')
    auth.rate_limit('playback:'+user['id'],60,60)
    # Report provider errors in the lesson UI, where learners can retry them.
    try:signed_embed(info)
    except HTTPException:
        learning_event(user['id'],'playback_authorization_failed',video_id,'Provider authorization unavailable')
        raise
    token=secrets.token_urlsafe(32)
    with connect() as db:
        db.execute('INSERT INTO playback_sessions VALUES(?,?,?,?,?,?,0)',
            ('pb_'+secrets.token_hex(16),user['id'],user['session_id'],video_id,auth.digest(token),auth.expiry(1)))
        # Actual frame issuance has a short TTL, independent of the login TTL.
        db.execute("UPDATE playback_sessions SET expires_at=strftime('%Y-%m-%dT%H:%M:%S+00:00','now','+2 minutes') WHERE token_hash=?",(auth.digest(token),))
    learning_event(user['id'],'player_authorized',video_id)
    watermark=f"{user['name']} · {user['id'][-6:]}"
    return {'vault_url':f'/api/videos/{video_id}/vault-frame?t={token}&start={round(body.start_pos,3)}',
            'watermark':watermark,'capabilities':CAPABILITIES}


@router.get('/api/videos/{video_id}/vault-frame')
def playback_frame(video_id: str,t: str,request: Request,start: float=0):
    user=auth.require_user(request)
    video=fetch_video(video_id)
    if not video:raise HTTPException(404,'Video not found')
    if len(t)>100:raise HTTPException(403,'Invalid playback session')
    if not math.isfinite(start) or not 0<=start<1e9:raise HTTPException(422,'Invalid lesson timestamp')
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        row=db.execute('''SELECT id FROM playback_sessions WHERE token_hash=? AND user_id=?
            AND auth_session_id=? AND video_id=? AND consumed=0 AND expires_at>?''',
            (auth.digest(t),user['id'],user['session_id'],video_id,utcnow())).fetchone()
        if not row:raise HTTPException(403,'Playback session expired. Reopen the lesson.')
        db.execute('UPDATE playback_sessions SET consumed=1 WHERE id=?',(row['id'],))
    info=provider_info(video)
    if not info:raise HTTPException(409,'Lecture upload unavailable')
    url=html.escape(signed_embed(info)+'&'+urlencode({'t':round(start,3)}),quote=True)
    from .academy import learning_event
    learning_event(user['id'],'player_frame_opened',video_id,f'Start requested: {round(start,3)}s')
    watermark=html.escape(f"{user['name']} · {user['id'][-6:]}")
    page=f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>CourseForge lesson player</title><style>html,body{{margin:0;width:100%;height:100%;background:#090e19}}iframe{{width:100%;height:100%;border:0}}.mark{{position:absolute;top:12%;right:5%;pointer-events:none;background:#1119;color:#fffc;padding:5px 9px;border-radius:5px;font:11px system-ui;animation:float 24s ease-in-out infinite alternate}}@keyframes float{{to{{top:68%;right:24%}}}}@media(prefers-reduced-motion:reduce){{.mark{{animation:none}}}}</style></head>
    <body><iframe title="Odysee lecture" src="{url}" allow="autoplay;fullscreen;encrypted-media" allowfullscreen></iframe><div class="mark">{watermark}</div></body></html>'''
    return HTMLResponse(page,headers={'Cache-Control':'no-store','X-Frame-Options':'SAMEORIGIN',
        'Content-Security-Policy':"default-src 'none'; frame-src https://odysee.com; style-src 'unsafe-inline'; frame-ancestors 'self'",'Referrer-Policy':'no-referrer'})
