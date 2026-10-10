"""CourseForge academy: account-protected learning APIs and public catalog."""
from pathlib import Path
from contextlib import asynccontextmanager
from typing import Literal
import os
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
from .tutor import ask, retrieve
from . import syllabus, study, labs, reviews, studio, course_metadata, learning_paths, assessments, practice, planner, weekly, focus
from . import auth
from .db import learner_id, learner_courses, connect, course_allowed

@asynccontextmanager
async def lifespan(_app: FastAPI):
    settings.courses_dir.mkdir(parents=True, exist_ok=True)
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    init_db()
    from .academy import maintenance_loop
    import asyncio
    _app.state.media_slots = asyncio.Semaphore(24)
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
allowed_hosts = [host.strip() for host in os.getenv('ALLOWED_HOSTS', 'localhost,127.0.0.1,testserver').split(',') if host.strip()]
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
            (path.startswith('/api/admin/') or (path.startswith('/api/courses/') and not path.endswith('/enroll')) or
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
        if request.url.path.startswith('/api/'):
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

static_path = Path(__file__).parent / 'static'
app.mount('/static', StaticFiles(directory=static_path), name='static')


@app.get('/')
def index():
    return FileResponse(static_path / 'index.html')


@app.get('/api/health')
def health():
    return {'status': 'ok', 'version':'0.4.0'}


@app.post('/api/scan')
def scan():
    return scan_courses()


@app.get('/api/videos')
def videos():
    vids = fetch_videos()
    with connect() as db:
        mapped = {r['video_id'] for r in db.execute('SELECT video_id FROM lecture_providers')}
    for v in vids:
        v['cloud_ready'] = v['id'] in mapped
        v.pop('path', None)
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
    video['cloud_ready'] = bool(find_odysee_info(video))
    video.pop('path', None)
    return {'video': video, 'chunks': transcript_for_video(video_id)}


@app.get('/api/materials')
def list_course_materials(course: str | None = None):
    import os
    root = settings.courses_dir.resolve()
    items = []
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
    import html
    from fastapi.responses import HTMLResponse
    root = settings.courses_dir.resolve()
    course_root = (root / course).resolve()
    target = (course_root / filename).resolve()
    if course_root.parent != root or not target.is_relative_to(course_root) or not target.is_file() or ".." in course or ".." in filename:
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
            page = f"<!doctype html><html><head><meta charset='utf-8'><title>{html.escape(filename)}</title><style>body{{background:#0f1420;color:#f1f5f9;font-family:system-ui,sans-serif;padding:24px;max-width:980px;margin:0 auto}}</style></head><body><h2> {html.escape(filename)}</h2>{''.join(cells_html)}</body></html>"
            return HTMLResponse(page, headers={'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'"})
        except Exception:
            pass
    if ext in ('.py', '.txt', '.sql', '.csv', '.md', '.json'):
        import html as _h
        raw = target.read_text(errors='ignore')[:200000]
        page = f"<!doctype html><html><head><meta charset='utf-8'><title>{html.escape(filename)}</title><style>body{{background:#0f1420;color:#f1f5f9;font-family:system-ui,sans-serif;padding:24px;max-width:980px;margin:0 auto}}pre{{background:#0b0f19;padding:16px;border-radius:10px;border:1px solid rgba(255,255,255,0.12);overflow:auto;font-size:13px;line-height:1.5}}</style></head><body><h2> {html.escape(filename)}</h2><pre>{_h.escape(raw)}</pre></body></html>"
        return HTMLResponse(page, headers={'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'"})
    return FileResponse(target, filename=filename, content_disposition_type='inline' if ext=='.pdf' else 'attachment',
                        headers={'Content-Security-Policy': "sandbox; default-src 'none'"})


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
def ask_tutor(body: QueryBody):
    try:
        return enqueue('ask',body.model_dump())
    except HTTPException:
        raise
    except Exception as exc:
        # Avoid leaking backend credentials/paths in error responses.
        raise HTTPException(status_code=503, detail='AI services unavailable or search failed. '
                            'Check Ollama, Qdrant, pulled models and worker logs.') from exc


@app.get('/api/search')
def search(q: str = Query(min_length=2, max_length=500), course: str | None = None,
           video_id: str | None = None):
    try:
        # Model-based retrieval runs in queued tutor tasks, keeping browsing
        # independent of model latency and resource limits.
        return {'results': [dict(hit,chunk_id=hit['id']) for hit in keyword_search(q,course=course,video_id=video_id,limit=10)]}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=503, detail='Course search is temporarily unavailable.') from exc


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
def create_review_cards(body: CardCreateBody):
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
