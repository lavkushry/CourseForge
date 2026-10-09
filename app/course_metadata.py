"""Local course catalog metadata and safe, on-demand thumbnail generation.

Course keys remain the original top-level folder names: renaming a display title
must never change the source identifier used by lessons, indexes or reviews.
"""
from __future__ import annotations

import hashlib
import io
import json
import logging
import shutil
import subprocess
import uuid
from pathlib import Path

from PIL import Image, ImageOps, UnidentifiedImageError

from .config import settings
from .db import connect, utcnow

log = logging.getLogger(__name__)
MAX_IMAGE_BYTES = 4 * 1024 * 1024
MAX_IMAGE_PIXELS = 30_000_000
ALLOWED_MIME = {'image/jpeg', 'image/png', 'image/webp'}


class UnknownCourse(KeyError):
    pass


def ensure_schema(path: Path | None = None) -> None:
    with connect(path) as conn:
        conn.execute('''CREATE TABLE IF NOT EXISTS course_metadata (
            course TEXT PRIMARY KEY,
            title TEXT,
            instructor TEXT,
            category TEXT,
            tags_json TEXT NOT NULL DEFAULT '[]',
            cover_kind TEXT,
            updated_at TEXT NOT NULL
        )''')


def _catalog_row(course: str, path: Path | None = None) -> dict:
    with connect(path) as conn:
        videos = conn.execute('''SELECT id,path,duration,status FROM videos
            WHERE course=? ORDER BY title COLLATE NOCASE''', (course,)).fetchall()
        if not videos:
            raise UnknownCourse(course)
        record = conn.execute('SELECT * FROM course_metadata WHERE course=?', (course,)).fetchone()
    metadata = dict(record) if record else {}
    tags = json.loads(metadata.get('tags_json') or '[]')
    return {
        'id': course,
        'title': metadata.get('title') or course,
        'instructor': metadata.get('instructor'),
        'category': metadata.get('category'),
        'tags': tags,
        'cover_kind': metadata.get('cover_kind'),
        'updated_at': metadata.get('updated_at'),
        'lesson_count': len(videos),
        'duration': sum(v['duration'] or 0 for v in videos),
        'indexed_count': sum(v['status'] == 'done' for v in videos),
        'cover_url': f'/api/courses/{_quote(course)}/cover',
    }


def _quote(course: str) -> str:
    from urllib.parse import quote
    return quote(course, safe='')


def list_courses(path: Path | None = None) -> list[dict]:
    with connect(path) as conn:
        names = [r[0] for r in conn.execute('SELECT DISTINCT course FROM videos ORDER BY course COLLATE NOCASE')]
    return [_catalog_row(name, path) for name in names]


def get_course(course: str, path: Path | None = None) -> dict:
    return _catalog_row(course, path)


def save_course(course: str, fields: dict, path: Path | None = None) -> dict:
    # Validate presence before modifying the catalog. Only curated columns are allowed.
    _catalog_row(course, path)
    with connect(path) as conn:
        original = conn.execute('SELECT * FROM course_metadata WHERE course=?', (course,)).fetchone()
        old = dict(original) if original else {}
        new = {
            'title': old.get('title'),
            'instructor': old.get('instructor'),
            'category': old.get('category'),
            'tags_json': old.get('tags_json') or '[]',
            'cover_kind': old.get('cover_kind'),
        }
        for field in ('title', 'instructor', 'category'):
            if field in fields:
                val = fields[field]
                new[field] = val.strip() if isinstance(val, str) and val.strip() else None
        if 'tags' in fields:
            new['tags_json'] = json.dumps(fields['tags'], ensure_ascii=False)
        conn.execute('''INSERT INTO course_metadata
            (course,title,instructor,category,tags_json,cover_kind,updated_at)
            VALUES (:course,:title,:instructor,:category,:tags_json,:cover_kind,:updated_at)
            ON CONFLICT(course) DO UPDATE SET title=excluded.title,
            instructor=excluded.instructor,category=excluded.category,
            tags_json=excluded.tags_json, updated_at=excluded.updated_at''',
            {**new, 'course': course, 'updated_at': utcnow()})
    return get_course(course, path)


def _cover_path(course: str, data_dir: Path | None = None) -> Path:
    dest = (data_dir or settings.data_dir) / 'covers'
    return dest / (hashlib.sha256(course.encode('utf-8')).hexdigest() + '.jpg')


def _save_image(blob: bytes, course: str, data_dir: Path | None = None) -> Path:
    """Decode, downscale and re-encode. Never retain original bytes/EXIF."""
    if len(blob) > MAX_IMAGE_BYTES or not blob:
        raise ValueError('Cover image must be 1 byte to 4 MiB')
    try:
        with Image.open(io.BytesIO(blob)) as src:
            if src.format not in {'JPEG', 'PNG', 'WEBP'} or src.width * src.height > MAX_IMAGE_PIXELS:
                raise ValueError('Unsupported image or dimensions')
            if min(src.size) < 80:
                raise ValueError('Cover must be at least 80 pixels on each side')
            image = ImageOps.exif_transpose(src).convert('RGB')
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise ValueError('Invalid cover image') from exc
    image = ImageOps.fit(image, (960, 540), method=Image.Resampling.LANCZOS)
    destination = _cover_path(course, data_dir)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temp = destination.with_name(destination.stem + '-' + uuid.uuid4().hex + '.tmp')
    try:
        image.save(temp, format='JPEG', quality=84, optimize=True)
        temp.replace(destination)
    finally:
        temp.unlink(missing_ok=True)
    return destination


def set_cover(course: str, blob: bytes, content_type: str, path: Path | None = None,
              data_dir: Path | None = None) -> Path:
    _catalog_row(course, path)
    if content_type not in ALLOWED_MIME:
        raise ValueError('Use a JPEG, PNG or WebP image')
    dest = _save_image(blob, course, data_dir)
    with connect(path) as conn:
        conn.execute('''INSERT INTO course_metadata(course,cover_kind,updated_at)
                        VALUES (?, 'custom', ?)
                        ON CONFLICT(course) DO UPDATE SET cover_kind='custom',updated_at=excluded.updated_at''',
                     (course, utcnow()))
    return dest


def reset_cover(course: str, path: Path | None = None, data_dir: Path | None = None) -> None:
    _catalog_row(course, path)
    with connect(path) as conn:
        conn.execute("UPDATE course_metadata SET cover_kind=NULL,updated_at=? WHERE course=?",
                     (utcnow(), course))
    _cover_path(course, data_dir).unlink(missing_ok=True)


def get_or_generate_cover(course: str, path: Path | None = None,
                          data_dir: Path | None = None, courses_dir: Path | None = None) -> Path | None:
    entry = _catalog_row(course, path)
    dest = _cover_path(course, data_dir)
    if dest.is_file():
        return dest
    if entry['cover_kind'] == 'custom':
        return None  # Never silently replace a user-uploaded cover.
    with connect(path) as conn:
        videos = conn.execute('''SELECT id,path,duration FROM videos WHERE course=? ORDER BY title''', (course,)).fetchall()
        frames = conn.execute('''SELECT c.frame_path FROM chunks c JOIN videos v ON v.id=c.video_id
            WHERE v.course=? AND c.kind='screen' AND c.frame_path IS NOT NULL
            ORDER BY c.start LIMIT 8''', (course,)).fetchall()
    base = (data_dir or settings.data_dir).resolve()
    for frame in frames:
        image_path = (base / frame['frame_path']).resolve()
        if image_path.is_file() and image_path.is_relative_to(base):
            try:
                return _save_image(image_path.read_bytes(), course, base)
            except (OSError, ValueError):
                continue
    if not shutil.which('ffmpeg'):
        return None
    videos_root = (courses_dir or settings.courses_dir).resolve()
    for video in videos:
        source = Path(video['path']).resolve()
        if not source.is_file() or not source.is_relative_to(videos_root):
            continue
        duration = video['duration']
        if not duration and shutil.which('ffprobe'):
            try:
                result = subprocess.run(['ffprobe','-v','error','-show_entries','format=duration',
                                         '-of','default=noprint_wrappers=1:nokey=1',str(source)],
                                        capture_output=True,text=True,check=True,timeout=12)
                duration = float(result.stdout.strip())
            except (OSError,ValueError,subprocess.CalledProcessError,subprocess.TimeoutExpired):
                duration = None
        seek = min(30.0, max(0.0, (duration or 2.0) * 0.18))
        cmd = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', str(seek),
               '-i', str(source), '-frames:v', '1', '-vf', 'scale=960:-2', '-f', 'image2', '-vcodec', 'mjpeg', '-']
        try:
            out = subprocess.run(cmd, check=True, capture_output=True, timeout=35).stdout
            if out:
                return _save_image(out, course, base)
        except (OSError, ValueError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
            log.info('Could not generate thumbnail from %s', source.name)
    return None
