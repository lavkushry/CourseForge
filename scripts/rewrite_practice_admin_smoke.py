#!/usr/bin/env python3
"""Check practice/admin wiring on fixed isolated loopback staging replicas.

Only disposable synthetic learners and the synthetic fixture administrator are
used. Persist aggregate assertions only; never persist HTTP bodies or credentials.
"""
import argparse
import csv
from datetime import datetime, timezone
import io
import json
from pathlib import Path
import uuid

import requests

ROOT = Path(__file__).resolve().parents[1]
BASES = ['http://127.0.0.1:18090', 'http://127.0.0.1:18091']
ORIGIN = 'http://127.0.0.1:5173'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--isolated-staging', action='store_true', required=True)
    parser.parse_args()
    checks, learners = [], []
    failure = None
    password = 'SyntheticPractice2026!'
    admin = None

    def assertion(name, ok):
        checks.append({'name': name, 'passed': bool(ok)})
        if not ok:
            raise RuntimeError(name)

    def call(account, name, method, path, status=200, body=None, replica=0, extra=None, raw=False):
        client, headers = account
        response = client.request(method, BASES[replica] + path, json=body,
                                  headers=headers | (extra or {}), timeout=10)
        checks.append({'name': name, 'passed': response.status_code == status,
                       'expected_status': status, 'actual_status': response.status_code,
                       'replica': replica + 1})
        if response.status_code != status:
            raise RuntimeError(name)
        return response if raw else response.json() if response.content else None

    def new_learner():
        account = (requests.Session(), {'Origin': ORIGIN})
        learners.append(account)
        auth = call(account, 'register disposable learner', 'POST', '/api/v1/auth/register', 201,
                    {'email': 'practice-admin-' + uuid.uuid4().hex + '@fixture.test',
                     'name': 'Synthetic practice learner', 'password': password})
        account[1]['X-CSRF-Token'] = auth['csrf_token']
        call(account, 'enroll synthetic course', 'POST', '/api/v1/courses/fixture-course/enroll', 201, {})
        return account, auth['user']['id']

    try:
        alice, owner_id = new_learner()
        bob, _ = new_learner()
        pid = 'practice_smoke_' + uuid.uuid4().hex
        path = '/api/v1/learning-paths/' + pid
        definition = {'id': pid, 'goal': 'Practice source-linked SQL',
                      'course_ids': ['fixture-course'], 'expected_revision': 0,
                      'steps': [{'id': 'sql', 'title': 'SQL aggregation', 'objectives': ['SQL joins'],
                                 'sources': [{'course_id': 'fixture-course', 'lesson_id': 'fixture-lesson-1', 'start': 0}],
                                 'prerequisites': [], 'goal_focus': True}]}
        call(alice, 'create manual SQL path', 'POST', '/api/v1/learning-paths/manual', 201,
             definition, extra={'Idempotency-Key': 'practice-path'})
        recommendations = call(alice, 'read practice recommendations on replica', 'GET',
                               path + '/practice-recommendations', replica=1)
        rows = recommendations['recommendations']
        assertion('SQL lab match has truthful unavailable adapter',
                  any(row['lab_slug'] == 'sql-customer-revenue' for row in rows)
                  and all(not row['available'] and row.get('unavailable_reason') for row in rows))
        assertion('source suggestions grant no mastery',
                  bool(recommendations['source_suggestions'])
                  and all(not row['grants_mastery'] for row in recommendations['source_suggestions']))
        for suffix in ('practice-recommendations', 'practice-history', 'practice-status'):
            call(bob, 'deny other learner ' + suffix, 'GET', path + '/' + suffix, 404, replica=1)
        history = call(alice, 'read empty immutable practice history', 'GET', path + '/practice-history')
        assertion('no fabricated verified attempts', history['attempts'] == [])
        status = call(alice, 'read private practice status', 'GET', path + '/practice-status', replica=1)
        assertion('status contains no invented passes', not status['steps'])
        start = path + '/steps/sql/practice/sql-customer-revenue/start'
        call(alice, 'reject missing practice CSRF', 'POST', start, 403, {},
             extra={'Idempotency-Key': 'start-csrf', 'X-CSRF-Token': ''})
        call(alice, 'require actual lab adapter', 'POST', start, 503, {},
             extra={'Idempotency-Key': 'start-unavailable'})
        call(alice, 'reject client-provided grading fields', 'POST',
             '/api/v1/practice/sessions/missing/verified-attempts', 400,
             {'evidence_id': 'forged', 'passed': True}, extra={'Idempotency-Key': 'forged'})
        call(alice, 'bound recommendation query', 'GET', path + '/practice-recommendations?limit=101', 422)

        admin = (requests.Session(), {'Origin': ORIGIN})
        auth = call(admin, 'sign in synthetic fixture administrator', 'POST', '/api/v1/auth/login', 200,
                    {'email': 'admin@example.test', 'password': 'CourseForgeDemo2026!'})
        admin[1]['X-CSRF-Token'] = auth['csrf_token']
        routes = ['overview', 'course-funnels', 'learner-reports',
                  'users/' + owner_id + '/learning-report', 'users/' + owner_id + '/reports/progress',
                  'player-activity', 'player-activity/export', 'playback', 'playback/export',
                  'audit', 'access-events', 'system']
        guest = (requests.Session(), {'Origin': ORIGIN})
        for suffix in routes:
            url = '/api/v1/admin/' + suffix
            call(guest, 'deny anonymous admin ' + suffix.split('/')[0], 'GET', url, 401)
            call(alice, 'deny learner admin ' + suffix.split('/')[0], 'GET', url, 403, replica=1)
        report = call(admin, 'read actual administrator learner report', 'GET',
                      '/api/v1/admin/users/' + owner_id + '/learning-report', replica=1)
        assertion('administrator independent totals start empty',
                  report['user']['activity_seconds'] == 0 and report['user']['watched_seconds'] == 0
                  and report['user']['measured_focus_seconds'] == 0)
        assertion('report unavailable history is explicit', set(report['unavailable_sections']) == {'events', 'labs'})
        for section in ('events', 'labs'):
            call(admin, 'unavailable real report adapter ' + section, 'GET',
                 '/api/v1/admin/users/' + owner_id + '/reports/' + section, 503)
        for suffix in ('overview', 'course-funnels', 'learner-reports', 'audit', 'access-events', 'system'):
            response = call(admin, 'read administrator ' + suffix, 'GET', '/api/v1/admin/' + suffix, raw=True)
            assertion('administrator ' + suffix + ' is private/no-store', 'no-store' in response.headers.get('Cache-Control', ''))
        for suffix, basis in [('player-activity', 'visible_lesson_activity'), ('playback', 'accepted_browser_playback')]:
            report = call(admin, 'read filtered ' + suffix, 'GET', '/api/v1/admin/' + suffix + '?user_id=' + owner_id, replica=1)
            assertion(suffix + ' separates retained sessions from lifetime totals',
                      report['basis'] == basis and report['total'] == 0 and report['summary']['session_seconds'] == 0)
            response = call(admin, 'export complete filtered ' + suffix, 'GET',
                            '/api/v1/admin/' + suffix + '/export?user_id=' + owner_id, raw=True)
            csv_rows = list(csv.reader(io.StringIO(response.text)))
            assertion(suffix + ' CSV is complete empty-filter header only',
                      len(csv_rows) == 1 and bool(csv_rows[0])
                      and response.headers.get('Content-Type', '').startswith('text/csv')
                      and response.headers.get('X-Content-Type-Options') == 'nosniff')
            call(admin, 'reject partial paginated export ' + suffix, 'GET',
                 '/api/v1/admin/' + suffix + '/export?limit=1', 400)
        call(admin, 'bound administrator period', 'GET', '/api/v1/admin/playback?days=91', 400)
    except Exception as exc:
        failure = str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__
    finally:
        for account in learners:
            try:
                call(account, 'delete disposable synthetic learner', 'DELETE', '/api/v1/auth/me', 200,
                     {'password': password})
            except Exception:
                failure = failure or 'disposable learner cleanup failed'
        if admin and admin[1].get('X-CSRF-Token'):
            try:
                call(admin, 'revoke smoke administrator login', 'POST', '/api/v1/auth/logout', 200, {})
            except Exception:
                failure = failure or 'administrator login cleanup failed'
    report = {'timestamp': datetime.now(timezone.utc).isoformat(), 'scope': 'isolated staging practice/admin HTTP',
              'checks': checks, 'passed': sum(row['passed'] for row in checks),
              'failed': sum(not row['passed'] for row in checks), 'error': failure,
              'excluded': ['real runner/grading', 'browser admin flow', 'production', 'capacity', 'legacy semantic import']}
    (ROOT / 'docs/rewrite/PRACTICE_ADMIN_STAGING_HTTP.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'checks': len(checks), 'passed': report['passed'], 'failed': report['failed'], 'error': failure}))
    if failure:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
