"""Streaming-shaped read APIs and user library (My List & Watch History).

Provides:
- GET /api/streaming/home-feed: hero + rows in a single fast call
- GET /api/streaming/courses/{course_slug_or_id}: course detail with seasons, episodes, related
- GET /api/streaming/continue-watching: user's in-progress lectures
- GET /api/streaming/my-list: user's saved list of courses/lectures
- POST /api/streaming/my-list: save item
- DELETE /api/streaming/my-list/{item_type}/{item_id}: remove saved item
- GET /api/streaming/history: chronological watch history
- DELETE /api/streaming/history: clear watch history
- GET /api/streaming/trending: top-10 trending lectures from real watch analytics
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field

from . import auth, course_metadata
from .artwork import resolve_course, slugify
from .db import connect, utcnow

log = logging.getLogger(__name__)

router = APIRouter(tags=['streaming'])


def ensure_schema(path: Path | None = None) -> None:
    course_metadata.ensure_schema(path)
    with connect(path) as conn:
        conn.execute('''CREATE TABLE IF NOT EXISTS my_list (
            user_id TEXT NOT NULL,
            item_type TEXT NOT NULL CHECK(item_type IN ('course', 'lecture')),
            item_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY(user_id, item_type, item_id)
        )''')
        conn.execute('''CREATE TABLE IF NOT EXISTS watch_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            video_id TEXT NOT NULL,
            course TEXT NOT NULL,
            position REAL NOT NULL DEFAULT 0,
            duration REAL NOT NULL DEFAULT 0,
            completed INTEGER NOT NULL DEFAULT 0,
            watched_at TEXT NOT NULL
        )''')
        conn.execute('CREATE INDEX IF NOT EXISTS watch_history_user_idx ON watch_history(user_id, watched_at DESC)')


class MyListItem(BaseModel):
    item_type: Literal['course', 'lecture']
    item_id: str = Field(min_length=1, max_length=250)


def _get_current_user_id(request: Request) -> str:
    user = getattr(request.state, 'user', None)
    if user and user.get('id'):
        return user['id']
    try:
        u = auth.require_user(request, verified=False)
        return u['id']
    except Exception:
        return 'anonymous'


def _record_history_touch(user_id: str, video_id: str, course: str, position: float, duration: float, completed: int):
    if user_id == 'anonymous':
        return
    try:
        with connect() as conn:
            # Keep newest record, deduplicate near entries
            conn.execute('''INSERT INTO watch_history(user_id, video_id, course, position, duration, completed, watched_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?)''',
                         (user_id, video_id, course, position, duration, completed, utcnow()))
    except Exception as e:
        log.warning('Could not record watch history touch: %s', e)


@router.get('/api/streaming/continue-watching')
def continue_watching(request: Request):
    user_id = _get_current_user_id(request)
    if user_id == 'anonymous':
        return {'items': []}

    with connect() as conn:
        # Fetch in-progress lectures (position > 15 and not completed, or completed = 0 with percent < 95)
        rows = conn.execute('''
            SELECT p.video_id, p.percent, p.position, p.updated_at,
                   v.title, v.course, v.duration
            FROM video_progress p
            JOIN videos v ON v.id = p.video_id
            WHERE p.user_id = ? AND p.completed = 0 AND p.position > 10 AND p.percent < 95
            ORDER BY p.updated_at DESC LIMIT 15
        ''', (user_id,)).fetchall()

    items = []
    for r in rows:
        r_dict = dict(r)
        items.append({
            'video_id': r_dict['video_id'],
            'title': r_dict['title'],
            'course': r_dict['course'],
            'course_slug': slugify(r_dict['course']),
            'position': r_dict['position'],
            'duration': r_dict['duration'] or 0,
            'percent': r_dict['percent'],
            'thumbnail_url': f"/api/artwork/lectures/{r_dict['video_id']}/thumbnail?size=md",
            'deep_link': f"#/lecture/{r_dict['video_id']}?t={int(r_dict['position'])}",
            'updated_at': r_dict['updated_at'],
        })
    return {'items': items}


@router.get('/api/streaming/trending')
def trending_lectures():
    """Computes top-10 trending lectures from real watch analytics (playback sessions, visits, progress)."""
    with connect() as conn:
        # 1. Rank by playback sessions and visits
        top_rows = conn.execute('''
            SELECT v.id AS video_id, v.title, v.course, v.duration,
                   COUNT(ps.id) AS session_count
            FROM videos v
            LEFT JOIN playback_sessions ps ON ps.video_id = v.id
            GROUP BY v.id
            ORDER BY session_count DESC, v.id ASC
            LIMIT 10
        ''').fetchall()

    items = []
    for rank, r in enumerate(top_rows, 1):
        r_dict = dict(r)
        items.append({
            'rank': rank,
            'video_id': r_dict['video_id'],
            'title': r_dict['title'],
            'course': r_dict['course'],
            'course_slug': slugify(r_dict['course']),
            'duration': r_dict['duration'] or 0,
            'thumbnail_url': f"/api/artwork/lectures/{r_dict['video_id']}/thumbnail?size=md",
            'deep_link': f"#/lecture/{r_dict['video_id']}",
            'session_count': r_dict['session_count'],
        })
    return {'items': items}


@router.get('/api/streaming/my-list')
def get_my_list(request: Request):
    user_id = _get_current_user_id(request)
    if user_id == 'anonymous':
        return {'items': []}

    with connect() as conn:
        rows = conn.execute('SELECT * FROM my_list WHERE user_id=? ORDER BY created_at DESC', (user_id,)).fetchall()

    items = []
    for r in rows:
        item_type = r['item_type']
        item_id = r['item_id']
        if item_type == 'course':
            res = resolve_course(item_id)
            if res:
                course_name, meta = res
                items.append({
                    'item_type': 'course',
                    'item_id': slugify(course_name),
                    'course': course_name,
                    'title': meta.get('title') or course_name,
                    'slug': slugify(course_name),
                    'poster_url': f"/api/artwork/courses/{slugify(course_name)}/poster",
                    'backdrop_url': f"/api/artwork/courses/{slugify(course_name)}/backdrop",
                    'deep_link': f"#/course/{slugify(course_name)}",
                    'created_at': r['created_at'],
                })
        else:
            with connect() as conn:
                v_row = conn.execute('SELECT id, title, course, duration FROM videos WHERE id=?', (item_id,)).fetchone()
            if v_row:
                v_dict = dict(v_row)
                items.append({
                    'item_type': 'lecture',
                    'item_id': v_dict['id'],
                    'title': v_dict['title'],
                    'course': v_dict['course'],
                    'course_slug': slugify(v_dict['course']),
                    'thumbnail_url': f"/api/artwork/lectures/{v_dict['id']}/thumbnail?size=md",
                    'deep_link': f"#/lecture/{v_dict['id']}",
                    'duration': v_dict['duration'],
                    'created_at': r['created_at'],
                })
    return {'items': items}


@router.post('/api/streaming/my-list', status_code=201)
def add_to_my_list(body: MyListItem, request: Request):
    user_id = _get_current_user_id(request)
    if user_id == 'anonymous':
        raise HTTPException(401, 'Sign in to save items to My List')

    target_id = body.item_id
    if body.item_type == 'course':
        res = resolve_course(body.item_id)
        if res:
            target_id = res[0]

    with connect() as conn:
        conn.execute('''INSERT OR IGNORE INTO my_list(user_id, item_type, item_id, created_at)
                        VALUES (?, ?, ?, ?)''', (user_id, body.item_type, target_id, utcnow()))
    return {'ok': True, 'saved': True}


@router.delete('/api/streaming/my-list/{item_type}/{item_id}')
def remove_from_my_list(item_type: Literal['course', 'lecture'], item_id: str, request: Request):
    user_id = _get_current_user_id(request)
    if user_id == 'anonymous':
        raise HTTPException(401, 'Sign in to manage My List')

    candidates = [item_id]
    if item_type == 'course':
        res = resolve_course(item_id)
        if res:
            candidates.extend([res[0], slugify(res[0])])

    with connect() as conn:
        conn.execute(f"DELETE FROM my_list WHERE user_id=? AND item_type=? AND item_id IN ({','.join('?' for _ in candidates)})",
                     [user_id, item_type, *candidates])
    return {'ok': True, 'removed': True}


@router.get('/api/streaming/history')
def get_watch_history(request: Request, limit: int = 50):
    user_id = _get_current_user_id(request)
    if user_id == 'anonymous':
        return {'history': []}

    with connect() as conn:
        # Fallback to lesson_visits / video_progress if watch_history is just being populated
        rows = conn.execute('''
            SELECT wh.video_id, wh.course, wh.position, wh.duration, wh.completed, wh.watched_at,
                   v.title
            FROM watch_history wh
            JOIN videos v ON v.id = wh.video_id
            WHERE wh.user_id = ?
            ORDER BY wh.watched_at DESC
            LIMIT ?
        ''', (user_id, limit)).fetchall()
        
        if not rows:
            rows = conn.execute('''
                SELECT p.video_id, v.course, p.position, v.duration, p.completed, p.updated_at AS watched_at,
                       v.title
                FROM video_progress p
                JOIN videos v ON v.id = p.video_id
                WHERE p.user_id = ?
                ORDER BY p.updated_at DESC
                LIMIT ?
            ''', (user_id, limit)).fetchall()

    history = []
    for r in rows:
        r_dict = dict(r)
        history.append({
            'video_id': r_dict['video_id'],
            'title': r_dict['title'],
            'course': r_dict['course'],
            'course_slug': slugify(r_dict['course']),
            'position': r_dict['position'],
            'duration': r_dict['duration'] or 0,
            'completed': bool(r_dict['completed']),
            'thumbnail_url': f"/api/artwork/lectures/{r_dict['video_id']}/thumbnail?size=md",
            'deep_link': f"#/lecture/{r_dict['video_id']}?t={int(r_dict['position'])}",
            'watched_at': r_dict['watched_at'],
        })
    return {'history': history}


@router.delete('/api/streaming/history')
def clear_watch_history(request: Request):
    user_id = _get_current_user_id(request)
    if user_id == 'anonymous':
        raise HTTPException(401, 'Sign in to clear history')

    with connect() as conn:
        conn.execute('DELETE FROM watch_history WHERE user_id=?', (user_id,))
    return {'ok': True, 'cleared': True}


@router.get('/api/streaming/home-feed')
def get_home_feed(request: Request):
    """Returns hero items + carousels in ONE single round trip for instant streaming experience."""
    user_id = _get_current_user_id(request)
    ensure_schema()

    with connect() as conn:
        # 1. Fetch published courses and metadata
        all_courses = conn.execute('''
            SELECT cm.course, cm.title, cm.instructor, cm.category,
                   COUNT(v.id) AS lecture_count,
                   COALESCE(SUM(v.duration), 0) AS total_duration
            FROM course_metadata cm
            JOIN videos v ON v.course = cm.course
            GROUP BY cm.course
            ORDER BY cm.title COLLATE NOCASE
        ''').fetchall()

        if not all_courses:
            # Fallback to distinct courses in videos
            all_courses = conn.execute('''
                SELECT v.course, v.course AS title, NULL AS instructor, NULL AS category,
                       COUNT(v.id) AS lecture_count,
                       COALESCE(SUM(v.duration), 0) AS total_duration
                FROM videos v
                GROUP BY v.course
                ORDER BY v.course COLLATE NOCASE
            ''').fetchall()

        # 2. Check user's saved my_list items
        my_list_ids = set()
        if user_id != 'anonymous':
            ml_rows = conn.execute('SELECT item_id FROM my_list WHERE user_id=?', (user_id,)).fetchall()
            my_list_ids = {r[0] for r in ml_rows}

    courses_list = [dict(c) for c in all_courses]

    # Select Hero item: Continue Watching course if available, or top course
    cw_data = continue_watching(request)['items']
    trending_data = trending_lectures()['items']

    hero_items = []
    # If student was watching a lecture, lead with that course in Hero
    active_course_name = cw_data[0]['course'] if cw_data else None

    # Pick 3 featured hero items
    featured_candidates = []
    if active_course_name:
        match = next((c for c in courses_list if c['course'] == active_course_name), None)
        if match:
            featured_candidates.append((match, cw_data[0]))

    for c in courses_list:
        if not any(f[0]['course'] == c['course'] for f in featured_candidates):
            featured_candidates.append((c, None))
        if len(featured_candidates) >= 5:
            break

    for c, next_lec in featured_candidates:
        c_name = c['course']
        c_title = c.get('title') or c_name
        c_slug = slugify(c_name)
        
        # If no resume lecture, get first lecture
        if not next_lec:
            with connect() as conn:
                first_v = conn.execute('SELECT id, title, duration FROM videos WHERE course=? ORDER BY title LIMIT 1', (c_name,)).fetchone()
            if first_v:
                next_lec = {
                    'video_id': first_v['id'],
                    'title': first_v['title'],
                    'position': 0,
                    'duration': first_v['duration'] or 0,
                    'deep_link': f"#/lecture/{first_v['id']}",
                }

        hero_items.append({
            'id': c_name,
            'slug': c_slug,
            'title': c_title,
            'synopsis': f"Comprehensive masterclass featuring {c['lecture_count']} lessons and {int(c['total_duration'] // 3600)}h {int((c['total_duration'] % 3600) // 60)}m of in-depth applied learning.",
            'instructor': c.get('instructor') or 'Industry Veteran',
            'category': c.get('category') or 'Computer Science & Engineering',
            'backdrop_url': f"/api/artwork/courses/{c_slug}/backdrop",
            'poster_url': f"/api/artwork/courses/{c_slug}/poster",
            'total_lectures': c['lecture_count'],
            'total_duration': c['total_duration'],
            'in_my_list': c_name in my_list_ids,
            'next_lecture': next_lec,
            'badge': 'Featured' if not active_course_name or active_course_name != c_name else 'Jump Back In',
        })

    # Prepare streaming rows
    rows = []

    # Row 1: Continue Watching (per-lecture progress bars)
    if cw_data:
        rows.append({
            'id': 'continue-watching',
            'title': 'Continue Watching',
            'kind': 'lecture_card',
            'see_all_url': '#/browse',
            'items': cw_data,
        })

    # Row 2: Top 10 Trending This Week
    if trending_data:
        rows.append({
            'id': 'trending-top-10',
            'title': 'Top 10 This Week',
            'kind': 'rank_card',
            'see_all_url': '#/browse?sort=popular',
            'items': trending_data,
        })

    # Row 3: All Featured Titles (Course Posters 2:3)
    course_cards = []
    for c in courses_list:
        c_name = c['course']
        c_slug = slugify(c_name)
        course_cards.append({
            'id': c_name,
            'slug': c_slug,
            'title': c.get('title') or c_name,
            'instructor': c.get('instructor') or 'Lead Architect',
            'category': c.get('category') or 'Technology',
            'lecture_count': c['lecture_count'],
            'duration': c['total_duration'],
            'poster_url': f"/api/artwork/courses/{c_slug}/poster",
            'backdrop_url': f"/api/artwork/courses/{c_slug}/backdrop",
            'deep_link': f"#/course/{c_slug}",
            'in_my_list': c_name in my_list_ids,
        })

    rows.append({
        'id': 'featured-titles',
        'title': 'Featured Masterclasses',
        'kind': 'poster_card',
        'see_all_url': '#/browse',
        'items': course_cards,
    })

    # Row 4: New Lectures Across Titles
    with connect() as conn:
        newest_v = conn.execute('''
            SELECT id, title, course, duration, created_at
            FROM videos ORDER BY created_at DESC LIMIT 12
        ''').fetchall()
    
    new_items = []
    for nv in newest_v:
        nv_dict = dict(nv)
        new_items.append({
            'video_id': nv_dict['id'],
            'title': nv_dict['title'],
            'course': nv_dict['course'],
            'course_slug': slugify(nv_dict['course']),
            'duration': nv_dict['duration'] or 0,
            'thumbnail_url': f"/api/artwork/lectures/{nv_dict['id']}/thumbnail?size=md",
            'deep_link': f"#/lecture/{nv_dict['id']}",
        })
    if new_items:
        rows.append({
            'id': 'new-episodes',
            'title': 'New Episodes',
            'kind': 'episode_card',
            'see_all_url': '#/browse?sort=recent',
            'items': new_items,
        })

    # Rows 5+: Category Rows
    categories = sorted({c.get('category') or 'Core Engineering' for c in courses_list})
    for cat in categories[:4]:
        cat_items = [cc for cc in course_cards if cc.get('category') == cat or (not cc.get('category') and cat == 'Core Engineering')]
        if cat_items:
            rows.append({
                'id': f"cat-{slugify(cat)}",
                'title': cat,
                'kind': 'poster_card',
                'see_all_url': f"#/browse/{slugify(cat)}",
                'items': cat_items,
            })

    return {
        'hero': hero_items,
        'rows': rows,
    }


@router.get('/api/streaming/courses/{course_slug_or_id}')
def get_course_detail(course_slug_or_id: str, request: Request):
    """Full streaming course detail page/modal with seasons (modules), episodes (lectures), and related titles."""
    user_id = _get_current_user_id(request)
    ensure_schema()

    res = resolve_course(course_slug_or_id)
    if not res:
        raise HTTPException(404, f"Course '{course_slug_or_id}' not found")
    course_name, meta = res
    course_title = meta.get('title') or course_name
    c_slug = slugify(course_name)

    with connect() as conn:
        # Fetch lectures and flow order
        videos = conn.execute('''
            SELECT v.id, v.title, v.duration, v.path,
                   co.section_title, co.position AS custom_pos,
                   p.percent, p.position AS resume_pos, p.completed
            FROM videos v
            LEFT JOIN course_lesson_organization co ON co.course = v.course AND co.video_id = v.id
            LEFT JOIN video_progress p ON p.video_id = v.id AND p.user_id = ?
            WHERE v.course = ?
            ORDER BY v.title COLLATE NOCASE
        ''', (user_id, course_name)).fetchall()

        # Check enrollment
        enrolled = bool(conn.execute('SELECT 1 FROM enrollments WHERE user_id=? AND course=?', (user_id, course_name)).fetchone())
        # Check My List
        in_my_list = bool(conn.execute('SELECT 1 FROM my_list WHERE user_id=? AND item_type="course" AND item_id=?', (user_id, course_name)).fetchone())
        # Fetch materials
        materials_rows = conn.execute('SELECT * FROM course_materials_meta WHERE course=? AND removed=0', (course_name,)).fetchall()

    if not videos:
        raise HTTPException(404, f"No lessons found for course '{course_title}'")

    # Group into Seasons (Modules)
    seasons_map = {}
    total_duration = 0
    completed_count = 0
    next_up_lecture = None

    for idx, v in enumerate(videos, 1):
        v_dict = dict(v)
        dur = float(v_dict['duration'] or 0)
        total_duration += dur
        is_comp = bool(v_dict['completed'])
        if is_comp:
            completed_count += 1
        elif not next_up_lecture:
            next_up_lecture = v_dict

        section = v_dict.get('section_title') or course_metadata.infer_section_title(course_name, v_dict['title'], idx)
        if section not in seasons_map:
            seasons_map[section] = []

        seasons_map[section].append({
            'id': v_dict['id'],
            'title': v_dict['title'],
            'episode_number': idx,
            'duration': dur,
            'thumbnail_url': f"/api/artwork/lectures/{v_dict['id']}/thumbnail?size=md",
            'deep_link': f"#/lecture/{v_dict['id']}",
            'synopsis': f"Detailed technical session covering {v_dict['title']}, core principles, production architectures, and hands-on implementation.",
            'completed': is_comp,
            'progress_percent': v_dict['percent'] or 0,
            'resume_position': v_dict['resume_pos'] or 0,
            'is_next': False,
        })

    # Mark the next up lecture
    if not next_up_lecture and videos:
        next_up_lecture = dict(videos[0])

    if next_up_lecture:
        for s_episodes in seasons_map.values():
            for ep in s_episodes:
                if ep['id'] == next_up_lecture['id']:
                    ep['is_next'] = True
                    break

    seasons = []
    for s_idx, (s_title, s_eps) in enumerate(seasons_map.items(), 1):
        # Section materials
        s_materials = [
            {
                'id': m['id'],
                'friendly_name': m['friendly_name'] or m['filename'],
                'material_type': m['material_type'],
                'download_url': f"/api/materials/{m['id']}/download",
            }
            for m in materials_rows if (m['section_title'] == s_title or m['scope'] == 'course')
        ]
        seasons.append({
            'season_number': s_idx,
            'title': s_title,
            'episodes_count': len(s_eps),
            'episodes': s_eps,
            'materials': s_materials,
        })

    # Calculate Related Courses ("Students also watch")
    with connect() as conn:
        # Co-enrolled courses
        co_rows = conn.execute('''
            SELECT e2.course, COUNT(DISTINCT e2.user_id) AS co_count
            FROM enrollments e1
            JOIN enrollments e2 ON e1.user_id = e2.user_id AND e2.course != e1.course
            WHERE e1.course = ?
            GROUP BY e2.course
            ORDER BY co_count DESC LIMIT 6
        ''', (course_name,)).fetchall()
        
        related_names = [r[0] for r in co_rows]
        if len(related_names) < 6:
            # Fallback to same category
            cat_rows = conn.execute('''
                SELECT course FROM course_metadata
                WHERE category = ? AND course != ? LIMIT 6
            ''', (meta.get('category', ''), course_name)).fetchall()
            for cr in cat_rows:
                if cr[0] not in related_names:
                    related_names.append(cr[0])

        if len(related_names) < 6:
            # Fallback to other courses
            all_rows = conn.execute('SELECT DISTINCT course FROM videos WHERE course != ? LIMIT 6', (course_name,)).fetchall()
            for ar in all_rows:
                if ar[0] not in related_names:
                    related_names.append(ar[0])

    related = []
    for rc in related_names[:6]:
        r_res = resolve_course(rc)
        if r_res:
            rc_name, rc_meta = r_res
            related.append({
                'id': rc_name,
                'slug': slugify(rc_name),
                'title': rc_meta.get('title') or rc_name,
                'poster_url': f"/api/artwork/courses/{slugify(rc_name)}/poster",
                'backdrop_url': f"/api/artwork/courses/{slugify(rc_name)}/backdrop",
                'deep_link': f"#/course/{slugify(rc_name)}",
            })

    return {
        'course': {
            'id': course_name,
            'slug': c_slug,
            'title': course_title,
            'instructor': meta.get('instructor') or 'Industry Veteran',
            'category': meta.get('category') or 'Computer Science',
            'synopsis': f"A comprehensive {len(videos)}-part masterclass taking you from foundations to elite production mastery.",
            'poster_url': f"/api/artwork/courses/{c_slug}/poster",
            'backdrop_url': f"/api/artwork/courses/{c_slug}/backdrop",
            'total_episodes': len(videos),
            'completed_episodes': completed_count,
            'progress_percent': int((completed_count / len(videos)) * 100) if videos else 0,
            'total_duration': total_duration,
            'enrolled': enrolled,
            'in_my_list': in_my_list,
            'next_lecture': {
                'id': next_up_lecture['id'],
                'title': next_up_lecture['title'],
                'resume_position': next_up_lecture.get('resume_pos') or 0,
                'deep_link': f"#/lecture/{next_up_lecture['id']}?t={int(next_up_lecture.get('resume_pos') or 0)}",
            } if next_up_lecture else None,
        },
        'seasons': seasons,
        'related': related,
    }
