"""Local-only FastAPI app. Never bind this API to a public interface without auth."""
from pathlib import Path
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from pydantic import BaseModel, Field, field_validator

from .config import settings
from .db import (init_db, fetch_videos, fetch_video, fetch_jobs, queue_video,
                 transcript_for_video, frame_for_chunk)
from .library import scan_courses
from .tutor import ask, retrieve
from . import syllabus, study, labs, reviews, studio, course_metadata, learning_paths, assessments, practice, planner, weekly, focus

@asynccontextmanager
async def lifespan(_app: FastAPI):
    settings.courses_dir.mkdir(parents=True, exist_ok=True)
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    init_db()
    yield


app = FastAPI(title='CourseForge Local', version='0.3.0', docs_url='/api/docs',
              redoc_url=None, lifespan=lifespan)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=['*'])

@app.middleware('http')
async def guard_local_actions(request: Request, call_next):
    return await call_next(request)

static_path = Path(__file__).parent / 'static'
app.mount('/static', StaticFiles(directory=static_path), name='static')


@app.get('/')
def index():
    return FileResponse(static_path / 'index.html')


@app.get('/api/health')
def health():
    return {'status': 'ok', 'courses_dir': str(settings.courses_dir), 'data_dir': str(settings.data_dir),
            'chat_model': settings.chat_model, 'embed_model': settings.embed_model,
            'vision_model': settings.vision_model, 'vision_enabled': settings.enable_vision}


@app.post('/api/scan')
def scan():
    return scan_courses()


@app.get('/api/videos')
def videos():
    vids = fetch_videos()
    for v in vids:
        info = find_odysee_info(v)
        v['cloud_ready'] = bool(info)
        v.pop('path', None)
    return {'videos': vids}


@app.get('/api/courses')
def courses_catalog():
    return {'courses': course_metadata.list_courses()}


class CourseMetadataBody(BaseModel):
    title: str | None = Field(default=None, max_length=160)
    instructor: str | None = Field(default=None, max_length=120)
    category: str | None = Field(default=None, max_length=80)
    tags: list[str] = Field(default_factory=list, max_length=12)

    @field_validator('tags')
    @classmethod
    def validate_tags(cls, tags: list[str]) -> list[str]:
        cleaned = [tag.strip() for tag in tags]
        if any(not tag or len(tag) > 32 for tag in cleaned):
            raise ValueError('Tags must contain 1–32 characters')
        if len({tag.casefold() for tag in cleaned}) != len(cleaned):
            raise ValueError('Tags must be unique')
        return cleaned


@app.patch('/api/courses/{course_id}')
def edit_course(course_id: str, body: CourseMetadataBody):
    try:
        return course_metadata.save_course(course_id, body.model_dump(exclude_unset=True))
    except course_metadata.UnknownCourse:
        raise HTTPException(404, 'Course not found')


@app.get('/api/courses/{course_id}/cover')
def course_cover(course_id: str):
    try:
        cover = course_metadata.get_or_generate_cover(course_id)
    except course_metadata.UnknownCourse:
        raise HTTPException(404, 'Course not found')
    if not cover:
        raise HTTPException(404, 'No video frame available for thumbnail')
    return FileResponse(cover, media_type='image/jpeg', headers={'Cache-Control': 'private, no-store'})


@app.put('/api/courses/{course_id}/cover')
async def upload_course_cover(course_id: str, request: Request):
    if request.headers.get('content-type', '').split(';')[0] not in course_metadata.ALLOWED_MIME:
        raise HTTPException(415, 'Use a JPEG, PNG or WebP image')
    # Abort oversized requests while streaming; never buffer unbounded uploads.
    parts, size = [], 0
    async for part in request.stream():
        size += len(part)
        if size > course_metadata.MAX_IMAGE_BYTES:
            raise HTTPException(413, 'Cover must be smaller than 4 MiB')
        parts.append(part)
    try:
        course_metadata.set_cover(course_id, b''.join(parts), request.headers['content-type'].split(';')[0])
    except course_metadata.UnknownCourse:
        raise HTTPException(404, 'Course not found')
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return course_metadata.get_course(course_id)


@app.delete('/api/courses/{course_id}/cover')
def remove_course_cover(course_id: str):
    try:
        course_metadata.reset_cover(course_id)
    except course_metadata.UnknownCourse:
        raise HTTPException(404, 'Course not found')
    return {'cover_kind': None}


@app.get('/api/jobs')
def jobs():
    return {'jobs': fetch_jobs()}


@app.post('/api/videos/{video_id}/reindex')
def reindex(video_id: str):
    if not fetch_video(video_id):
        raise HTTPException(status_code=404, detail='Video not found')
    added = queue_video(video_id)
    return {'queued': added, 'message': 'Already queued or in progress' if not added else 'Reindex queued'}


def _ensure_tracking_tables() -> None:
    from .db import connect
    with connect() as conn:
        conn.executescript('''
        CREATE TABLE IF NOT EXISTS viewer_sessions (
            viewer_id TEXT PRIMARY KEY,
            viewer_name TEXT NOT NULL,
            ip TEXT NOT NULL,
            country TEXT NOT NULL,
            user_agent TEXT NOT NULL,
            screen TEXT NOT NULL,
            timezone TEXT NOT NULL,
            last_video_id TEXT,
            last_video_title TEXT,
            total_watch_seconds INTEGER NOT NULL DEFAULT 0,
            security_alerts INTEGER NOT NULL DEFAULT 0,
            first_seen TEXT NOT NULL,
            last_seen TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS viewer_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            viewer_id TEXT NOT NULL,
            viewer_name TEXT NOT NULL,
            ip TEXT NOT NULL,
            country TEXT NOT NULL,
            video_id TEXT,
            video_title TEXT,
            event_type TEXT NOT NULL,
            position REAL DEFAULT 0,
            details TEXT,
            created_at TEXT NOT NULL
        );
        ''')


def _client_ip_and_country(request: Request) -> tuple[str, str]:
    ip = (
        request.headers.get("cf-connecting-ip")
        or (request.headers.get("x-forwarded-for") or "").split(",")[0].strip()
        or (request.client.host if request.client else "127.0.0.1")
    )
    country = request.headers.get("cf-ipcountry") or "IN"
    return ip, country


_VAULT_TOKENS: dict[str, dict] = {}


class VaultSessionBody(BaseModel):
    viewer_id: str = Field(default="anon", max_length=80)
    viewer_name: str = Field(default="Student", max_length=120)
    screen: str = Field(default="", max_length=40)
    timezone: str = Field(default="", max_length=80)
    start_pos: float = Field(default=0.0, ge=0)


class ViewerEventBody(BaseModel):
    viewer_id: str = Field(default="anon", max_length=80)
    viewer_name: str = Field(default="Student", max_length=120)
    video_id: str | None = Field(default=None, max_length=60)
    event_type: str = Field(max_length=60)
    position: float = Field(default=0.0, ge=0)
    watch_delta: int = Field(default=0, ge=0, le=60)
    details: str = Field(default="", max_length=300)


@app.get('/api/videos/{video_id}')
def get_video(video_id: str):
    video = fetch_video(video_id)
    if not video:
        raise HTTPException(status_code=404, detail='Video not found')
    info = find_odysee_info(video)
    video['cloud_ready'] = bool(info)
    # Never expose raw Odysee URLs, claim IDs, or local file paths in API responses
    video.pop('path', None)
    return {'video': video, 'chunks': transcript_for_video(video_id)}


@app.post('/api/videos/{video_id}/vault-session')
def create_vault_session(video_id: str, body: VaultSessionBody, request: Request):
    import secrets, time
    from .db import connect, utcnow

    video = fetch_video(video_id)
    if not video:
        raise HTTPException(status_code=404, detail='Video not found')

    _ensure_tracking_tables()
    ip, country = _client_ip_and_country(request)
    ua = (request.headers.get("user-agent") or "Unknown")[:220]
    now_iso = utcnow()

    with connect() as conn:
        prev = conn.execute("SELECT * FROM viewer_sessions WHERE viewer_id=?", (body.viewer_id,)).fetchone()
        if prev:
            conn.execute(
                '''UPDATE viewer_sessions
                   SET viewer_name=?, ip=?, country=?, user_agent=?, screen=?, timezone=?,
                       last_video_id=?, last_video_title=?, last_seen=?
                   WHERE viewer_id=?''',
                (body.viewer_name, ip, country, ua, body.screen, body.timezone,
                 video_id, video['title'], now_iso, body.viewer_id),
            )
        else:
            conn.execute(
                '''INSERT INTO viewer_sessions(
                       viewer_id, viewer_name, ip, country, user_agent, screen, timezone,
                       last_video_id, last_video_title, total_watch_seconds, security_alerts,
                       first_seen, last_seen
                   ) VALUES (?,?,?,?,?,?,?,?,?,0,0,?,?)''',
                (body.viewer_id, body.viewer_name, ip, country, ua, body.screen, body.timezone,
                 video_id, video['title'], now_iso, now_iso),
            )
        conn.execute(
            '''INSERT INTO viewer_events(viewer_id, viewer_name, ip, country, video_id, video_title, event_type, position, details, created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?)''',
            (body.viewer_id, body.viewer_name, ip, country, video_id, video['title'], 'play_start', body.start_pos, f"Device: {body.screen} ({body.timezone})", now_iso),
        )

    # Prune expired tokens
    now_ts = time.time()
    for tk in [k for k, v in _VAULT_TOKENS.items() if now_ts - v["ts"] > 45]:
        _VAULT_TOKENS.pop(tk, None)

    token = secrets.token_urlsafe(24)
    watermark = f"🔒 {body.viewer_name} · {ip} ({country}) · ID:{body.viewer_id[:8]}"
    _VAULT_TOKENS[token] = {
        "video_id": video_id,
        "ip": ip,
        "watermark": watermark,
        "start_pos": int(body.start_pos),
        "ts": now_ts,
    }
    return {
        "vault_url": f"/api/videos/{video_id}/vault-frame?t={token}",
        "watermark": watermark,
        "viewer_ip": ip,
        "viewer_country": country,
    }


@app.get('/api/videos/{video_id}/vault-frame')
def serve_vault_frame(video_id: str, t: str, request: Request):
    import base64, time
    from fastapi.responses import HTMLResponse

    # Block direct browser navigation or curl harvesting; must be loaded inside CourseForge iframe
    fetch_dest = request.headers.get("sec-fetch-dest", "")
    if fetch_dest and fetch_dest not in ("iframe", "frame"):
        raise HTTPException(status_code=403, detail="Direct access to protected video stream is prohibited.")

    entry = _VAULT_TOKENS.pop(t, None)
    if not entry or entry.get("video_id") != video_id or (time.time() - entry["ts"]) > 45:
        raise HTTPException(status_code=403, detail="Expired or already consumed single-use DRM token.")

    video = fetch_video(video_id)
    if not video:
        raise HTTPException(status_code=404, detail="Video not found")

    info = find_odysee_info(video)
    start_pos = entry.get("start_pos", 0)
    watermark = entry.get("watermark", "Protected Stream")

    if info and info.get("claim_name") and info.get("claim_id"):
        embed_url = get_signed_embed_url(info["claim_name"], info["claim_id"])
        if start_pos > 0:
            sep = "&" if "?" in embed_url else "?"
            embed_url = f"{embed_url}{sep}t={start_pos}"
        b64_src = base64.b64encode(embed_url.encode()).decode()
        mode = "embed"
    else:
        b64_src = base64.b64encode(f"/api/videos/{video_id}/stream".encode()).decode()
        mode = "native"

    html = f"""<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<style>
  * {{ box-sizing: border-box; user-select: none; -webkit-user-select: none; }}
  html, body {{ margin: 0; padding: 0; width: 100%; height: 100%; background: #000; overflow: hidden; font-family: system-ui, sans-serif; }}
  #stage {{ position: relative; width: 100%; height: 100%; background: #000; overflow: hidden; }}
  /* Crop out top title/share bar of embedded player so no external links can be seen or clicked */
  iframe {{
    position: absolute;
    top: -54px;
    left: 0;
    width: 100%;
    height: calc(100% + 54px);
    border: 0;
    background: #000;
  }}
  video {{ width: 100%; height: 100%; background: #000; object-fit: contain; }}
  /* Anti-click shields over top area and bottom-right corner logo */
  .shield-top {{
    position: absolute; top: 0; left: 0; right: 0; height: 58px;
    z-index: 20; background: transparent; cursor: default;
  }}
  .shield-logo {{
    position: absolute; bottom: 0; right: 42px; width: 110px; height: 48px;
    z-index: 20; background: transparent; cursor: default;
  }}
  /* Floating dynamic DRM watermark */
  #wm {{
    position: absolute; z-index: 30; pointer-events: none;
    padding: 4px 10px; border-radius: 6px;
    background: rgba(10, 14, 24, 0.52); color: rgba(255, 255, 255, 0.72);
    font-size: 11px; font-weight: 600; letter-spacing: 0.03em;
    border: 1px solid rgba(255, 255, 255, 0.14);
    text-shadow: 0 1px 2px #000;
    transition: top 2.5s ease-in-out, left 2.5s ease-in-out;
    top: 14%; left: 8%;
  }}
  #blurOverlay {{
    position: absolute; inset: 0; z-index: 40;
    background: rgba(5, 8, 15, 0.96); color: #fff;
    display: none; align-items: center; justify-content: center;
    text-align: center; font-size: 15px; font-weight: 600;
    backdrop-filter: blur(18px);
  }}
</style>
</head>
<body oncontextmenu="return false" ondragstart="return false" onselectstart="return false">
<div id="stage">
  <div class="shield-top" title="Protected CourseForge Stream"></div>
  <div class="shield-logo" title="Protected CourseForge Stream"></div>
  <div id="wm">{watermark}</div>
  <div id="blurOverlay">🔒 Protected Playback Paused — Return to CourseForge Window</div>
</div>
<script>
(function() {{
  try {{ history.replaceState(null, '', '/vault/protected'); }} catch(e) {{}}
  const mode = "{mode}";
  const raw = atob("{b64_src}");
  const stage = document.getElementById('stage');
  if (mode === 'embed') {{
    const f = document.createElement('iframe');
    f.allow = 'autoplay; fullscreen; encrypted-media';
    f.src = raw;
    stage.insertBefore(f, stage.firstChild);
  }} else {{
    const v = document.createElement('video');
    v.controls = true;
    v.autoplay = true;
    v.setAttribute('controlsList', 'nodownload noplaybackrate');
    v.disablePictureInPicture = true;
    v.src = raw;
    stage.insertBefore(v, stage.firstChild);
  }}
  const wm = document.getElementById('wm');
  const baseText = {watermark!r};
  function moveWm() {{
    const t = 10 + Math.floor(Math.random() * 68);
    const l = 6 + Math.floor(Math.random() * 58);
    wm.style.top = t + '%';
    wm.style.left = l + '%';
    const d = new Date().toLocaleTimeString();
    wm.textContent = baseText + ' · ' + d;
  }}
  setInterval(moveWm, 6000);
  moveWm();

  window.addEventListener('contextmenu', e => {{ e.preventDefault(); parent.postMessage({{type:'drm_alert', reason:'right_click_blocked'}}, '*'); }});
  window.addEventListener('keydown', e => {{
    if (e.key === 'F12' || (e.ctrlKey && e.shiftKey && ['I','J','C'].includes(e.key.toUpperCase())) || (e.ctrlKey && ['U','S','P'].includes(e.key.toUpperCase())) || (e.metaKey && e.altKey && ['I','J','U','C'].includes(e.key.toUpperCase()))) {{
      e.preventDefault();
      parent.postMessage({{type:'drm_alert', reason:'shortcut_blocked:' + e.key}}, '*');
    }}
  }});
}})();
</script>
</body>
</html>"""
    return HTMLResponse(
        html,
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
            "X-Frame-Options": "SAMEORIGIN",
        },
    )


@app.post('/api/analytics/event')
def record_viewer_event(body: ViewerEventBody, request: Request):
    from .db import connect, utcnow
    _ensure_tracking_tables()
    ip, country = _client_ip_and_country(request)
    ua = (request.headers.get("user-agent") or "Unknown")[:220]
    now_iso = utcnow()
    video = fetch_video(body.video_id) if body.video_id else None
    vtitle = video['title'] if video else ''
    is_alert = 1 if body.event_type.startswith(('drm_', 'blocked_', 'devtools', 'security')) else 0

    with connect() as conn:
        prev = conn.execute("SELECT * FROM viewer_sessions WHERE viewer_id=?", (body.viewer_id,)).fetchone()
        if prev:
            conn.execute(
                '''UPDATE viewer_sessions
                   SET viewer_name=?, ip=?, country=?, user_agent=?,
                       last_video_id=COALESCE(?, last_video_id),
                       last_video_title=CASE WHEN ? != '' THEN ? ELSE last_video_title END,
                       total_watch_seconds=total_watch_seconds + ?,
                       security_alerts=security_alerts + ?,
                       last_seen=?
                   WHERE viewer_id=?''',
                (body.viewer_name, ip, country, ua, body.video_id, vtitle, vtitle,
                 body.watch_delta, is_alert, now_iso, body.viewer_id),
            )
        else:
            conn.execute(
                '''INSERT INTO viewer_sessions(
                       viewer_id, viewer_name, ip, country, user_agent, screen, timezone,
                       last_video_id, last_video_title, total_watch_seconds, security_alerts,
                       first_seen, last_seen
                   ) VALUES (?,?,?,?,?,'','',?,?,?,?,?,?)''',
                (body.viewer_id, body.viewer_name, ip, country, ua, body.video_id, vtitle,
                 body.watch_delta, is_alert, now_iso, now_iso),
            )
        if body.event_type != 'heartbeat' or body.watch_delta >= 30:
            conn.execute(
                '''INSERT INTO viewer_events(viewer_id, viewer_name, ip, country, video_id, video_title, event_type, position, details, created_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?)''',
                (body.viewer_id, body.viewer_name, ip, country, body.video_id, vtitle, body.event_type, body.position, body.details, now_iso),
            )
    return {"ok": True}


@app.get('/api/analytics/viewers')
def list_viewer_analytics():
    from .db import connect
    _ensure_tracking_tables()
    with connect() as conn:
        sessions = [dict(r) for r in conn.execute("SELECT * FROM viewer_sessions ORDER BY last_seen DESC LIMIT 100").fetchall()]
        events = [dict(r) for r in conn.execute("SELECT * FROM viewer_events ORDER BY id DESC LIMIT 120").fetchall()]
    total_watch = sum(s.get("total_watch_seconds", 0) for s in sessions)
    total_alerts = sum(s.get("security_alerts", 0) for s in sessions)
    return {
        "summary": {
            "unique_viewers": len(sessions),
            "unique_ips": len({s["ip"] for s in sessions}),
            "total_watch_seconds": total_watch,
            "total_security_alerts": total_alerts,
        },
        "sessions": sessions,
        "events": events,
    }


@app.get('/api/materials')
def list_course_materials(course: str | None = None):
    import os
    root = settings.courses_dir.resolve()
    items = []
    if root.exists():
        for c_name in sorted(os.listdir(root)):
            if c_name.startswith('.'):
                continue
            if course and c_name != course:
                continue
            c_path = root / c_name
            if not c_path.is_dir():
                continue
            for fname in sorted(os.listdir(c_path)):
                if fname.startswith('.') or fname.lower().endswith('.mp4'):
                    continue
                fpath = c_path / fname
                if not fpath.is_file():
                    continue
                ext = fpath.suffix.lower().lstrip('.')
                items.append({
                    "course": c_name,
                    "name": fname,
                    "ext": ext,
                    "size_kb": round(fpath.stat().st_size / 1024, 1),
                    "url": f"/api/materials/{c_name}/{fname}",
                })
    return {"materials": items, "total": len(items)}


@app.get('/api/materials/{course}/{filename}')
def get_course_material(course: str, filename: str):
    import json
    from fastapi.responses import HTMLResponse
    root = settings.courses_dir.resolve()
    target = (root / course / filename).resolve()
    if not target.is_file() or ".." in course or ".." in filename:
        raise HTTPException(status_code=404, detail="Study material not found")
    ext = target.suffix.lower()
    if ext == '.ipynb':
        try:
            nb = json.loads(target.read_text(errors='ignore'))
            cells_html = []
            for idx, cell in enumerate(nb.get('cells', []), 1):
                ctype = cell.get('cell_type', 'code')
                src = ''.join(cell.get('source', []))
                import html as _h
                esc = _h.escape(src)
                if ctype == 'markdown':
                    cells_html.append(f"<div style='padding:12px 16px;background:#161f33;border-radius:8px;margin-bottom:10px;white-space:pre-wrap;line-height:1.5'>{esc}</div>")
                else:
                    cells_html.append(f"<div style='margin-bottom:10px'><div style='font-size:11px;color:#74c0fc;margin-bottom:4px'>In [{idx}]:</div><pre style='margin:0;padding:12px;background:#0b0f19;border:1px solid rgba(255,255,255,0.1);border-radius:8px;overflow:auto;color:#e9ecef;font-size:13px'>{esc}</pre></div>")
            page = f"<!doctype html><html><head><meta charset='utf-8'><title>{filename}</title><style>body{{background:#0f1420;color:#f1f5f9;font-family:system-ui,sans-serif;padding:24px;max-width:980px;margin:0 auto}}</style></head><body><h2>📓 {filename}</h2>{''.join(cells_html)}</body></html>"
            return HTMLResponse(page)
        except Exception:
            pass
    if ext in ('.py', '.txt', '.sql', '.csv', '.md', '.json'):
        import html as _h
        raw = target.read_text(errors='ignore')[:200000]
        page = f"<!doctype html><html><head><meta charset='utf-8'><title>{filename}</title><style>body{{background:#0f1420;color:#f1f5f9;font-family:system-ui,sans-serif;padding:24px;max-width:980px;margin:0 auto}}pre{{background:#0b0f19;padding:16px;border-radius:10px;border:1px solid rgba(255,255,255,0.12);overflow:auto;font-size:13px;line-height:1.5}}</style></head><body><h2>📄 {filename}</h2><pre>{_h.escape(raw)}</pre></body></html>"
        return HTMLResponse(page)
    return FileResponse(target, content_disposition_type='inline')


_ODYSEE_CACHE: dict = {"last_sync": 0.0, "by_prefix": {}, "by_name": {}, "embeds": {}}


def get_signed_embed_url(claim_name: str, claim_id: str) -> str:
    import json, os, urllib.request
    cache_key = f"{claim_name}#{claim_id}"
    if cache_key in _ODYSEE_CACHE["embeds"]:
        return _ODYSEE_CACHE["embeds"][cache_key]

    clean_name = claim_name.split("/")[-1].split(":")[0] if "/" in claim_name else claim_name.split(":")[0]
    token = os.getenv("ODYSEE_AUTH_TOKEN", "")
    channel_id = os.getenv("ODYSEE_CHANNEL_ID", "29a2037dd2bf5e8d3c5eaee36243368fd8410fba")
    try:
        req = urllib.request.Request(
            "https://api.na-backend.odysee.com/api/v1/proxy?m=channel_sign",
            data=json.dumps({
                "jsonrpc": "2.0",
                "method": "channel_sign",
                "params": {"channel_id": channel_id, "hexdata": claim_id.encode().hex()},
                "id": 1,
            }).encode(),
            headers={
                "X-Lbry-Auth-Token": token,
                "Content-Type": "application/json",
                "User-Agent": "Mozilla/5.0",
            },
        )
        with urllib.request.urlopen(req, timeout=8) as r:
            sig_res = json.loads(r.read().decode()).get("result") or {}
        sig = sig_res.get("signature")
        sig_ts = sig_res.get("signing_ts")
        if sig and sig_ts:
            url = f"https://odysee.com/$/embed/{clean_name}/{claim_id}?signature={sig}&signature_ts={sig_ts}"
            _ODYSEE_CACHE["embeds"][cache_key] = url
            return url
    except Exception:
        pass
    return f"https://odysee.com/$/embed/{clean_name}/{claim_id}"


def _sync_odysee_platform() -> None:
    import json, os, re, time, urllib.request
    now = time.time()
    if now - _ODYSEE_CACHE["last_sync"] < 45 and _ODYSEE_CACHE["by_prefix"]:
        return
    _ODYSEE_CACHE["last_sync"] = now

    manifest_candidates = [
        settings.data_dir / 'odysee_manifest.json',
        settings.courses_dir / 'odysee_manifest.json',
        Path('/Users/lavkushkumar/Desktop/Courses/odysee_manifest.json'),
    ]
    manifest: dict = {}
    for mp in manifest_candidates:
        if mp.is_file():
            try:
                manifest.update(json.loads(mp.read_text()))
            except Exception:
                pass

    # Also query live Odysee platform stream_list API directly
    token = os.getenv("ODYSEE_AUTH_TOKEN", "")
    try:
        req = urllib.request.Request(
            "https://api.na-backend.odysee.com/api/v1/proxy?m=stream_list",
            data=json.dumps({
                "jsonrpc": "2.0",
                "method": "stream_list",
                "params": {"page": 1, "page_size": 250, "no_totals": False},
                "id": 1,
            }).encode(),
            headers={
                "X-Lbry-Auth-Token": token,
                "Content-Type": "application/json",
                "User-Agent": "Mozilla/5.0",
            },
        )
        with urllib.request.urlopen(req, timeout=8) as r:
            res = json.loads(r.read().decode())
        items = (res.get("result") or {}).get("items", [])
        for it in items:
            name = it.get("name", "")
            cid = it.get("claim_id", "")
            title = (it.get("value") or {}).get("title") or name
            if not name or not cid:
                continue
            course = (
                "Advanced Agentic AI And Gen AI By Prudhvi Sir Nareshit 2026"
                if name.startswith("agentic-genai-")
                else "Deepak Data Engg"
            )
            entry = {
                "course": course,
                "title": title,
                "claim_name": name,
                "claim_id": cid,
                "odysee_url": f"https://odysee.com/{name}:{cid}",
                "stream_url": f"https://odysee.com/$/stream/{name}/{cid}",
            }
            manifest[f"{course}/{title}.mp4"] = entry
    except Exception:
        pass

    by_prefix = {}
    by_name = {}
    for k, val in manifest.items():
        if not val.get("stream_url"):
            continue
        fname = Path(k).name
        course = val.get("course", "")
        by_name[fname] = val
        by_name[f"{course}/{fname}"] = val
        m = re.match(r"^(\[\d{3}\])", val.get("title", "") or fname)
        if m:
            by_prefix[f"{course}:{m.group(1)}"] = val

    _ODYSEE_CACHE["by_prefix"] = by_prefix
    _ODYSEE_CACHE["by_name"] = by_name


def find_odysee_info(video: dict) -> dict | None:
    import re
    _sync_odysee_platform()
    fname = Path(video['path']).name
    course = video.get('course', '')
    by_name = _ODYSEE_CACHE["by_name"]
    for key in (f"{course}/{fname}", fname):
        if key in by_name:
            return by_name[key]
    idx_match = re.match(r'^(\[\d{3}\])', fname)
    if idx_match:
        pref_key = f"{course}:{idx_match.group(1)}"
        if pref_key in _ODYSEE_CACHE["by_prefix"]:
            return _ODYSEE_CACHE["by_prefix"][pref_key]
    return None


_ODYCDN_URLS: dict[str, tuple[float, str]] = {}


def resolve_odycdn_url(claim_name: str, claim_id: str) -> str | None:
    import json, os, time, urllib.request
    cache_key = f"{claim_name}#{claim_id}"
    now = time.time()
    cached = _ODYCDN_URLS.get(cache_key)
    if cached and now - cached[0] < 3600:
        return cached[1]

    token = os.getenv("ODYSEE_AUTH_TOKEN", "")
    uri = f"lbry://{claim_name}#{claim_id}" if not claim_name.startswith("@") else f"lbry://{claim_name}"
    req = urllib.request.Request(
        "https://api.na-backend.odysee.com/api/v1/proxy?m=get",
        data=json.dumps({
            "jsonrpc": "2.0",
            "method": "get",
            "params": {"uri": uri},
            "id": 1,
        }).encode(),
        headers={
            "X-Lbry-Auth-Token": token,
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=12) as r:
            res = json.loads(r.read().decode())
        streaming_url = (res.get("result") or {}).get("streaming_url")
        if streaming_url:
            _ODYCDN_URLS[cache_key] = (now, streaming_url)
            return streaming_url
    except Exception:
        pass
    return None


@app.api_route('/api/videos/{video_id}/stream', methods=['GET', 'HEAD'])
async def stream_video(video_id: str, request: Request):
    import httpx
    from fastapi.responses import Response, StreamingResponse

    video = fetch_video(video_id)
    if not video:
        raise HTTPException(status_code=404, detail='Video not found')

    info = find_odysee_info(video)
    if info and info.get('claim_name') and info.get('claim_id'):
        cdn_url = resolve_odycdn_url(info['claim_name'], info['claim_id'])
        if cdn_url:
            req_headers = {
                "Referer": "https://odysee.com/",
                "Origin": "https://odysee.com",
                "User-Agent": "Mozilla/5.0",
            }
            range_header = request.headers.get("range")
            if range_header:
                req_headers["Range"] = range_header
            else:
                req_headers["Range"] = "bytes=0-"

            client = httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=15.0), follow_redirects=True)
            upstream_req = client.build_request("GET", cdn_url, headers=req_headers)
            upstream_resp = await client.send(upstream_req, stream=True)

            if upstream_resp.status_code in (200, 206):
                resp_headers = {
                    "Accept-Ranges": "bytes",
                    "Content-Type": upstream_resp.headers.get("content-type", "video/mp4"),
                }
                for h in ("Content-Range", "Content-Length", "Cache-Control", "Last-Modified"):
                    val = upstream_resp.headers.get(h)
                    if val:
                        resp_headers[h] = val

                status_code = 206 if range_header and "Content-Range" in resp_headers else upstream_resp.status_code

                if request.method == "HEAD":
                    await upstream_resp.aclose()
                    await client.aclose()
                    return Response(status_code=status_code, headers=resp_headers)

                async def iter_odycdn():
                    try:
                        async for chunk in upstream_resp.aiter_bytes(chunk_size=256 * 1024):
                            yield chunk
                    finally:
                        await upstream_resp.aclose()
                        await client.aclose()

                return StreamingResponse(iter_odycdn(), status_code=status_code, headers=resp_headers)
            else:
                await upstream_resp.aclose()
                await client.aclose()

    path = Path(video['path']).resolve()
    if path.is_file():
        return FileResponse(path, content_disposition_type='inline')
    raise HTTPException(status_code=404, detail='Video not yet uploaded to Odysee platform')


@app.get('/api/chunks/{chunk_id}/frame')
def frame(chunk_id: str):
    relative = frame_for_chunk(chunk_id)
    if not relative:
        raise HTTPException(status_code=404, detail='Frame not found')
    path = (settings.data_dir / relative).resolve()
    if not path.is_relative_to(settings.data_dir) or not path.is_file():
        raise HTTPException(status_code=404, detail='Frame unavailable')
    return FileResponse(path, media_type='image/jpeg')


class QueryBody(BaseModel):
    question: str = Field(min_length=2, max_length=2000)
    course: str | None = Field(default=None, max_length=200)
    video_id: str | None = Field(default=None, max_length=50)
    mode: Literal['explain', 'notes', 'quiz', 'lab'] = 'explain'


@app.post('/api/ask')
def ask_tutor(body: QueryBody):
    try:
        return ask(question=body.question, mode=body.mode, course=body.course, video_id=body.video_id)
    except Exception as exc:
        # Avoid leaking backend credentials/paths in error responses.
        raise HTTPException(status_code=503, detail='AI services unavailable or search failed. '
                            'Check Ollama, Qdrant, pulled models and worker logs.') from exc


@app.get('/api/search')
def search(q: str = Query(min_length=2, max_length=500), course: str | None = None,
           video_id: str | None = None):
    try:
        return {'results': retrieve(q, course=course, video_id=video_id, limit=10)}
    except Exception as exc:
        raise HTTPException(status_code=503, detail='Semantic search unavailable. Check Ollama and Qdrant.') from exc


class ProgressBody(BaseModel):
    percent: int = Field(ge=0, le=100)
    position: float = Field(ge=0, lt=1e9)


@app.get('/api/progress')
def get_progress(course: str | None = None):
    return {'progress': study.get_progress(course)}


@app.put('/api/videos/{video_id}/progress')
def save_progress(video_id: str, body: ProgressBody):
    try:
        return study.set_progress(video_id, percent=body.percent, position=body.position)
    except KeyError:
        raise HTTPException(404, 'Video not found')


@app.get('/api/syllabus')
def course_syllabus(course: str = Query(min_length=1, max_length=200)):
    return {'syllabus': syllabus.get_syllabus(course)}


class CourseBody(BaseModel):
    course: str = Field(min_length=1, max_length=200)


@app.post('/api/syllabus/generate')
def build_syllabus(body: CourseBody):
    try:
        return syllabus.generate(body.course)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(503, 'Syllabus AI unavailable; check Ollama models') from exc


class LearningPathBody(BaseModel):
    courses: list[str] = Field(min_length=1, max_length=8)
    goal: str = Field(min_length=3, max_length=180)
    use_ai: bool = True


class PathStepBody(BaseModel):
    completed: bool


@app.get('/api/learning-paths')
def list_learning_paths():
    return {'paths': learning_paths.list_paths()}


@app.post('/api/learning-paths', status_code=201)
def create_learning_path(body: LearningPathBody):
    try:
        return learning_paths.generate(body.courses, body.goal, use_ai=body.use_ai)
    except learning_paths.PathInputError as exc:
        raise HTTPException(422, str(exc)) from exc


@app.get('/api/learning-paths/{path_id}')
def get_learning_path(path_id: str):
    try:
        return learning_paths.get_path(path_id)
    except learning_paths.PathNotFound as exc:
        raise HTTPException(404, 'Learning path not found') from exc


@app.put('/api/learning-paths/{path_id}/steps/{step_id}')
def update_learning_path_step(path_id: str, step_id: str, body: PathStepBody):
    try:
        return learning_paths.mark_step(path_id, step_id, body.completed)
    except learning_paths.PathNotFound as exc:
        raise HTTPException(404, 'Learning path or step not found') from exc
    except learning_paths.PathInputError as exc:
        raise HTTPException(409, str(exc)) from exc


class AssessmentCreateBody(BaseModel):
    count: int = Field(default=3, ge=3, le=5)


class AssessmentAnswersBody(BaseModel):
    answers: dict[str, int] = Field(min_length=3, max_length=5)


@app.post('/api/learning-paths/{path_id}/steps/{step_id}/assessments', status_code=201)
def create_topic_assessment(path_id: str, step_id: str, body: AssessmentCreateBody):
    try:
        return assessments.create(path_id, step_id, count=body.count)
    except assessments.AssessmentNotFound as exc:
        raise HTTPException(404, str(exc)) from exc
    except assessments.AssessmentConflict as exc:
        raise HTTPException(409, str(exc)) from exc
    except assessments.AssessmentInputError as exc:
        raise HTTPException(422, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(503, 'Assessment AI unavailable. Check Ollama and indexed lecture content.') from exc


@app.get('/api/assessments/{assessment_id}')
def get_topic_assessment(assessment_id: str):
    try:
        return assessments.get(assessment_id)
    except assessments.AssessmentNotFound as exc:
        raise HTTPException(404, str(exc)) from exc


@app.post('/api/assessments/{assessment_id}/attempts', status_code=201)
def submit_topic_assessment(assessment_id: str, body: AssessmentAnswersBody):
    try:
        return assessments.submit(assessment_id, body.answers)
    except assessments.AssessmentNotFound as exc:
        raise HTTPException(404, str(exc)) from exc
    except assessments.AssessmentConflict as exc:
        raise HTTPException(409, str(exc)) from exc
    except assessments.AssessmentInputError as exc:
        raise HTTPException(422, str(exc)) from exc


@app.get('/api/learning-paths/{path_id}/assessment-history')
def topic_assessment_history(path_id: str, step_id: str | None = None):
    try:
        return {'attempts': assessments.history(path_id, step_id)}
    except assessments.AssessmentNotFound as exc:
        raise HTTPException(404, str(exc)) from exc
    except assessments.AssessmentConflict as exc:
        raise HTTPException(409, str(exc)) from exc


class CardCreateBody(CourseBody):
    topic: str = Field(min_length=3, max_length=400)
    count: int = Field(default=5, ge=1, le=10)


@app.post('/api/reviews/generate')
def create_review_cards(body: CardCreateBody):
    try:
        return reviews.generate_cards(body.course, body.topic, body.count)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(503, 'Quiz generation unavailable; check Ollama and indexes') from exc


@app.get('/api/reviews/due')
def review_due(course: str | None = None):
    return {'cards': study.due_cards(course)}


class GradeBody(BaseModel):
    quality: int = Field(ge=0, le=5)


@app.post('/api/reviews/{card_id}/grade')
def grade_review(card_id: str, body: GradeBody):
    try:
        return study.grade_card(card_id,body.quality)
    except KeyError:
        raise HTTPException(404, 'Review card not found')


@app.get('/api/learning-paths/{path_id}/practice-recommendations')
def practice_recommendations(path_id: str):
    try:
        return practice.recommend(path_id)
    except practice.PracticeNotFound:
        raise HTTPException(404, 'Learning path not found')


@app.get('/api/learning-paths/{path_id}/practice-history')
def practice_history(path_id: str, step_id: str | None = None):
    try:
        return {'attempts': practice.history(path_id, step_id)}
    except (practice.PracticeNotFound, learning_paths.PathNotFound):
        raise HTTPException(404, 'Learning path or topic not found')


@app.post('/api/learning-paths/{path_id}/steps/{step_id}/practice/{slug}/start', status_code=201)
def start_recommended_practice(path_id: str, step_id: str, slug: str):
    try:
        return practice.start_recommended(path_id, step_id, slug)
    except (practice.PracticeNotFound, learning_paths.PathNotFound):
        raise HTTPException(404, 'Learning path, topic, or lab not found')
    except practice.PracticeInputError as exc:
        raise HTTPException(409, str(exc)) from exc


@app.get('/api/labs')
def lab_catalog():
    return {'labs':labs.list_labs()}


@app.post('/api/labs/{slug}/start')
def start_lab(slug: str):
    try:
        return labs.start_lab(slug)
    except KeyError:
        raise HTTPException(404, 'Lab not found')


@app.get('/api/lab-sessions/{session_id}')
def get_lab_session(session_id: str):
    try:
        return labs.get_lab(session_id)
    except (KeyError, ValueError):
        raise HTTPException(404,'Session not found')


class LabFileBody(BaseModel):
    content: str = Field(max_length=100000)


@app.put('/api/lab-sessions/{session_id}/file')
def update_lab_file(session_id: str, body: LabFileBody):
    try:
        return labs.update_file(session_id, body.content)
    except KeyError:
        raise HTTPException(404,'Lab not found')
    except ValueError as exc:
        raise HTTPException(400,str(exc)) from exc


class LabSubmitBody(BaseModel):
    validate_in_kind: bool = False


@app.post('/api/lab-sessions/{session_id}/submit')
def submit_lab(session_id: str, body: LabSubmitBody):
    try:
        result = labs.submit_lab(session_id, kind=body.validate_in_kind)
        linked = practice.record_verified_grade(session_id, result)
        if linked:
            result['practice_attempt'] = linked
        return result
    except KeyError:
        raise HTTPException(404,'Lab not found')
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(503,str(exc)) from exc


class DailyPlanPreferencesBody(BaseModel):
    daily_minutes: int = Field(ge=15, le=180)
    path_id: str | None = Field(default=None, max_length=150)


class DailyPlanGenerateBody(BaseModel):
    study_date: str = Field(pattern=r'^\d{4}-\d{2}-\d{2}$')
    tz_offset_minutes: int = Field(default=0, ge=-840, le=840)
    refresh: bool = False


class DailyPlanItemBody(BaseModel):
    status: Literal['pending', 'done', 'skipped']


@app.get('/api/planner/preferences')
def planner_preferences():
    return planner.preferences()


@app.put('/api/planner/preferences')
def update_planner_preferences(body: DailyPlanPreferencesBody):
    try:
        return planner.save_preferences(body.daily_minutes, body.path_id)
    except planner.PlannerNotFound as exc:
        raise HTTPException(404, str(exc)) from exc
    except planner.PlannerInputError as exc:
        raise HTTPException(422, str(exc)) from exc


@app.get('/api/planner/days/{study_date}')
def planner_day(study_date: str):
    try:
        result = planner.get_day(study_date)
    except planner.PlannerInputError as exc:
        raise HTTPException(422, str(exc)) from exc
    if result is None:
        raise HTTPException(404, 'No plan for this day yet')
    return result


@app.post('/api/planner/days', status_code=201)
def generate_planner_day(body: DailyPlanGenerateBody):
    try:
        return planner.generate(body.study_date, body.tz_offset_minutes, refresh=body.refresh)
    except planner.PlannerNotFound as exc:
        raise HTTPException(404, str(exc)) from exc
    except planner.PlannerInputError as exc:
        raise HTTPException(422, str(exc)) from exc


@app.put('/api/planner/items/{item_id}')
def update_planner_item(item_id: str, body: DailyPlanItemBody):
    try:
        return planner.set_item_status(item_id, body.status)
    except planner.PlannerNotFound as exc:
        raise HTTPException(404, str(exc)) from exc
    except planner.PlannerInputError as exc:
        raise HTTPException(422, str(exc)) from exc


class ActualMinutesBody(BaseModel):
    actual_minutes: int = Field(ge=0, le=600)


@app.put('/api/planner/items/{item_id}/actual')
def record_planner_time(item_id: str, body: ActualMinutesBody):
    try:
        return planner.set_item_actual_minutes(item_id, body.actual_minutes)
    except planner.PlannerNotFound as exc:
        raise HTTPException(404, str(exc)) from exc
    except planner.PlannerInputError as exc:
        raise HTTPException(422, str(exc)) from exc


class WeekPreferencesBody(BaseModel):
    weekday_minutes: list[int] = Field(min_length=7, max_length=7)


class WeeklyGenerateBody(BaseModel):
    week_start: str = Field(pattern=r'^\d{4}-\d{2}-\d{2}$')
    tz_offset_minutes: int = Field(default=0, ge=-840, le=840)
    refresh: bool = False


@app.get('/api/planner/week-preferences')
def weekly_preferences():
    return weekly.preferences()


@app.put('/api/planner/week-preferences')
def save_weekly_preferences(body: WeekPreferencesBody):
    try:
        return weekly.save_preferences(body.weekday_minutes)
    except planner.PlannerInputError as exc:
        raise HTTPException(422, str(exc)) from exc


@app.get('/api/planner/weeks/{week_start}')
def weekly_plan(week_start: str):
    try:
        result = weekly.get_week(week_start)
    except planner.PlannerInputError as exc:
        raise HTTPException(422, str(exc)) from exc
    if result is None:
        raise HTTPException(404, 'No calendar for this week yet')
    return result


@app.post('/api/planner/weeks', status_code=201)
def build_weekly_plan(body: WeeklyGenerateBody):
    try:
        return weekly.build(body.week_start, body.tz_offset_minutes, refresh=body.refresh)
    except planner.PlannerNotFound as exc:
        raise HTTPException(404, str(exc)) from exc
    except planner.PlannerInputError as exc:
        raise HTTPException(422, str(exc)) from exc


class FocusStartBody(BaseModel):
    mode: Literal['focus','break'] = 'focus'
    duration_minutes: int = Field(default=25, ge=1, le=120)
    planner_item_id: str | None = None
    video_id: str | None = None
    lab_session_id: str | None = None
    title: str = Field(default='', max_length=160)


class FocusActionBody(BaseModel):
    action: Literal['pause','resume','finish','cancel']


@app.post('/api/focus/sessions', status_code=201)
def focus_start(body: FocusStartBody):
    try:
        return focus.start(**body.model_dump())
    except focus.FocusNotFound as exc:
        raise HTTPException(404, str(exc)) from exc
    except focus.FocusConflict as exc:
        raise HTTPException(409, str(exc)) from exc
    except focus.FocusInputError as exc:
        raise HTTPException(422, str(exc)) from exc


@app.post('/api/focus/sessions/{session_id}/actions')
def focus_action(session_id: str, body: FocusActionBody):
    try:
        return focus.transition(session_id, body.action)
    except focus.FocusNotFound as exc:
        raise HTTPException(404, str(exc)) from exc
    except focus.FocusConflict as exc:
        raise HTTPException(409, str(exc)) from exc
    except focus.FocusInputError as exc:
        raise HTTPException(422, str(exc)) from exc


@app.get('/api/focus/active')
def focus_active():
    return focus.active()


@app.get('/api/focus/history')
def focus_history(limit: int = Query(default=30, ge=1, le=200)):
    return focus.history(limit=limit)


@app.get('/api/focus/analytics/{week_start}')
def focus_analytics(week_start: str, tz_offset_minutes: int = Query(default=0, ge=-840, le=840)):
    try:
        return focus.analytics(week_start, tz_offset_minutes)
    except (focus.FocusInputError, planner.PlannerInputError) as exc:
        raise HTTPException(422, str(exc)) from exc


@app.get('/api/studio/insights')
def studio_insights():
    return studio.insights()


class VideoNoteBody(BaseModel):
    content: str = Field(min_length=1, max_length=3000)
    position: float = Field(ge=0, lt=1e9)


@app.get('/api/videos/{video_id}/notes')
def video_notes(video_id: str):
    if not fetch_video(video_id):
        raise HTTPException(404, 'Video not found')
    return {'notes': study.list_notes(video_id)}


@app.post('/api/videos/{video_id}/notes', status_code=201)
def create_video_note(video_id: str, body: VideoNoteBody):
    try:
        return study.add_note(video_id, body.position, body.content)
    except KeyError:
        raise HTTPException(404, 'Video not found')
    except ValueError:
        raise HTTPException(422, 'Invalid note')


@app.delete('/api/notes/{note_id}', status_code=204)
def remove_video_note(note_id: str):
    try:
        study.delete_note(note_id)
    except KeyError:
        raise HTTPException(404, 'Note not found')
