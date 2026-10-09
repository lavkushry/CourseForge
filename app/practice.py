"""Deterministic, transparent practice suggestions backed by verified lab grading.

No guessed skill mastery, no auto-completion, and no user-authored execution outside the
existing restricted graders. Suggestions are based on course topic text and latest
assessment signal. Session links can only be created for a compatible curated lab.
"""
from __future__ import annotations

import json
import re
import uuid
from pathlib import Path

from .db import connect, utcnow
from .labs import LABS


class PracticeNotFound(KeyError):
    pass


class PracticeInputError(ValueError):
    pass


# Explicit curated taxonomy, rather than AI-invented runnable tasks.
TOPIC_TERMS: dict[str, tuple[str, ...]] = {
    'python-log-analysis': ('python', 'logging', 'log analysis', 'application log', 'error handling', 'exceptions'),
    'shell-http-analysis': ('shell', 'bash', 'linux', 'awk', 'access log', 'http status', 'server log'),
    'k8s-resilient-service': ('kubernetes', 'k8s', 'deployment', 'readiness probe', 'kubectl', 'pod', 'helm'),
    'sql-customer-revenue': ('sql', 'database', 'relational', 'join', 'group by', 'aggregation', 'query'),
    'pyspark-order-analytics': ('pyspark', 'apache spark', 'spark', 'dataframe', 'etl', 'data pipeline'),
    'docker-hardened-service': ('docker', 'dockerfile', 'container image', 'containerization', 'oci image'),
    'ansible-idempotent-web': ('ansible', 'playbook', 'idempotency', 'infrastructure as code', 'automation'),
    'backend-request-handler': ('backend', 'rest api', 'restful', 'request validation', 'http api', 'fastapi', 'spring boot'),
}


def ensure_schema(db_path: Path | None = None) -> None:
    with connect(db_path) as db:
        db.executescript('''
        CREATE TABLE IF NOT EXISTS practice_sessions (
            session_id TEXT PRIMARY KEY REFERENCES lab_sessions(id) ON DELETE CASCADE,
            path_id TEXT NOT NULL REFERENCES learning_paths(id) ON DELETE CASCADE,
            step_id TEXT NOT NULL, lab_slug TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS practice_sessions_path ON practice_sessions(path_id,step_id);
        CREATE TABLE IF NOT EXISTS practice_attempts (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES practice_sessions(session_id) ON DELETE CASCADE,
            passed INTEGER NOT NULL CHECK(passed IN (0,1)),
            checks_passed INTEGER NOT NULL, checks_total INTEGER NOT NULL,
            result_json TEXT NOT NULL, completed_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS practice_attempts_session ON practice_attempts(session_id,completed_at);
        ''')


def _topic_score(step: dict, slug: str) -> int:
    # Boundaries prevent SQL matching 'nosql' or 'sql' inside a random token.
    words = ' '.join([str(step.get('title', ''))] + list(step.get('objectives', []))).lower()
    return sum(2 if re.search(r'(?<!\w)' + re.escape(term) + r'(?!\w)', words) else 0
               for term in TOPIC_TERMS[slug])


def outcomes_for_path(path_id: str, db_path: Path | None = None) -> dict[str, dict]:
    """Latest real grader attempts per topic; previous failures remain in append-only history."""
    with connect(db_path) as db:
        rows = db.execute('''
            SELECT s.step_id,s.lab_slug,a.passed,a.checks_passed,a.checks_total,a.completed_at,a.rowid
            FROM practice_sessions s JOIN practice_attempts a ON a.session_id=s.session_id
            WHERE s.path_id=? ORDER BY a.rowid DESC
        ''', (path_id,)).fetchall()
    result: dict[str, dict] = {}
    for row in rows:
        step = result.setdefault(row['step_id'], {'attempts': 0, 'passed_labs': [], 'labs': {}})
        step['attempts'] += 1
        lab = step['labs'].setdefault(row['lab_slug'], {
            'attempts': 0, 'last_passed': bool(row['passed']),
            'last_checks_passed': row['checks_passed'], 'last_checks_total': row['checks_total'],
            'last_attempt_at': row['completed_at'],
        })
        lab['attempts'] += 1
    for step in result.values():
        step['passed_labs'] = sorted(slug for slug, lab in step['labs'].items() if lab['last_passed'])
    return result


def recommend(path_id: str, db_path: Path | None = None) -> dict:
    from .learning_paths import get_path, PathNotFound
    try:
        path = get_path(path_id, db_path)
    except PathNotFound as exc:
        raise PracticeNotFound(path_id) from exc
    outcomes = outcomes_for_path(path_id, db_path)
    choices = []
    for step in path['steps']:
        mastery = step.get('mastery')
        if mastery and mastery['status'] == 'ready_for_review':
            # Learner has a strong quiz signal; still allow re-practice after failures.
            if not (step.get('practice') or {}).get('attempts'):
                continue
        for slug, lab in LABS.items():
            relevance = _topic_score(step, slug)
            if relevance == 0:
                continue
            prior = outcomes.get(step['id'], {}).get('labs', {}).get(slug)
            tested = (prior or {}).get('attempts', 0)
            passed = (prior or {}).get('last_passed', False)
            if passed and mastery and mastery['status'] == 'ready_for_review':
                continue  # no longer a current gap
            if passed:
                action = 'Recheck the concept' if mastery else 'Take a concept assessment'
            elif tested:
                action = 'Retry graded lab'
            elif not mastery:
                action = 'Assess the concept, then practice'
            else:
                action = 'Practice weak concept' if mastery['status'] == 'needs_practice' else 'Build fluency'
            priority = (100 if mastery and mastery['status'] == 'needs_practice' else
                        65 if mastery and mastery['status'] == 'developing' else
                        35 if mastery else 12)
            if tested and not passed:
                priority += 18
            if passed:
                priority -= 55
            priority += min(relevance, 8)
            choices.append({
                'path_id': path_id, 'step_id': step['id'], 'step_title': step['title'],
                'lab_slug': slug, 'lab_title': lab['title'], 'category': lab['category'],
                'lab_type': lab['type'], 'priority': priority, 'match_reason': 'Matched course topic / objective',
                'action': action, 'assessment_score': mastery['last_score'] if mastery else None,
                'lab_attempts': tested, 'last_lab_passed': bool(passed),
                'source': step['sources'][0] if step.get('sources') else None,
            })
    choices.sort(key=lambda c: (-c['priority'], -_topic_score(next(
        s for s in path['steps'] if s['id'] == c['step_id']), c['lab_slug']),
                            c['step_title'].lower(), c['lab_slug']))
    return {
        'path_id': path_id,
        'outdated': path['outdated'],
        'recommendations': choices,
        'topics_without_recommendations': [s['id'] for s in path['steps'] if not any(
            r['step_id'] == s['id'] for r in choices)],
        'policy': 'Transparent curated topic matching; assessment and lab signals are separate. No auto-mastery.',
    }


def start_recommended(path_id: str, step_id: str, slug: str, db_path: Path | None = None) -> dict:
    from .learning_paths import get_path
    from . import labs
    path = get_path(path_id, db_path)
    if path['outdated']:
        raise PracticeInputError('Refresh this outdated learning path before starting new linked practice')
    step = next((s for s in path['steps'] if s['id'] == step_id), None)
    if not step:
        raise PracticeNotFound(step_id)
    if slug not in LABS:
        raise PracticeNotFound(slug)
    if not _topic_score(step, slug):
        raise PracticeInputError('Lab does not match this topic; choose a relevant curated exercise')
    session = labs.start_lab(slug)
    with connect(db_path) as db:
        db.execute('''INSERT INTO practice_sessions(session_id,path_id,step_id,lab_slug,created_at)
                      VALUES(?,?,?,?,?)''', (session['session_id'], path_id, step_id, slug, utcnow()))
    session['practice_context'] = {'path_id': path_id, 'step_id': step_id}
    return session


def record_verified_grade(session_id: str, result: dict, db_path: Path | None = None) -> dict | None:
    """Called only after the existing restricted Docker grader finishes successfully."""
    with connect(db_path) as db:
        link = db.execute('SELECT * FROM practice_sessions WHERE session_id=?', (session_id,)).fetchone()
        if not link:
            return None  # ordinary unlinked lab retains existing v2 behavior
        checks = result.get('checks')
        if not isinstance(checks, list) or not checks or not all(
                isinstance(x, dict) and isinstance(x.get('passed'), bool) for x in checks):
            raise PracticeInputError('Invalid verified grading result')
        verified_pass = bool(result.get('passed')) and all(x['passed'] for x in checks)
        saved = {
            'id': 'pa_' + uuid.uuid4().hex, 'session_id': session_id,
            'path_id': link['path_id'], 'step_id': link['step_id'], 'lab_slug': link['lab_slug'],
            'passed': verified_pass, 'checks_passed': sum(x['passed'] for x in checks),
            'checks_total': len(checks), 'completed_at': utcnow(),
        }
        db.execute('''INSERT INTO practice_attempts(id,session_id,passed,checks_passed,checks_total,result_json,completed_at)
                      VALUES(?,?,?,?,?,?,?)''',
                   (saved['id'], session_id, int(verified_pass), saved['checks_passed'],
                    saved['checks_total'], json.dumps(result), saved['completed_at']))
        return saved


def history(path_id: str, step_id: str | None = None, db_path: Path | None = None) -> list[dict]:
    from .learning_paths import get_path, PathNotFound
    path = get_path(path_id, db_path)
    if step_id and step_id not in {s['id'] for s in path['steps']}:
        raise PracticeNotFound(step_id)
    sql = '''SELECT a.id,a.session_id,s.step_id,s.lab_slug,a.passed,a.checks_passed,
                    a.checks_total,a.completed_at FROM practice_attempts a
             JOIN practice_sessions s ON s.session_id=a.session_id WHERE s.path_id=?'''
    args: list = [path_id]
    if step_id:
        sql += ' AND s.step_id=?'
        args.append(step_id)
    sql += ' ORDER BY a.rowid DESC LIMIT 100'
    with connect(db_path) as db:
        return [dict(row) | {'passed': bool(row['passed'])} for row in db.execute(sql, args)]
