"""Streaming artwork pipeline: posters (2:3), backdrops (16:9), and lecture thumbnails.

Generates high-performance multi-size artwork with server-side caching and
strict proxying (Odysee / external CDN domains are never exposed in the client).
"""
from __future__ import annotations

import hashlib
import io
import json
import logging
import os
import re
import shutil
import ssl
import subprocess
import unicodedata
import urllib.request
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Response
from fastapi.responses import FileResponse
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps

from .config import settings
from .db import connect

log = logging.getLogger(__name__)

router = APIRouter(tags=['artwork'])

ARTWORK_DIR = Path('data/artwork')
POSTERS_DIR = ARTWORK_DIR / 'posters'
BACKDROPS_DIR = ARTWORK_DIR / 'backdrops'
THUMBNAILS_DIR = ARTWORK_DIR / 'thumbnails'
CLAIM_THUMBNAILS_PATH = ARTWORK_DIR / 'claim_thumbnails.json'

_claim_thumbnails_cache: dict[str, str] | None = None


def _get_claim_thumbnail_url(claim_id: str) -> str | None:
    global _claim_thumbnails_cache
    if _claim_thumbnails_cache is None:
        if CLAIM_THUMBNAILS_PATH.is_file():
            try:
                _claim_thumbnails_cache = json.loads(CLAIM_THUMBNAILS_PATH.read_text('utf-8'))
            except Exception:
                _claim_thumbnails_cache = {}
        else:
            _claim_thumbnails_cache = {}

    url = _claim_thumbnails_cache.get(claim_id)
    if url:
        return url

    try:
        ctx = ssl._create_unverified_context()
        payload = {
            'jsonrpc': '2.0',
            'method': 'claim_search',
            'params': {'claim_ids': [claim_id], 'page_size': 1},
            'id': 1,
        }
        req = urllib.request.Request(
            'https://api.na-backend.odysee.com/api/v1/proxy',
            data=json.dumps(payload).encode(),
            headers={'Content-Type': 'application/json', 'User-Agent': 'CourseForge/1.0'},
        )
        with urllib.request.urlopen(req, context=ctx, timeout=4) as resp:
            data = json.loads(resp.read().decode())
            items = data.get('result', {}).get('items', [])
            if items:
                resolved_url = items[0].get('value', {}).get('thumbnail', {}).get('url')
                if resolved_url:
                    _claim_thumbnails_cache[claim_id] = resolved_url
                    try:
                        CLAIM_THUMBNAILS_PATH.write_text(json.dumps(_claim_thumbnails_cache, indent=2))
                    except Exception:
                        pass
                    return resolved_url
    except Exception as e:
        log.debug('Failed to resolve claim thumbnail for %s: %s', claim_id, e)
    return None


def _fetch_and_cache_remote_frame(turl: str, dest: Path, w: int, h: int) -> bool:
    try:
        ctx = ssl._create_unverified_context()
        req = urllib.request.Request(turl, headers={'User-Agent': 'Mozilla/5.0 CourseForge/1.0'})
        with urllib.request.urlopen(req, context=ctx, timeout=6) as resp:
            raw = resp.read()
            if len(raw) < 200:
                return False
            with Image.open(io.BytesIO(raw)) as im:
                thumb = ImageOps.fit(im.convert('RGB'), (w, h), method=Image.Resampling.LANCZOS)
                thumb.save(dest, format='JPEG', quality=85, optimize=True)
                return True
    except Exception as e:
        log.debug('Failed to download frame from %s: %s', turl, e)
        return False


THUMB_SIZES = {
    'sm': (320, 180),
    'md': (640, 360),
    'lg': (1280, 720),
}

CACHE_HEADERS = {
    'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800',
    'X-Content-Type-Options': 'nosniff',
}

CATEGORY_THEMES = {
    'cloud': {
        'bg_start': (15, 23, 42),      # Slate 900
        'bg_end': (14, 116, 144),      # Cyan 700
        'accent': (56, 189, 248),      # Sky 400
        'label': 'Cloud & Architecture',
    },
    'ai': {
        'bg_start': (15, 23, 42),
        'bg_end': (79, 70, 229),       # Indigo 600
        'accent': (165, 180, 252),     # Indigo 300
        'label': 'AI & Machine Learning',
    },
    'data': {
        'bg_start': (15, 23, 42),
        'bg_end': (5, 150, 105),       # Emerald 600
        'accent': (110, 231, 183),     # Emerald 300
        'label': 'Big Data & Pipelines',
    },
    'system': {
        'bg_start': (15, 23, 42),
        'bg_end': (180, 83, 9),        # Amber 700
        'accent': (252, 211, 77),      # Amber 300
        'label': 'System Design & DSA',
    },
}


def ensure_directories():
    for d in (POSTERS_DIR, BACKDROPS_DIR, THUMBNAILS_DIR):
        d.mkdir(parents=True, exist_ok=True)


def slugify(text: str) -> str:
    text = unicodedata.normalize('NFKD', text or '').encode('ascii', 'ignore').decode('ascii')
    text = re.sub(r'[^\w\s-]', '', text.lower())
    return re.sub(r'[-\s]+', '-', text).strip('-_')


def resolve_course(course_query: str, path: Path | None = None) -> tuple[str, dict] | None:
    """Resolve a course by ID, display title, or slug."""
    clean = (course_query or '').strip()
    with connect(path) as conn:
        # 1. Exact match on course ID
        row = conn.execute('SELECT * FROM course_metadata WHERE course=?', (clean,)).fetchone()
        if row:
            return row['course'], dict(row)
        
        # 2. Match from videos table if not in metadata
        v_row = conn.execute('SELECT DISTINCT course FROM videos WHERE course=?', (clean,)).fetchone()
        if v_row:
            return v_row['course'], {'course': v_row['course'], 'title': v_row['course']}
        
        # 3. Match by title or slug
        all_meta = conn.execute('SELECT * FROM course_metadata').fetchall()
        for m in all_meta:
            m_dict = dict(m)
            c_name = m_dict['course']
            c_title = m_dict.get('title') or c_name
            if slugify(c_name) == clean or slugify(c_title) == clean or c_title.lower() == clean.lower():
                return c_name, m_dict
        
        # 4. Check video courses slugs
        video_courses = [r[0] for r in conn.execute('SELECT DISTINCT course FROM videos').fetchall()]
        for vc in video_courses:
            if slugify(vc) == clean or vc.lower() == clean.lower():
                return vc, {'course': vc, 'title': vc}
    return None


def get_course_theme(course: str) -> dict:
    c_low = course.lower()
    if any(k in c_low for k in ('cloud', 'azure', 'aws', 'gcp', 'devops')):
        return CATEGORY_THEMES['cloud']
    if any(k in c_low for k in ('ai', 'agentic', 'genai', 'namaste', 'gaurav sen ai', 'llm')):
        return CATEGORY_THEMES['ai']
    if any(k in c_low for k in ('data', 'spark', 'databricks', 'big data', 'sql', 'pipeline')):
        return CATEGORY_THEMES['data']
    return CATEGORY_THEMES['system']


def _find_source_cover(course: str) -> Path | None:
    """Find any pre-existing cover for this course."""
    h = hashlib.sha256(course.encode('utf-8')).hexdigest()
    primary = Path('data/covers') / f'{h}.jpg'
    if primary.is_file():
        return primary
    # Check fallback covers directory
    covers_dir = Path('data/covers')
    if covers_dir.is_dir():
        for f in covers_dir.glob('*.jpg'):
            if f.is_file():
                return f
    return None


def _create_gradient(width: int, height: int, start_rgb: tuple, end_rgb: tuple, angle: float = 45.0) -> Image.Image:
    """Generate a smooth gradient background."""
    img = Image.new('RGB', (width, height), start_rgb)
    draw = ImageDraw.Draw(img)
    for y in range(height):
        factor = y / max(1, height - 1)
        r = int(start_rgb[0] + (end_rgb[0] - start_rgb[0]) * factor)
        g = int(start_rgb[1] + (end_rgb[1] - start_rgb[1]) * factor)
        b = int(start_rgb[2] + (end_rgb[2] - start_rgb[2]) * factor)
        draw.line([(0, y), (width, y)], fill=(r, g, b))
    return img


def get_or_create_course_poster(course: str) -> Path:
    """Returns a 2:3 ratio poster JPEG (600x900)."""
    ensure_directories()
    safe_key = hashlib.sha256(course.encode('utf-8')).hexdigest()
    dest = POSTERS_DIR / f'{safe_key}.jpg'
    if dest.is_file() and dest.stat().st_size > 500:
        return dest

    src_cover = _find_source_cover(course)
    theme = get_course_theme(course)

    if src_cover and src_cover.is_file():
        try:
            with Image.open(src_cover) as im:
                im = ImageOps.exif_transpose(im).convert('RGB')
                # Fit into 600x900 (2:3)
                poster = ImageOps.fit(im, (600, 900), method=Image.Resampling.LANCZOS, centering=(0.5, 0.4))
                # Add cinematic bottom gradient vignette
                overlay = Image.new('RGBA', (600, 900), (0, 0, 0, 0))
                odraw = ImageDraw.Draw(overlay)
                for y in range(550, 900):
                    alpha = int(220 * ((y - 550) / 350.0) ** 1.5)
                    odraw.line([(0, y), (600, y)], fill=(8, 12, 22, alpha))
                # Top vignette
                for y in range(0, 180):
                    alpha = int(140 * ((180 - y) / 180.0) ** 1.5)
                    odraw.line([(0, y), (600, y)], fill=(8, 12, 22, alpha))
                poster = Image.alpha_composite(poster.convert('RGBA'), overlay).convert('RGB')
                poster.save(dest, format='JPEG', quality=88, optimize=True)
                return dest
        except Exception as e:
            log.warning('Could not process source cover for poster: %s', e)

    # Branded placeholder poster (600x900)
    base = _create_gradient(600, 900, theme['bg_start'], theme['bg_end'])
    draw = ImageDraw.Draw(base)

    # Draw border accent
    draw.rectangle([16, 16, 584, 884], outline=theme['accent'], width=2)
    draw.rectangle([24, 24, 576, 876], outline=(255, 255, 255, 30), width=1)

    # Header pill
    draw.rounded_rectangle([40, 48, 220, 84], radius=6, fill=(0, 0, 0, 120), outline=theme['accent'], width=1)
    draw.text((54, 58), 'COURSEFORGE', fill=(255, 255, 255))

    # Center title & category
    draw.text((40, 720), theme['label'].upper(), fill=theme['accent'])
    # Multi-line title
    title_words = course.split()
    lines = []
    curr = []
    for w in title_words:
        curr.append(w)
        if len(' '.join(curr)) > 22:
            lines.append(' '.join(curr))
            curr = []
    if curr:
        lines.append(' '.join(curr))
    
    y = 750
    for line in lines[:3]:
        draw.text((40, y), line, fill=(255, 255, 255))
        y += 28

    base.save(dest, format='JPEG', quality=88, optimize=True)
    return dest


def get_or_create_course_backdrop(course: str) -> Path:
    """Returns a 16:9 ratio backdrop JPEG (1280x720) with cinematic left fade."""
    ensure_directories()
    safe_key = hashlib.sha256(course.encode('utf-8')).hexdigest()
    dest = BACKDROPS_DIR / f'{safe_key}.jpg'
    if dest.is_file() and dest.stat().st_size > 500:
        return dest

    src_cover = _find_source_cover(course)
    theme = get_course_theme(course)

    if src_cover and src_cover.is_file():
        try:
            with Image.open(src_cover) as im:
                im = ImageOps.exif_transpose(im).convert('RGB')
                backdrop = ImageOps.fit(im, (1280, 720), method=Image.Resampling.LANCZOS, centering=(0.5, 0.5))
                # Add cinematic left fade and bottom vignette (Netflix style for text contrast)
                overlay = Image.new('RGBA', (1280, 720), (0, 0, 0, 0))
                odraw = ImageDraw.Draw(overlay)
                # Left fade (0 to 600px)
                for x in range(0, 650):
                    alpha = int(240 * (1.0 - (x / 650.0)) ** 1.4)
                    odraw.line([(x, 0), (x, 720)], fill=(8, 12, 22, alpha))
                # Bottom vignette (400 to 720px)
                for y in range(400, 720):
                    alpha = int(220 * ((y - 400) / 320.0) ** 1.3)
                    odraw.line([(0, y), (1280, y)], fill=(8, 12, 22, alpha))
                # Top vignette
                for y in range(0, 160):
                    alpha = int(120 * ((160 - y) / 160.0))
                    odraw.line([(0, y), (1280, y)], fill=(8, 12, 22, alpha))
                
                backdrop = Image.alpha_composite(backdrop.convert('RGBA'), overlay).convert('RGB')
                backdrop.save(dest, format='JPEG', quality=86, optimize=True)
                return dest
        except Exception as e:
            log.warning('Could not process source cover for backdrop: %s', e)

    # Branded placeholder backdrop (1280x720)
    base = _create_gradient(1280, 720, theme['bg_start'], theme['bg_end'])
    draw = ImageDraw.Draw(base)

    # Left vignette
    for x in range(0, 700):
        alpha = int(220 * (1.0 - (x / 700.0)))
        draw.line([(x, 0), (x, 720)], fill=(8, 12, 22))

    draw.text((64, 280), theme['label'].upper(), fill=theme['accent'])
    draw.text((64, 320), course, fill=(255, 255, 255))
    base.save(dest, format='JPEG', quality=86, optimize=True)
    return dest


def get_or_create_lecture_thumbnail(video_id: str, size: Literal['sm', 'md', 'lg'] = 'md') -> Path:
    """Returns a 16:9 ratio thumbnail JPEG for a lecture."""
    ensure_directories()
    w, h = THUMB_SIZES.get(size, THUMB_SIZES['md'])
    dest = THUMBNAILS_DIR / f'{video_id}_{size}.jpg'
    if dest.is_file() and dest.stat().st_size > 300:
        return dest

    with connect() as conn:
        row = conn.execute('SELECT * FROM videos WHERE id=?', (video_id,)).fetchone()
        chunk_frame = conn.execute('SELECT frame_path FROM chunks WHERE video_id=? AND frame_path IS NOT NULL LIMIT 1', (video_id,)).fetchone()

    video = dict(row) if row else {'id': video_id, 'title': f'Lecture {video_id[:8]}', 'course': 'CourseForge'}
    course_name = video.get('course', 'CourseForge')
    theme = get_course_theme(course_name)

    # 1. Try saved chunk frame if present
    if chunk_frame and chunk_frame['frame_path']:
        fp = Path(settings.data_dir) / chunk_frame['frame_path']
        if fp.is_file():
            try:
                with Image.open(fp) as im:
                    thumb = ImageOps.fit(im.convert('RGB'), (w, h), method=Image.Resampling.LANCZOS)
                    thumb.save(dest, format='JPEG', quality=85)
                    return dest
            except Exception:
                pass

    # 2. Try Odysee video frame proxying
    with connect() as conn:
        lp_row = conn.execute('SELECT claim_id FROM lecture_providers WHERE video_id=?', (video_id,)).fetchone()
    if lp_row and lp_row['claim_id']:
        turl = _get_claim_thumbnail_url(lp_row['claim_id'])
        if turl and _fetch_and_cache_remote_frame(turl, dest, w, h):
            return dest

    # 3. Try ffmpeg extract from local file if available
    local_source = Path(video.get('path', ''))
    if local_source.is_file() and shutil.which('ffmpeg'):
        dur = float(video.get('duration') or 60.0)
        seek = min(30.0, max(2.0, dur * 0.15))
        cmd = [
            'ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin',
            '-ss', str(seek), '-i', str(local_source),
            '-frames:v', '1',
            '-vf', f'scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h}',
            '-f', 'image2', '-vcodec', 'mjpeg', '-'
        ]
        try:
            res = subprocess.run(cmd, check=True, capture_output=True, timeout=25)
            if res.stdout and len(res.stdout) > 500:
                dest.write_bytes(res.stdout)
                return dest
        except Exception:
            pass

    # 3. Create high-grade branded thumbnail from course backdrop/theme
    src_backdrop = get_or_create_course_backdrop(course_name)
    if src_backdrop.is_file():
        try:
            with Image.open(src_backdrop) as im:
                thumb = ImageOps.fit(im.convert('RGB'), (w, h), method=Image.Resampling.LANCZOS, centering=(0.6, 0.5))
                # Add bottom bar with lecture title
                overlay = Image.new('RGBA', (w, h), (0, 0, 0, 0))
                odraw = ImageDraw.Draw(overlay)
                bar_h = int(h * 0.35)
                for y in range(h - bar_h, h):
                    alpha = int(220 * ((y - (h - bar_h)) / float(bar_h)))
                    odraw.line([(0, y), (w, y)], fill=(8, 12, 22, alpha))
                
                # Title & episode tag
                thumb = Image.alpha_composite(thumb.convert('RGBA'), overlay).convert('RGB')
                tdraw = ImageDraw.Draw(thumb)
                title = video.get('title', '')
                clean_title = re.sub(r'^\[\d+\]\s*', '', title)[:36]
                tdraw.text((12, h - 26), clean_title, fill=(255, 255, 255))
                thumb.save(dest, format='JPEG', quality=84)
                return dest
        except Exception:
            pass

    # 4. Pure fallback branded graphic
    base = _create_gradient(w, h, theme['bg_start'], theme['bg_end'])
    bdraw = ImageDraw.Draw(base)
    bdraw.rectangle([4, 4, w - 4, h - 4], outline=theme['accent'], width=1)
    bdraw.text((12, 12), 'COURSEFORGE', fill=theme['accent'])
    bdraw.text((12, h - 36), video.get('title', '')[:32], fill=(255, 255, 255))
    base.save(dest, format='JPEG', quality=84)
    return dest


@router.get('/api/artwork/courses/{course_id_or_slug}/poster')
def course_poster(course_id_or_slug: str):
    res = resolve_course(course_id_or_slug)
    course_name = res[0] if res else course_id_or_slug
    poster = get_or_create_course_poster(course_name)
    return FileResponse(poster, media_type='image/jpeg', headers=CACHE_HEADERS)


@router.get('/api/artwork/courses/{course_id_or_slug}/backdrop')
def course_backdrop(course_id_or_slug: str):
    res = resolve_course(course_id_or_slug)
    course_name = res[0] if res else course_id_or_slug
    backdrop = get_or_create_course_backdrop(course_name)
    return FileResponse(backdrop, media_type='image/jpeg', headers=CACHE_HEADERS)


@router.get('/api/artwork/lectures/{video_id}/thumbnail')
def lecture_thumbnail(video_id: str, size: Literal['sm', 'md', 'lg'] = Query('md')):
    thumb = get_or_create_lecture_thumbnail(video_id, size)
    return FileResponse(thumb, media_type='image/jpeg', headers=CACHE_HEADERS)
