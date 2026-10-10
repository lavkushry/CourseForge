"""Local-first, deterministic daily study planner.

Recommendations are estimates, not evidence of actual learning time or competence.
Only assessed topics, curated labs and source-backed videos can be scheduled.
Checklist state is self-reported and never alters mastery or lab results.
"""
from __future__ import annotations

import json
import math
import re
import uuid
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path

from .db import connect, utcnow


class PlannerInputError(ValueError):
    pass


class PlannerNotFound(KeyError):
    pass


def ensure_schema(db_path: Path | None = None):
    with connect(db_path) as db:
        db.executescript('''
        CREATE TABLE IF NOT EXISTS planner_preferences (
            singleton INTEGER PRIMARY KEY CHECK(singleton=1),
            daily_minutes INTEGER NOT NULL DEFAULT 45,
            path_id TEXT REFERENCES learning_paths(id) ON DELETE SET NULL,
            updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS daily_plans (
            study_date TEXT PRIMARY KEY, path_id TEXT REFERENCES learning_paths(id) ON DELETE SET NULL,
            budget_minutes INTEGER NOT NULL, tz_offset_minutes INTEGER NOT NULL,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS daily_plan_items (
            id TEXT PRIMARY KEY, study_date TEXT NOT NULL REFERENCES daily_plans(study_date) ON DELETE CASCADE,
            item_key TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
            description TEXT NOT NULL, minutes INTEGER NOT NULL, action_json TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','done','skipped')),
            updated_at TEXT NOT NULL,
            UNIQUE(study_date,item_key));
        CREATE INDEX IF NOT EXISTS daily_plan_items_date ON daily_plan_items(study_date);
        ''')
        db.execute('INSERT OR IGNORE INTO planner_preferences(singleton,daily_minutes,updated_at) VALUES(1,45,?)', (utcnow(),))


def preferences(db_path: Path | None = None) -> dict:
    with connect(db_path) as db:
        row = db.execute('SELECT daily_minutes,path_id FROM planner_preferences WHERE singleton=1').fetchone()
    return dict(row) if row else {'daily_minutes': 45, 'path_id': None}


def save_preferences(daily_minutes: int, path_id: str | None, db_path: Path | None = None) -> dict:
    if isinstance(daily_minutes, bool) or not 15 <= daily_minutes <= 180:
        raise PlannerInputError('Daily budget must be between 15 and 180 minutes')
    from .learning_paths import get_path, PathNotFound
    if path_id:
        try:
            get_path(path_id, db_path)
        except PathNotFound as exc:
            raise PlannerNotFound('Selected learning path not found') from exc
    with connect(db_path) as db:
        db.execute('''UPDATE planner_preferences SET daily_minutes=?,path_id=?,updated_at=? WHERE singleton=1''',
                   (daily_minutes, path_id or None, utcnow()))
    return preferences(db_path)


def _study_date(value: str) -> date:
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
        raise PlannerInputError('Date must use YYYY-MM-DD')
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise PlannerInputError('Invalid calendar date') from exc


def _date_limit(local_date: date, tz_offset_minutes: int) -> str:
    """UTC end of the requested local day, using JavaScript getTimezoneOffset semantics."""
    # JS getTimezoneOffset is UTC minus local, so local midnight + offset = UTC.
    midnight_next = datetime.combine(local_date + timedelta(days=1), time.min, timezone.utc)
    return (midnight_next + timedelta(minutes=tz_offset_minutes)).isoformat(timespec='seconds')


def _item(key: str, kind: str, title: str, description: str, minutes: int, action: dict) -> dict:
    return {'item_key': key, 'kind': kind, 'title': title[:180],
            'description': description[:350], 'minutes': int(minutes), 'action': action}


def _candidates(local_date: date, tz_offset_minutes: int, path_id: str | None,
                db_path: Path | None) -> tuple[list[dict], list[str]]:
    warnings: list[str] = []
    candidates: list[dict] = []
    cutoff = _date_limit(local_date, tz_offset_minutes)
    with connect(db_path) as db:
        due = db.execute('SELECT id,course FROM review_cards WHERE due_at < ? ORDER BY due_at,id LIMIT 20',
                         (cutoff,)).fetchall()
    if due:
        count = len(due)
        candidates.append(_item('review:due', 'review', f'Review {count} due flashcard' + ('s' if count != 1 else ''),
                                'Spaced repetition · due by the end of this local day. Open Review to grade cards.',
                                min(16, max(5, math.ceil(count / 4) * 3)),
                                {'view': 'reviews', 'due_card_ids': [r['id'] for r in due]}))

    path = None
    if path_id:
        from .learning_paths import get_path, PathNotFound
        try:
            path = get_path(path_id, db_path)
        except PathNotFound as exc:
            raise PlannerNotFound('Selected learning path not found') from exc
        if path['outdated']:
            warnings.append('Learning path sources changed. Refresh the roadmap before using its practice recommendations.')
        completed = {s['id'] for s in path['steps'] if s['completed']}
        ready = [s for s in path['steps'] if not s['completed'] and all(p in completed for p in s['prerequisites'])]
        if not ready and any(not s['completed'] for s in path['steps']):
            warnings.append('All remaining topics are prerequisite-locked. Check your learning roadmap.')
        if not path['outdated']:
            # Prioritize goal focus, low scores and previously unassessed topics; never guess skill mastery.
            ready.sort(key=lambda s: (0 if s['mastery'] and s['mastery']['status'] == 'needs_practice' else 1,
                                     0 if s.get('goal_focus') else 1, s['order']))
            for s in ready[:3]:
                src = s['sources'][0] if s.get('sources') else None
                if src:
                    candidates.append(_item(f'lesson:{path_id}:{s["id"]}', 'lesson', f'Learn: {s["title"]}',
                                            f'Source lecture: {src["video_title"]} · estimated focused study block', 18,
                                            {'view': 'learning', 'path_id': path_id, 'step_id': s['id'],
                                             'video_id': src['video_id'], 'start': src['start']}))
                m = s.get('mastery')
                if m is None or m['status'] in ('needs_practice', 'developing'):
                    candidates.append(_item(f'assess:{path_id}:{s["id"]}', 'assessment',
                                            f'Check understanding: {s["title"]}',
                                            'Source-grounded concept assessment · scored independently of this checklist', 8,
                                            {'view': 'syllabus', 'path_id': path_id, 'step_id': s['id']}))
            from .practice import recommend
            for suggestion in recommend(path_id, db_path)['recommendations'][:8]:
                step = next((s for s in ready if s['id'] == suggestion['step_id']), None)
                if step is None:
                    continue
                candidates.append(_item(f'lab:{path_id}:{step["id"]}:{suggestion["lab_slug"]}', 'lab',
                                        suggestion['lab_title'],
                                        f'{step["title"]} · {suggestion["action"]} · grading requires local Docker', 20,
                                        {'view': 'labs', 'path_id': path_id, 'step_id': step['id'],
                                         'lab_slug': suggestion['lab_slug']}))

    if not path:
        # A useful low-dependency fallback without generated syllabi.
        with connect(db_path) as db:
            rows = db.execute('''SELECT v.id,v.title,v.duration,COALESCE(p.percent,0) AS percent,
                                       COALESCE(p.position,0) AS position FROM videos v
                                LEFT JOIN video_progress p ON p.video_id=v.id
                                WHERE v.status='done' AND COALESCE(p.completed,0)=0
                                ORDER BY COALESCE(p.percent,0) DESC,v.created_at LIMIT 3''').fetchall()
        for v in rows:
            estimate = min(20, max(8, math.ceil(max(0, (v['duration'] or 900)-v['position'])/60)))
            candidates.append(_item(f'video:{v["id"]}', 'lesson', f'Continue: {v["title"]}',
                                    'Resume the local video; estimated block is not measured playback time', estimate,
                                    {'view': 'learning', 'video_id': v['id'], 'start': v['position']}))
    return candidates, warnings


def _select(candidates: list[dict], budget: int) -> list[dict]:
    """Reserve review first; alternate new concepts, practice and checks without exceeding budget."""
    picked: list[dict] = []
    available = budget
    pool = list(candidates)
    if pool and pool[0]['kind'] == 'review':
        review = pool.pop(0)
        if review['minutes'] > available:
            review['minutes'] = available
            review['description'] += ' · prioritize the most urgent cards within this study block'
        picked.append(review)
        available -= review['minutes']
    by_type: dict[str, list[dict]] = {key: [] for key in ('lesson', 'lab', 'assessment')}
    for c in pool:
        by_type[c['kind']].append(c)
    for kind in ('lesson', 'lab', 'assessment', 'lesson', 'lab', 'assessment'):
        choices = by_type[kind]
        candidate = next((c for c in choices if c['minutes'] <= available), None)
        if candidate is not None:
            picked.append(candidate)
            available -= candidate['minutes']
            choices.remove(candidate)
    # A 15-minute budget with only long labs can still be used for one bounded block.
    if not picked and pool:
        candidate = pool[0].copy()
        candidate['minutes'] = min(budget, candidate['minutes'])
        candidate['description'] += ' · shorten this session to fit your daily goal'
        picked.append(candidate)
    return picked[:6]


def generate(study_date: str, tz_offset_minutes: int = 0, *, refresh: bool = False,
             db_path: Path | None = None) -> dict:
    local_date = _study_date(study_date)
    if isinstance(tz_offset_minutes, bool) or not -840 <= tz_offset_minutes <= 840:
        raise PlannerInputError('Timezone offset must be between -840 and 840 minutes')
    if not refresh:
        existing = get_day(study_date, db_path)
        if existing:
            return existing
    pref = preferences(db_path)
    candidates, warnings = _candidates(local_date, tz_offset_minutes, pref['path_id'], db_path)
    selected = _select(candidates, pref['daily_minutes'])
    now = utcnow()
    with connect(db_path) as db:
        existing = {r['item_key']: dict(r) for r in db.execute(
            'SELECT * FROM daily_plan_items WHERE study_date=?', (study_date,))}
        db.execute('''INSERT INTO daily_plans(study_date,path_id,budget_minutes,tz_offset_minutes,created_at,updated_at)
                      VALUES(?,?,?,?,?,?) ON CONFLICT(study_date) DO UPDATE SET
                      path_id=excluded.path_id,budget_minutes=excluded.budget_minutes,
                      tz_offset_minutes=excluded.tz_offset_minutes,updated_at=excluded.updated_at''',
                   (study_date, pref['path_id'], pref['daily_minutes'], tz_offset_minutes, now, now))
        db.execute('DELETE FROM daily_plan_items WHERE study_date=?', (study_date,))
        for item in selected:
            prior = existing.get(item['item_key'])
            db.execute('''INSERT INTO daily_plan_items
                          (id,study_date,item_key,kind,title,description,minutes,action_json,status,updated_at)
                          VALUES(?,?,?,?,?,?,?,?,?,?)''',
                       (prior['id'] if prior else uuid.uuid4().hex, study_date, item['item_key'], item['kind'],
                        item['title'], item['description'], item['minutes'], json.dumps(item['action']),
                        prior['status'] if prior and json.loads(prior['action_json']) == item['action'] else 'pending', now))
    result = get_day(study_date, db_path)
    result['warnings'] = warnings
    return result


def get_day(study_date: str, db_path: Path | None = None) -> dict | None:
    _study_date(study_date)
    with connect(db_path) as db:
        row = db.execute('SELECT * FROM daily_plans WHERE study_date=?', (study_date,)).fetchone()
        if not row:
            return None
        items = db.execute('SELECT * FROM daily_plan_items WHERE study_date=? ORDER BY rowid', (study_date,)).fetchall()
    items_out = [{**dict(x), 'action': json.loads(x['action_json'])} for x in items]
    for item in items_out:
        del item['action_json']
    warnings = []
    if row['path_id']:
        from .learning_paths import get_path, PathNotFound
        try:
            if get_path(row['path_id'], db_path)['outdated']:
                warnings.append('This saved plan references an outdated roadmap. Refresh it before starting linked practice.')
        except PathNotFound:
            warnings.append('The selected roadmap is no longer available.')
    return {'warnings': warnings, 'study_date': row['study_date'], 'path_id': row['path_id'], 'budget_minutes': row['budget_minutes'],
            'tz_offset_minutes': row['tz_offset_minutes'], 'planned_minutes': sum(x['minutes'] for x in items_out),
            'reported_done_minutes': sum(x['minutes'] for x in items_out if x['status']=='done'),
            'completed_count': sum(x['status']=='done' for x in items_out), 'items': items_out,
            'disclaimer': 'Daily checklist completion is self-reported. It never changes mastery, flashcard or lab results.'}


def set_item_status(item_id: str, status: str, db_path: Path | None = None) -> dict:
    if status not in ('pending', 'done', 'skipped'):
        raise PlannerInputError('Choose pending, done, or skipped')
    with connect(db_path) as db:
        row = db.execute('SELECT study_date FROM daily_plan_items WHERE id=?', (item_id,)).fetchone()
        if not row:
            raise PlannerNotFound('Daily plan item not found')
        db.execute('UPDATE daily_plan_items SET status=?,updated_at=? WHERE id=?', (status,utcnow(),item_id))
    return get_day(row['study_date'], db_path)
