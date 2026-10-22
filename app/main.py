"""CourseForge academy: account-protected learning APIs and public catalog."""
from pathlib import Path
from contextlib import asynccontextmanager
from typing import Literal, Any
import os
import re
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from pydantic import BaseModel, Field, field_validator
from starlette.concurrency import run_in_threadpool

from .config import settings
from .db import (init_db, fetch_videos, fetch_video, fetch_jobs, queue_video,
                 transcript_for_video, frame_for_chunk, keyword_search)
from .library import scan_courses
from . import tutor
from .tutor import ask, retrieve
from . import syllabus, study, labs, reviews, studio, course_metadata, learning_paths, assessments, practice, planner, weekly, focus, retention, companion
from . import auth
from .db import learner_id, learner_courses, connect, course_allowed
from .learning_object import checkpoints_for

@asynccontextmanager
async def lifespan(_app: FastAPI):
    settings.courses_dir.mkdir(parents=True, exist_ok=True)
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    init_db()
    from .academy import maintenance_loop
    import asyncio
    _app.state.media_slots = asyncio.Semaphore(64)
    maintenance = asyncio.create_task(maintenance_loop())
    yield
    maintenance.cancel()
    try:
        await maintenance
    except asyncio.CancelledError:
        pass


app = FastAPI(title='CourseForge Academy', version='0.4.0', docs_url='/api/docs',openapi_url='/api/openapi.json',
              redoc_url=None, lifespan=lifespan)
public_host = urlsplit(os.getenv('PUBLIC_BASE_URL', '')).hostname
allowed_hosts = [host.strip() for host in os.getenv('ALLOWED_HOSTS', 'localhost,127.0.0.1,testserver,*.trycloudflare.com').split(',') if host.strip()]
if public_host and public_host not in allowed_hosts:
    allowed_hosts.append(public_host)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=allowed_hosts)
from .web_delivery import PageCompression
app.add_middleware(PageCompression)

@app.middleware('http')
async def guard_local_actions(request: Request, call_next):
    try:
        user = await auth.authorize(request)
    except HTTPException as exc:
        if exc.status_code in (401,403) and request.url.path.startswith('/api/'):
            await run_in_threadpool(auth.access_event, request, 'access_denied', getattr(request.state,'user',None)['id'] if getattr(request.state,'user',None) else None)
        return JSONResponse({'detail':exc.detail},status_code=exc.status_code,headers=exc.headers)
    allowed = None
    if user and user['role'] != 'admin':
        with connect() as db:
            allowed=frozenset(r['course'] for r in db.execute('''SELECT e.course FROM enrollments e
                JOIN course_publication p ON p.course=e.course WHERE e.user_id=? AND p.published=1''',(user['id'],)))
    uid_token = learner_id.set(user['id'] if user else 'legacy')
    course_token = learner_courses.set(allowed)
    try:
        path=request.url.path
        admin_change=bool(user and user['role']=='admin' and request.method not in ('GET','HEAD','OPTIONS') and
            (path.startswith('/api/admin/') or (path.startswith('/api/courses/') and not (path.endswith('/enroll') or path.endswith('/placement-test/submit'))) or
             path=='/api/scan' or path.endswith('/reindex')))
        audit_payload={}
        if admin_change and request.headers.get('content-type','').split(';')[0]=='application/json':
            try:body=await request.json()
            except (ValueError,UnicodeDecodeError):body={}
            if isinstance(body,dict):audit_payload={k:body[k] for k in ('suspended','enrolled','published') if k in body}
        response = await call_next(request)
        if user and request.method not in ('GET','HEAD','OPTIONS') and 200 <= response.status_code < 300:
            path=request.url.path
            if admin_change:
                from .admin_console import audit_change
                await run_in_threadpool(audit_change,user['id'],request.method,path,audit_payload)
            kind=None
            if path.endswith('/progress'):kind='completion_reported'
            elif path.endswith('/notes'):kind='note_saved'
            elif path.startswith('/api/notes/'):kind='note_deleted'
            elif path.endswith('/attempts'):kind='assessment_submitted'
            elif path.endswith('/grade'):kind='recall_reviewed'
            elif path.startswith('/api/planner/'):kind='study_plan_updated'
            elif path.startswith('/api/focus/'):kind='focus_session_updated'
            elif path.endswith('/bookmarks'):kind='bookmark_saved'
            if kind:
                parts=path.split('/')
                video_id=parts[3] if len(parts)>3 and parts[2]=='videos' else None
                await run_in_threadpool(learning_event,user['id'],kind,video_id)
        response.headers['X-Content-Type-Options']='nosniff'
        response.headers['Referrer-Policy']='same-origin'
        response.headers['X-Frame-Options']='SAMEORIGIN'
        if request.url.path.startswith('/api/') and not request.url.path.startswith('/api/artwork/') and '/media/' not in request.url.path:
            response.headers['Cache-Control']='no-store'
        return response
    finally:
        learner_id.reset(uid_token)
        learner_courses.reset(course_token)

app.include_router(auth.router)
from .player_sessions import router as player_sessions_router
app.include_router(player_sessions_router)
from .academy import router as academy_router, learning_event
from .tasks import router as task_router, enqueue
app.include_router(academy_router)
app.include_router(task_router)
from .admin_console import router as admin_console_router
app.include_router(admin_console_router)
from .habits import router as habits_router
app.include_router(habits_router)
from .artwork import router as artwork_router
app.include_router(artwork_router)
from .streaming import router as streaming_router
app.include_router(streaming_router)

static_path = Path(__file__).parent / 'static'
app.mount('/static', StaticFiles(directory=static_path), name='static')


@app.get('/')
def index():
    return FileResponse(static_path / 'index.html')


@app.get('/manifest.webmanifest')
@app.get('/manifest.json')
def manifest():
    return FileResponse(static_path / 'manifest.webmanifest', media_type='application/manifest+json')


@app.get('/sw.js')
def service_worker():
    return FileResponse(static_path / 'sw.js', media_type='application/javascript')


@app.get('/api/health')
def health():
    return {'status': 'ok', 'version':'0.4.0'}


@app.post('/api/scan')
def scan():
    return scan_courses()


def compute_flow_order(course: str, name: str) -> float:
    import re
    cleaned = (name or '').strip()
    m = re.match(r'^\[(\d+)([a-z]?)(?:\s*part\s*(\d+)|-(\d+))?\]', cleaned, re.I)
    if m:
        num = int(m.group(1))
        sub = (ord(m.group(2).lower()) - ord('a') + 1) * 0.1 if m.group(2) else (int(m.group(3) or m.group(4)) * 0.1 if (m.group(3) or m.group(4)) else 0.0)
    else:
        m2 = re.match(r'^(\d+)([a-z]?)(?:[\.\-\s_]+)', cleaned, re.I)
        if not m2:
            return 0.1
        num = int(m2.group(1))
        sub = (ord(m2.group(2).lower()) - ord('a') + 1) * 0.1 if m2.group(2) else 0.0
    if 'Agentic AI' in course and num >= 63:
        agentic_map = {
            63: 0.50, 64: 1.01, 65: 2.01, 66: 2.02,
            67: 3.01, 68: 3.02, 69: 3.03, 70: 4.01, 71: 4.02, 72: 4.03,
            73: 5.01, 74: 5.02, 75: 6.01, 76: 7.01, 77: 7.02,
            78: 8.01, 79: 8.02, 80: 10.01, 81: 10.02, 82: 12.01,
            83: 13.01, 84: 13.02, 85: 13.03, 86: 13.04, 87: 14.01,
            88: 17.01, 89: 15.01, 90: 15.02, 91: 18.01, 92: 18.02,
            93: 40.01, 94: 40.02, 95: 25.01, 96: 25.02,
            97: 24.01, 98: 24.02, 99: 24.03, 100: 24.04,
            101: 27.01, 102: 27.02, 103: 27.03, 104: 27.04, 105: 27.05,
            106: 28.01, 107: 29.01, 108: 33.01,
            109: 35.01, 110: 35.02, 111: 35.03, 112: 35.04, 113: 35.05,
            114: 36.01, 115: 39.01, 116: 39.02,
            **{n: 45.0 + (n - 116) * 0.01 for n in range(117, 129)},
            **{n: 47.0 + (n - 128) * 0.01 for n in range(129, 137)},
            **{n: 49.0 + (n - 136) * 0.01 for n in range(137, 146)},
            146: 50.01, 147: 50.02, 148: 50.03, 149: 52.01,
            150: 55.01, 151: 55.02, 152: 55.03, 153: 56.01, 154: 56.02, 155: 57.01,
        }
        return round(agentic_map.get(num, float(num)), 4)
    return round(float(num) + sub, 4)


@app.get('/api/videos')
def videos():
    vids = fetch_videos()
    with connect() as db:
        mapped = {r['video_id'] for r in db.execute('SELECT video_id FROM lecture_providers')}
        org_rows = {
            (r['course'], r['video_id']): dict(r)
            for r in db.execute('SELECT * FROM course_lesson_organization')
        }
    for v in vids:
        c_name = v.get('course', '')
        base_order = compute_flow_order(c_name, v.get('title', ''))
        org = org_rows.get((c_name, v['id']))
        v['cloud_ready'] = v['id'] in mapped
        v['base_flow_order'] = base_order
        v['flow_order'] = float(org['position']) if org and org.get('position') is not None else base_order
        v['section'] = (
            org['section_title']
            if org and org.get('section_title')
            else course_metadata.infer_section_title(c_name, v.get('title', ''), base_order)
        )
        v['item_type'] = 'video'
        v.pop('path', None)
    vids.sort(key=lambda x: (x.get('course', ''), x.get('flow_order', 9999.0), x.get('title', '')))
    return {'videos': vids}


@app.get('/api/courses')
def courses_catalog():
    return {'courses': [c for c in course_metadata.list_courses() if course_allowed(c['id'])]}


@app.get('/api/me/bootstrap')
def learner_bootstrap(request: Request):
    """One authenticated round trip for the lesson shell, with tenant filtering."""
    from .academy import my_learning
    from .player_sessions import get_preferences
    return {**auth.me(request), **videos(), **courses_catalog(),
            'materials': list_course_materials().get('materials', []),
            'progress': study.get_progress(), 'learning': my_learning(request),
            'preferences': get_preferences(request), 'options': auth.account_options()}


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


@app.get('/api/videos/{video_id}')
def get_video(video_id: str):
    video = fetch_video(video_id)
    if not video:
        raise HTTPException(404, 'Video not found')
    c_name = video.get('course', '')
    base_order = compute_flow_order(c_name, video.get('title', ''))
    with connect() as db:
        org = db.execute(
            'SELECT * FROM course_lesson_organization WHERE course=? AND video_id=?',
            (c_name, video_id),
        ).fetchone()
    video['cloud_ready'] = bool(find_odysee_info(video))
    video['base_flow_order'] = base_order
    video['flow_order'] = float(org['position']) if org and org['position'] is not None else base_order
    video['section'] = (
        org['section_title']
        if org and org['section_title']
        else course_metadata.infer_section_title(c_name, video.get('title', ''), base_order)
    )
    video.pop('path', None)
    return {'video': video, 'chunks': transcript_for_video(video_id),
            'checkpoints': checkpoints_for(video_id)}


def _load_odysee_docs_manifest() -> dict:
    import json
    for p in (settings.data_dir / 'odysee_docs_manifest.json', settings.courses_dir / 'odysee_docs_manifest.json'):
        if p.is_file():
            try:
                return json.loads(p.read_text())
            except Exception:
                pass
    return {}


def _fetch_odysee_doc_bytes(doc_entry: dict) -> bytes | None:
    import os
    import httpx
    token = os.getenv('ODYSEE_AUTH_TOKEN', '3Nj7vMUEayo8PLWgYTLMfpbcbtSzVj9f')
    cname = doc_entry.get('claim_name', '')
    cid = doc_entry.get('claim_id', '')
    if not token or not cname or not cid:
        return None
    try:
        with httpx.Client(timeout=25, follow_redirects=True) as client:
            r = client.post(
                'https://api.na-backend.odysee.com/api/v1/proxy?m=get',
                headers={'X-Lbry-Auth-Token': token},
                json={'jsonrpc': '2.0', 'id': 1, 'method': 'get', 'params': {'uri': f'lbry://{cname}#{cid}'}},
            )
            stream_url = ((r.json().get('result') or {}).get('streaming_url') or '').strip()
            if not stream_url:
                return None
            dl = client.get(stream_url, headers={'User-Agent': 'Mozilla/5.0', 'Referer': 'https://odysee.com/'})
            if dl.status_code == 200:
                return dl.content
    except Exception:
        return None
    return None


def _match_material_to_lesson(c_name: str, fname: str, ext: str, mat_flow: float, course_vids: list[dict], meta: dict | None) -> tuple[str, str | None, str]:
    """Return (scope, lesson_id, section_title) for a course material."""
    vid_by_id = {v['id']: v for v in course_vids}
    if meta:
        scope = meta.get('scope') or ('section' if not meta.get('lesson_id') and meta.get('section_title') else 'lesson')
        lid = meta.get('lesson_id')
        sec = meta.get('section_title') or ''
        if scope == 'section':
            return 'section', None, sec or course_metadata.infer_section_title(c_name, fname, mat_flow)
        if lid and lid in vid_by_id:
            return 'lesson', lid, sec or vid_by_id[lid].get('section') or course_metadata.infer_section_title(c_name, fname, mat_flow)
    # Default rule: .zip archives or course-wide reference packs are section-level shared files
    if ext in {'zip', 'tar', 'gz', 'tgz'} or ('deepak' in c_name.lower() and mat_flow >= 90):
        return 'section', None, course_metadata.infer_section_title(c_name, fname, mat_flow)
    if not course_vids:
        return 'section', None, course_metadata.infer_section_title(c_name, fname, mat_flow)
    # Match to the lesson whose base_flow_order is closest <= mat_flow (or the first lesson)
    ordered_by_base = sorted(course_vids, key=lambda v: (v.get('base_flow_order', 9999.0), v.get('title', '')))
    chosen = ordered_by_base[0]
    for v in ordered_by_base:
        if v.get('base_flow_order', 9999.0) <= mat_flow + 0.001:
            chosen = v
        else:
            break
    return 'lesson', chosen['id'], chosen.get('section') or course_metadata.infer_section_title(c_name, chosen.get('title', ''), chosen.get('base_flow_order', 1.0))


@app.get('/api/materials')
def list_course_materials(course: str | None = None):
    import os
    import urllib.parse
    root = settings.courses_dir.resolve()
    docs_manifest = _load_odysee_docs_manifest()
    all_vids = videos()['videos']
    vids_by_course: dict[str, list[dict]] = {}
    for v in all_vids:
        vids_by_course.setdefault(v['course'], []).append(v)
    with connect() as db:
        meta_rows = {
            (r['course'], r['filename']): dict(r)
            for r in db.execute('SELECT * FROM course_materials_meta')
        }
    seen: dict[tuple[str, str], dict] = {}
    if root.exists():
        for c_name in sorted(os.listdir(root)):
            if c_name.startswith('.'):
                continue
            if not course_allowed(c_name):
                continue
            if course and c_name != course:
                continue
            c_path = root / c_name
            if not c_path.is_dir() or c_path.resolve().parent != root:
                continue
            for fname in sorted(os.listdir(c_path)):
                if fname.startswith('.') or fname.lower().endswith('.mp4'):
                    continue
                fpath = c_path / fname
                if not fpath.is_file() or not fpath.resolve().is_relative_to(c_path.resolve()):
                    continue
                meta = meta_rows.get((c_name, fname))
                if meta and meta.get('removed'):
                    continue
                ext = fpath.suffix.lower().lstrip('.')
                m_key = f"{c_name}/{fname}"
                doc_info = docs_manifest.get(m_key, {})
                mat_flow = compute_flow_order(c_name, fname)
                course_vids = vids_by_course.get(c_name, [])
                scope, lid, sec = _match_material_to_lesson(c_name, fname, ext, mat_flow, course_vids, meta)
                if scope == 'lesson' and lid:
                    matched_vid = next((v for v in course_vids if v['id'] == lid), None)
                    if matched_vid is not None:
                        mat_flow = round(float(matched_vid.get('flow_order', mat_flow)) + 0.001, 4)
                url = f"/api/materials/{urllib.parse.quote(c_name)}/{urllib.parse.quote(fname)}"
                seen[(c_name, fname)] = {
                    "id": f"mat:{c_name}/{fname}",
                    "course": c_name,
                    "name": fname,
                    "title": (meta.get('friendly_name') if meta else None) or course_metadata.friendly_material_name(fname),
                    "friendly_name": (meta.get('friendly_name') if meta else None) or course_metadata.friendly_material_name(fname),
                    "material_type": (meta.get('material_type') if meta else None) or course_metadata.classify_material_type(fname),
                    "ext": ext,
                    "size_kb": round(fpath.stat().st_size / 1024, 1),
                    "cloud_ready": True,
                    "flow_order": mat_flow,
                    "scope": scope,
                    "lesson_id": lid,
                    "section": sec,
                    "item_type": "material",
                    "url": url,
                    "download_url": url + "?download=1",
                }
    for m_key, entry in sorted(docs_manifest.items()):
        if not isinstance(entry, dict):
            continue
        c_name = entry.get("course") or m_key.split("/", 1)[0]
        fname = entry.get("filename") or entry.get("name") or (m_key.split("/", 1)[1] if "/" in m_key else "")
        if not c_name or not fname or not course_allowed(c_name):
            continue
        if course and c_name != course:
            continue
        if (c_name, fname) not in seen:
            meta = meta_rows.get((c_name, fname))
            if meta and meta.get('removed'):
                continue
            ext = (entry.get("ext") or Path(fname).suffix.lower()).lstrip('.')
            size_kb = round((entry.get("size_bytes") or (entry.get("size_kb", 0) * 1024)) / 1024, 1)
            mat_flow = compute_flow_order(c_name, fname)
            course_vids = vids_by_course.get(c_name, [])
            scope, lid, sec = _match_material_to_lesson(c_name, fname, ext, mat_flow, course_vids, meta)
            if scope == 'lesson' and lid:
                matched_vid = next((v for v in course_vids if v['id'] == lid), None)
                if matched_vid is not None:
                    mat_flow = round(float(matched_vid.get('flow_order', mat_flow)) + 0.001, 4)
            url = f"/api/materials/{urllib.parse.quote(c_name)}/{urllib.parse.quote(fname)}"
            seen[(c_name, fname)] = {
                "id": f"mat:{c_name}/{fname}",
                "course": c_name,
                "name": fname,
                "title": (meta.get('friendly_name') if meta else None) or course_metadata.friendly_material_name(fname),
                "friendly_name": (meta.get('friendly_name') if meta else None) or course_metadata.friendly_material_name(fname),
                "material_type": (meta.get('material_type') if meta else None) or course_metadata.classify_material_type(fname),
                "ext": ext,
                "size_kb": size_kb,
                "cloud_ready": True,
                "flow_order": mat_flow,
                "scope": scope,
                "lesson_id": lid,
                "section": sec,
                "item_type": "material",
                "url": url,
                "download_url": url + "?download=1",
            }
    items = sorted(seen.values(), key=lambda x: (x["course"], x["flow_order"], x["name"]))
    return {"materials": items, "total": len(items), "cloud_mapped": sum(1 for x in items if x.get("cloud_ready"))}


@app.get('/api/materials/{course}/{filename}')
def get_course_material(course: str, filename: str, download: int = 0):
    import json
    import html
    import io
    import zipfile
    import xml.etree.ElementTree as ET
    import urllib.parse
    from fastapi.responses import HTMLResponse, Response
    if ".." in course or ".." in filename or "/" in course or "/" in filename:
        raise HTTPException(status_code=404, detail="Study material not found")
    root = settings.courses_dir.resolve()
    course_root = (root / course).resolve()
    target = (course_root / filename).resolve()
    docs_manifest = _load_odysee_docs_manifest()
    doc_entry = docs_manifest.get(f"{course}/{filename}")

    raw_bytes: bytes | None = None
    if doc_entry:
        if target.is_relative_to(course_root) and target.is_file():
            raw_bytes = target.read_bytes()
        else:
            raw_bytes = _fetch_odysee_doc_bytes(doc_entry)
            if raw_bytes is not None and course_root.parent == root:
                try:
                    course_root.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(raw_bytes)
                except Exception:
                    pass
    elif course_root.parent == root and target.is_relative_to(course_root) and target.is_file():
        raw_bytes = target.read_bytes()

    if raw_bytes is None:
        raise HTTPException(status_code=404, detail="Study material not found")

    ext = Path(filename).suffix.lower()
    dl_url = f"/api/materials/{urllib.parse.quote(course)}/{urllib.parse.quote(filename)}?download=1"
    if download or ext in ('.html', '.htm', '.svg', '.xml', '.xhtml'):
        return Response(
            content=raw_bytes,
            media_type='application/pdf' if ext == '.pdf' else 'application/octet-stream',
            headers={'Content-Disposition': f'attachment; filename="{filename}"'},
        )

    if ext == '.pdf':
        return Response(
            content=raw_bytes,
            media_type='application/pdf',
            headers={'Content-Disposition': f'inline; filename="{filename}"'},
        )

    friendly = course_metadata.friendly_material_name(filename)
    mtype = course_metadata.classify_material_type(filename)
    badge = (
        f"<span style='display:inline-block;padding:4px 10px;font-size:11px;border-radius:99px;"
        f"background:#1e293b;color:#38bdf8;border:1px solid rgba(56,189,248,0.3)'>{html.escape(mtype)} · {round(len(raw_bytes)/1024, 1)} KB</span>"
    )
    dl_btn = (
        f"<a href='{dl_url}' download='{html.escape(filename)}' style='display:inline-block;padding:8px 16px;font-size:13px;font-weight:600;min-height:44px;line-height:28px;"
        f"border-radius:8px;background:#4f46e5;color:#fff;text-decoration:none'>Download {html.escape(mtype)} ({round(len(raw_bytes)/1024, 1)} KB)</a>"
    )
    header_bar = (
        f"<div style='display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;"
        f"padding-bottom:14px;margin-bottom:18px;border-bottom:1px solid rgba(255,255,255,0.12)'>"
        f"<div><h2 style='margin:0 0 6px 0;font-size:18px;color:#f8fafc'>{html.escape(friendly)}</h2>{badge}</div>"
        f"<div>{dl_btn}</div></div>"
    )
    base_style = (
        "body{background:#0f1420;color:#f1f5f9;font-family:system-ui,-apple-system,sans-serif;padding:20px 24px;max-width:1020px;margin:0 auto;line-height:1.55}"
        "pre{background:#0b0f19;padding:14px 16px;border-radius:10px;border:1px solid rgba(255,255,255,0.12);overflow:auto;font-size:13px;line-height:1.5;color:#e2e8f0}"
        ".card{background:#161f33;border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:16px 20px;margin-bottom:14px}"
    )

    if ext == '.ipynb':
        try:
            nb = json.loads(raw_bytes.decode('utf-8', errors='ignore'))
            cells_html = []
            for idx, cell in enumerate(nb.get('cells', []), 1):
                ctype = cell.get('cell_type', 'code')
                src = ''.join(cell.get('source', []))
                esc = html.escape(src)
                if ctype == 'markdown':
                    cells_html.append(f"<div class='card' style='white-space:pre-wrap'>{esc}</div>")
                else:
                    out_parts = []
                    for out in cell.get('outputs', [])[:5]:
                        txt = ''.join(out.get('text', []) or out.get('data', {}).get('text/plain', []))
                        if txt:
                            out_parts.append(f"<pre style='margin-top:6px;background:#090d16;color:#94a3b8;font-size:12px'>{html.escape(txt[:4000])}</pre>")
                    cells_html.append(
                        f"<div style='margin-bottom:14px'><div style='font-size:11px;color:#38bdf8;margin-bottom:4px;font-family:monospace'>In [{idx}]:</div>"
                        f"<pre style='margin:0'>{esc}</pre>{''.join(out_parts)}</div>"
                    )
            page = f"<!doctype html><html><head><meta charset='utf-8'><title>{html.escape(filename)}</title><style>{base_style}</style></head><body>{header_bar}{''.join(cells_html)}</body></html>"
            return HTMLResponse(page)
        except Exception:
            pass

    if ext in ('.py', '.txt', '.sql', '.csv', '.md', '.json', '.yaml', '.yml'):
        raw = raw_bytes.decode('utf-8', errors='ignore')[:250000]
        page = f"<!doctype html><html><head><meta charset='utf-8'><title>{html.escape(filename)}</title><style>{base_style}</style></head><body>{header_bar}<pre>{html.escape(raw)}</pre></body></html>"
        return HTMLResponse(page)

    if ext == '.pptx':
        try:
            zf = zipfile.ZipFile(io.BytesIO(raw_bytes))
            slide_files = sorted(
                [n for n in zf.namelist() if n.startswith('ppt/slides/slide') and n.endswith('.xml')],
                key=lambda s: int(''.join(filter(str.isdigit, s)) or 0),
            )
            slides_html = []
            for idx, sname in enumerate(slide_files, 1):
                root_xml = ET.fromstring(zf.read(sname))
                texts = [t.text.strip() for t in root_xml.iter() if t.tag.endswith('}t') and t.text and t.text.strip()]
                body_txt = '\n'.join(texts) if texts else '(Visual diagram slide — download PPTX to view graphics)'
                slides_html.append(
                    f"<div class='card'><div style='font-size:12px;font-weight:700;color:#38bdf8;margin-bottom:8px'><svg style='width:16px;height:16px;vertical-align:-2px;margin-right:6px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round' viewBox='0 0 24 24'><rect x='2' y='3' width='20' height='14' rx='2'/><path d='M8 21h8'/><path d='M12 17v4'/><polygon points='10 8 15 10 10 12 10 8'/></svg>Slide {idx} of {len(slide_files)}</div>"
                    f"<div style='white-space:pre-wrap;font-size:14px'>{html.escape(body_txt)}</div></div>"
                )
            page = f"<!doctype html><html><head><meta charset='utf-8'><title>{html.escape(filename)}</title><style>{base_style}</style></head><body>{header_bar}{''.join(slides_html)}</body></html>"
            return HTMLResponse(page)
        except Exception:
            pass

    if ext == '.docx':
        try:
            zf = zipfile.ZipFile(io.BytesIO(raw_bytes))
            root_xml = ET.fromstring(zf.read('word/document.xml'))
            paras = []
            for p in root_xml.iter():
                if p.tag.endswith('}p'):
                    line = ''.join(t.text for t in p.iter() if t.tag.endswith('}t') and t.text)
                    if line.strip():
                        paras.append(line.strip())
            body_txt = '\n\n'.join(paras)
            page = f"<!doctype html><html><head><meta charset='utf-8'><title>{html.escape(filename)}</title><style>{base_style}</style></head><body>{header_bar}<div class='card' style='white-space:pre-wrap'>{html.escape(body_txt)}</div></body></html>"
            return HTMLResponse(page)
        except Exception:
            pass

    if ext == '.zip':
        try:
            zf = zipfile.ZipFile(io.BytesIO(raw_bytes))
            infos = [i for i in zf.infolist() if not i.is_dir() and '__MACOSX' not in i.filename]
            listing = "\n".join(f"• {i.filename} ({round(i.file_size/1024, 1)} KB)" for i in infos)
            previews = [f"<div class='card'><div style='font-weight:700;color:#38bdf8;margin-bottom:8px'><svg style='width:16px;height:16px;vertical-align:-2px;margin-right:6px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round' viewBox='0 0 24 24'><rect x='3' y='3' width='18' height='4' rx='1'/><rect x='4' y='7' width='16' height='14' rx='2'/><line x1='10' y1='12' x2='14' y2='12'/></svg>Archive Contents ({len(infos)} files)</div><pre>{html.escape(listing)}</pre></div>"]
            for i in infos[:12]:
                sub_ext = Path(i.filename).suffix.lower()
                if sub_ext in ('.py', '.txt', '.md', '.json', '.sql', '.yaml', '.yml') and i.file_size < 120000:
                    sub_txt = zf.read(i.filename).decode('utf-8', errors='ignore')
                    previews.append(f"<div class='card'><div style='font-size:12px;font-weight:700;color:#74c0fc;margin-bottom:6px'><svg style='width:14px;height:14px;vertical-align:-2px;margin-right:6px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round' viewBox='0 0 24 24'><path d='M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z'/><polyline points='14 2 14 8 20 8'/></svg>{html.escape(i.filename)}</div><pre>{html.escape(sub_txt[:20000])}</pre></div>")
            page = f"<!doctype html><html><head><meta charset='utf-8'><title>{html.escape(filename)}</title><style>{base_style}</style></head><body>{header_bar}{''.join(previews)}</body></html>"
            return HTMLResponse(page)
        except Exception:
            pass

    page = (
        f"<!doctype html><html><head><meta charset='utf-8'><title>{html.escape(dir_friendly if 'dir_friendly' in locals() else filename)}</title><style>{base_style}</style></head>"
        f"<body>{header_bar}<div class='card'><h3><svg style='width:20px;height:20px;vertical-align:-3px;margin-right:8px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round' viewBox='0 0 24 24'><ellipse cx='12' cy='5' rx='9' ry='3'/><path d='M21 12c0 1.66-4 3-9 3s-9-1.34-9-3'/><path d='M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5'/></svg>Dataset / Study File</h3>"
        f"<p>This study file (<code>{html.escape(filename)}</code>, {round(len(raw_bytes)/1024, 1)} KB) is ready to download. Click the download button above to open it on your device.</p></div></body></html>"
    )
    return HTMLResponse(page)


@app.get('/api/search')
def universal_search(q: str = '', course: str | None = None, video_id: str | None = None):
    needle = q.strip().lower()
    if not needle:
        return {'query': '', 'courses': [], 'lessons': [], 'materials': [], 'moments': [], 'results': []}
    all_courses = courses_catalog()['courses']
    all_lessons = videos()['videos']
    all_materials = list_course_materials()['materials']
    matched_courses = [
        {**c, 'course': c.get('id')} for c in all_courses
        if any(
            needle in str(val or '').lower()
            for val in (c.get('id'), c.get('title'), c.get('category'), c.get('instructor'), ' '.join(c.get('tags') or []))
        )
    ]
    matched_lessons = [
        v for v in all_lessons
        if any(
            needle in str(val or '').lower()
            for val in (v.get('title'), v.get('section'), v.get('course'))
        )
    ]
    matched_materials = [
        m for m in all_materials
        if any(
            needle in str(val or '').lower()
            for val in (m.get('friendly_name'), m.get('name'), m.get('material_type'), m.get('section'), m.get('course'))
        )
    ]
    # Search transcript moments across indexed videos
    raw_moments = keyword_search(q.strip(), course=course, video_id=video_id, limit=15)
    if not raw_moments:
        with connect() as conn:
            needle = f"%{q.strip()}%"
            sql = '''SELECT c.*, v.title, v.course FROM chunks c
                     JOIN videos v ON v.id = c.video_id
                     WHERE c.text LIKE ? AND cf_course_allowed(v.course)'''
            params = [needle]
            if course:
                sql += ' AND v.course = ?'
                params.append(course)
            if video_id:
                sql += ' AND c.video_id = ?'
                params.append(video_id)
            sql += ' ORDER BY c.start LIMIT 15'
            raw_moments = [dict(r) for r in conn.execute(sql, params).fetchall()]
    moments = []
    for m in raw_moments:
        start_sec = float(m.get('start', 0))
        mins = int(start_sec // 60)
        secs = int(start_sec % 60)
        t_label = f"{mins}:{secs:02d}"
        t_clean = re.sub(r'^\[\d+(?: Part\d+)?\]\s*', '', str(m.get('title', '')))
        t_clean = re.sub(r'\s*(?:\[Live\]|\(Live\))\s*', ' ', t_clean, flags=re.IGNORECASE).strip()
        moments.append({
            'chunk_id': m.get('id'),
            'video_id': m.get('video_id'),
            'title': t_clean,
            'course': m.get('course'),
            'start': start_sec,
            'end': float(m.get('end', 0)),
            'time_label': t_label,
            'text': m.get('text', '').strip()[:180],
            'display': f"{t_clean} at {t_label}",
            'action_url': f"#learning/{m.get('video_id')}?t={int(start_sec)}",
        })

    return {
        'query': q.strip(),
        'courses': matched_courses[:20],
        'lessons': matched_lessons[:30],
        'materials': matched_materials[:30],
        'moments': moments,
        'results': moments,
    }


from .media import provider_info as find_odysee_info
from .media import router as media_router
app.include_router(media_router)
from .native_player import router as native_router
app.include_router(native_router)


@app.api_route('/api/videos/{video_id}/stream', methods=['GET', 'HEAD'])
def stream(video_id: str, request: Request):
    video=fetch_video(video_id)
    if not video:
        raise HTTPException(404, 'Video not found')
    if auth.require_user(request)['role']=='admin':
        path=Path(video['path']).resolve()
        if path.is_relative_to(settings.courses_dir.resolve()) and path.is_file():
            return FileResponse(path,content_disposition_type='inline')
    raise HTTPException(409, 'Open this lecture with the CourseForge embedded player')


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


@app.post('/api/ask',status_code=202)
def ask_tutor(body: QueryBody, request: Request):
    if request.query_params.get('sync') == '1' or request.headers.get('x-sync') == '1':
        return JSONResponse(tutor.ask(question=body.question, mode=body.mode, course=body.course, video_id=body.video_id), status_code=200)
    try:
        return enqueue('ask',body.model_dump())
    except HTTPException:
        raise
    except Exception as exc:
        # Avoid leaking backend credentials/paths in error responses.
        raise HTTPException(status_code=503, detail='AI services unavailable or search failed. '
                            'Check Ollama, Qdrant, pulled models and worker logs.') from exc




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


@app.post('/api/syllabus/generate',status_code=202)
def build_syllabus(body: CourseBody):
    try:
        return enqueue('syllabus',{'course':body.course})
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except HTTPException:
        raise
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


@app.post('/api/learning-paths', status_code=202)
def create_learning_path(body: LearningPathBody):
    try:
        for course in body.courses:
            if not syllabus.get_syllabus(course):
                raise learning_paths.PathInputError('Build the course syllabus before creating a learning path')
        return enqueue('path',body.model_dump())
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


@app.post('/api/learning-paths/{path_id}/steps/{step_id}/assessments', status_code=202)
def create_topic_assessment(path_id: str, step_id: str, body: AssessmentCreateBody):
    try:
        assessments._step(path_id,step_id)
        return enqueue('assessment',{'path_id':path_id,'step_id':step_id,'count':body.count})
    except assessments.AssessmentNotFound as exc:
        raise HTTPException(404, str(exc)) from exc
    except assessments.AssessmentConflict as exc:
        raise HTTPException(409, str(exc)) from exc
    except assessments.AssessmentInputError as exc:
        raise HTTPException(422, str(exc)) from exc
    except HTTPException:
        raise
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


@app.post('/api/reviews/generate',status_code=202)
def create_review_cards(body: CardCreateBody, request: Request):
    if request.query_params.get('sync') == '1' or request.headers.get('x-sync') == '1':
        return JSONResponse(reviews.generate_cards(course=body.course, topic=body.topic, count=body.count), status_code=200)
    try:
        return enqueue('reviews',body.model_dump())
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except HTTPException:
        raise
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


@app.post('/api/lab-sessions/{session_id}/submit',status_code=202)
def submit_lab(session_id: str, body: LabSubmitBody):
    try:
        labs.get_lab(session_id)
        return enqueue('lab',{'session_id':session_id,'kind':body.validate_in_kind})
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
    position: float = Field(ge=0, lt=1e9, allow_inf_nan=False)


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


class LessonQuizSubmitBody(BaseModel):
    quiz_id: str
    answers: dict[str, int]


class ReviewCompleteBody(BaseModel):
    course: str | None = None
    cards_count: int = 1


@app.get('/api/videos/{video_id}/quiz')
def get_video_quiz(video_id: str, request: Request):
    auth.require_user(request)
    try:
        return retention.get_or_create_quiz(video_id)
    except KeyError:
        raise HTTPException(404, 'Video not found')


@app.post('/api/videos/{video_id}/quiz/attempts', status_code=201)
def submit_video_quiz(video_id: str, body: LessonQuizSubmitBody, request: Request):
    user = auth.require_user(request)
    try:
        return retention.submit_quiz(video_id, body.quiz_id, body.answers, user['id'])
    except KeyError as exc:
        raise HTTPException(404, str(exc))
    except ValueError as exc:
        raise HTTPException(422, str(exc))


@app.get('/api/courses/{course}/quizzes/status')
def get_course_quizzes_status(course: str, request: Request):
    user = auth.require_user(request)
    return {'status': retention.get_quiz_status_for_course(user['id'], course)}


@app.post('/api/reviews/complete', status_code=201)
def complete_review(body: ReviewCompleteBody, request: Request):
    user = auth.require_user(request)
    return retention.complete_review_session(user['id'], body.course, body.cards_count)


@app.get('/api/courses/{course}/certificate')
def course_certificate(course: str, request: Request):
    user = auth.require_user(request)
    return retention.check_or_issue_certificate(user['id'], course)


@app.get('/api/certificates/verify/{code}')
def verify_certificate_api(code: str):
    res = retention.verify_certificate(code)
    if not res.get('valid'):
        raise HTTPException(404, 'Certificate not found')
    return res


@app.get('/verify/{code}')
def verify_certificate_page(code: str):
    from fastapi.responses import HTMLResponse
    res = retention.verify_certificate(code)
    if not res.get('valid'):
        html = f"""<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Certificate Not Found · CourseForge</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{{font-family:system-ui,-apple-system,sans-serif;background:#0b0f19;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px;}}
.card{{background:#1e293b;border:1px solid #334155;border-radius:16px;max-width:480px;padding:32px;text-align:center;}}
h1{{color:#ef4444;font-size:1.5rem;margin-top:0;}}
p{{color:#94a3b8;line-height:1.5;}}
a{{color:#6366f1;text-decoration:none;}}
</style>
</head>
<body>
<div class="card">
<h1>Certificate Not Found</h1>
<p>The verification code <strong>{code}</strong> does not correspond to a valid CourseForge credential.</p>
<p><a href="/">Return to CourseForge</a></p>
</div>
</body>
</html>"""
        return HTMLResponse(content=html, status_code=404)

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Official Certificate of Completion · {res['student_name']}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{{--bg:#090d16;--card:#111827;--border:#1f293d;--accent:#6366f1;--text:#f8fafc;--muted:#94a3b8;}}
*{{box-sizing:border-box;}}
body{{font-family:'Inter',system-ui,-apple-system,sans-serif;background:radial-gradient(circle at 50% 10%,#1e1b4b 0%,#090d16 60%);color:var(--text);margin:0;padding:24px;min-height:100vh;display:flex;align-items:center;justify-content:center;}}
.cert-frame{{background:var(--card);border:2px solid var(--border);box-shadow:0 25px 50px -12px rgba(0,0,0,0.7),0 0 0 1px rgba(99,102,241,0.2);border-radius:24px;max-width:760px;width:100%;padding:48px 40px;position:relative;text-align:center;overflow:hidden;}}
.badge{{display:inline-flex;align-items:center;gap:8px;background:rgba(99,102,241,0.15);border:1px solid rgba(99,102,241,0.3);color:#a5b4fc;padding:6px 16px;border-radius:999px;font-size:0.85rem;font-weight:600;letter-spacing:0.05em;text-transform:uppercase;margin-bottom:24px;}}
h1{{font-size:1.15rem;letter-spacing:0.1em;text-transform:uppercase;color:var(--muted);margin:0 0 12px 0;font-weight:600;}}
.student-name{{font-size:2.2rem;font-weight:800;letter-spacing:-0.02em;color:#fff;margin:0 0 16px 0;background:linear-gradient(135deg,#ffffff 0%,#c7d2fe 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;}}
.cert-text{{color:var(--muted);font-size:1rem;margin:0 0 16px 0;}}
.course-title{{font-size:1.5rem;font-weight:700;color:#e0e7ff;margin:0 0 28px 0;line-height:1.3;}}
.cert-meta{{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;background:rgba(15,23,42,0.6);border:1px solid var(--border);border-radius:16px;padding:20px;margin-bottom:28px;text-align:left;}}
.meta-item span{{display:block;font-size:0.75rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;}}
.meta-item strong{{font-size:0.95rem;color:#f8fafc;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}}
.seal{{display:flex;align-items:center;justify-content:center;gap:12px;color:#10b981;font-weight:600;font-size:0.95rem;margin-bottom:20px;}}
.seal-icon{{background:rgba(16,185,129,0.15);border:1px solid rgba(16,185,129,0.3);width:32px;height:32px;border-radius:50%;display:grid;place-items:center;}}
.actions{{display:flex;justify-content:center;gap:12px;flex-wrap:wrap;}}
.btn{{background:var(--accent);color:#fff;padding:10px 22px;border-radius:10px;text-decoration:none;font-weight:600;font-size:0.9rem;border:none;cursor:pointer;display:inline-flex;align-items:center;gap:8px;}}
.btn-outline{{background:transparent;border:1px solid var(--border);color:var(--text);}}
@media(max-width:540px){{.cert-frame{{padding:32px 20px;border-radius:18px;}}.student-name{{font-size:1.75rem;}}.course-title{{font-size:1.25rem;}}}}
</style>
</head>
<body>
<div class="cert-frame">
  <div class="badge">Official Credential</div>
  <h1>Certificate of Completion</h1>
  <div class="student-name">{res['student_name']}</div>
  <p class="cert-text">has successfully completed all lectures, curriculum requirements, and mastery assessments for</p>
  <div class="course-title">{res['course']}</div>
  <div class="cert-meta">
    <div class="meta-item"><span>Issue Date</span><strong>{res['completed_at'][:10]}</strong></div>
    <div class="meta-item"><span>Verification Code</span><strong>{res['verification_code']}</strong></div>
    <div class="meta-item"><span>Status</span><strong style="color:#10b981">Verified Valid</strong></div>
  </div>
  <div class="seal">
    <div class="seal-icon"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg></div>
    <span>Verified by CourseForge Learning Platform</span>
  </div>
  <div class="actions">
    <button class="btn" onclick="window.print()">Print / Save PDF</button>
    <a class="btn btn-outline" href="/">Explore CourseForge</a>
  </div>
</div>
</body>
</html>"""
    return HTMLResponse(content=html)


class InterviewStartBody(BaseModel):
    topic_id: str = Field(min_length=2, max_length=100)
    course: str = Field(default='', max_length=200)


class InterviewEvaluateBody(BaseModel):
    session_id: str = Field(min_length=2, max_length=100)
    answer: str = Field(min_length=1, max_length=5000)


class PlacementSubmitBody(BaseModel):
    answers: dict[str, int]


class QuizUpdateAdminBody(BaseModel):
    questions: list[dict[str, Any]]
    status: str = Field(default='approved')


@app.get('/api/videos/{video_id}/brief')
def get_video_brief(video_id: str):
    return companion.get_or_create_lesson_brief(video_id)


@app.get('/api/smart-resume')
def get_learner_smart_resume(request: Request):
    user = auth.require_user(request)
    return companion.get_smart_resume(user['id'])


@app.get('/api/reviews/adaptive')
def get_adaptive_reviews(request: Request, course: str | None = None, limit: int = 20):
    user = auth.require_user(request)
    return {'cards': companion.get_adaptive_review_cards(user['id'], course=course, limit=limit)}


@app.get('/api/interview-prep/topics')
def get_interview_topics_api(request: Request):
    user = auth.require_user(request)
    return {'topics': companion.get_interview_topics(user['id'])}


@app.post('/api/interview-prep/start', status_code=201)
def start_interview_prep(body: InterviewStartBody, request: Request):
    user = auth.require_user(request)
    return companion.start_interview_session(user['id'], body.topic_id, body.course)


@app.post('/api/interview-prep/evaluate')
def evaluate_interview_prep(body: InterviewEvaluateBody, request: Request):
    user = auth.require_user(request)
    try:
        return companion.evaluate_interview_answer(body.session_id, user['id'], body.answer)
    except ValueError as exc:
        raise HTTPException(404, str(exc))


@app.get('/api/courses/{course}/placement-test')
def get_placement_test(course: str):
    return companion.get_placement_diagnostic(course)


@app.post('/api/courses/{course}/placement-test/submit', status_code=201)
def submit_placement_test(course: str, body: PlacementSubmitBody, request: Request):
    user = auth.require_user(request)
    return companion.evaluate_placement_diagnostic(user['id'], course, body.answers)


@app.get('/api/admin/teacher-insights')
def get_admin_teacher_insights(request: Request):
    user = auth.require_user(request)
    if user.get('role') != 'admin':
        raise HTTPException(403, 'Admin access required')
    return companion.get_teacher_insights()


@app.get('/api/admin/courses/{course}/quizzes')
def get_admin_course_quizzes(course: str, request: Request):
    user = auth.require_user(request)
    if user.get('role') != 'admin':
        raise HTTPException(403, 'Admin access required')
    return {'quizzes': companion.list_course_quizzes_admin(course)}


@app.get('/api/admin/quizzes/{quiz_id}')
def get_admin_quiz(quiz_id: str, request: Request):
    user = auth.require_user(request)
    if user.get('role') != 'admin':
        raise HTTPException(403, 'Admin access required')
    try:
        return companion.get_quiz_admin(quiz_id)
    except ValueError as exc:
        raise HTTPException(404, str(exc))


@app.put('/api/admin/quizzes/{quiz_id}')
def update_admin_quiz(quiz_id: str, body: QuizUpdateAdminBody, request: Request):
    user = auth.require_user(request)
    if user.get('role') != 'admin':
        raise HTTPException(403, 'Admin access required')
    return companion.update_quiz_admin(quiz_id, body.questions, body.status)


@app.post('/api/admin/videos/{video_id}/quiz/regenerate')
def regenerate_admin_quiz(video_id: str, request: Request):
    user = auth.require_user(request)
    if user.get('role') != 'admin':
        raise HTTPException(403, 'Admin access required')
    return companion.regenerate_quiz_admin(video_id)

