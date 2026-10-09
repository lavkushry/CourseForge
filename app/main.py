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
from . import syllabus, study, labs, reviews, studio, course_metadata, learning_paths

@asynccontextmanager
async def lifespan(_app: FastAPI):
    settings.courses_dir.mkdir(parents=True, exist_ok=True)
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    init_db()
    yield


app = FastAPI(title='CourseForge Local', version='0.3.0', docs_url='/api/docs',
              redoc_url=None, lifespan=lifespan)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=['localhost', '127.0.0.1', '[::1]', 'testserver'])

@app.middleware('http')
async def guard_local_actions(request: Request, call_next):
    # Reject cross-origin browser form/JS mutations to unauthenticated localhost APIs.
    if request.method in ('POST','PUT','PATCH','DELETE'):
        origin = request.headers.get('origin')
        if origin and origin.rstrip('/') != str(request.base_url).rstrip('/'):
            from fastapi.responses import JSONResponse
            return JSONResponse({'detail':'Cross-origin local changes prohibited'}, status_code=403)
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
    return {'videos': fetch_videos()}


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


@app.get('/api/videos/{video_id}')
def get_video(video_id: str):
    video = fetch_video(video_id)
    if not video:
        raise HTTPException(status_code=404, detail='Video not found')
    return {'video': video, 'chunks': transcript_for_video(video_id)}


def safe_video(video_id: str) -> Path:
    video = fetch_video(video_id)
    if not video:
        raise HTTPException(status_code=404, detail='Video not found')
    path = Path(video['path']).resolve()
    if not path.is_file() or not path.is_relative_to(settings.courses_dir):
        raise HTTPException(status_code=404, detail='Source file unavailable')
    return path


@app.get('/api/videos/{video_id}/stream')
def stream_video(video_id: str):
    # FileResponse in Starlette supports HTTP Range for browser video seeking.
    return FileResponse(safe_video(video_id), content_disposition_type='inline')


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
        return labs.submit_lab(session_id, kind=body.validate_in_kind)
    except KeyError:
        raise HTTPException(404,'Lab not found')
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(503,str(exc)) from exc


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
