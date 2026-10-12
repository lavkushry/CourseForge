#!/usr/bin/env python3
"""Check integrated paths/activity on fixed isolated rewrite API replicas.

Uses disposable synthetic accounts and existing synthetic fixture lessons. Reports
aggregate checks only, never cookies, response content, media URLs or identities.
"""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import time
import uuid

import requests

ROOT = Path(__file__).resolve().parents[1]
BASES = ['http://127.0.0.1:18090', 'http://127.0.0.1:18091']
ORIGIN = 'http://127.0.0.1:5173'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--isolated-staging', action='store_true', required=True)
    parser.parse_args()
    checks, accounts = [], []
    error = None
    password = 'SyntheticProduct2026!'

    def assertion(name, passed):
        checks.append({'name': name, 'passed': bool(passed)})
        if not passed:
            raise RuntimeError(name)

    def call(account, name, method, path, status, body=None, replica=0, extra=None):
        client, headers = account
        response = client.request(method, BASES[replica] + path, json=body,
                                  headers=headers | (extra or {}), timeout=10)
        checks.append({'name': name, 'passed': response.status_code == status,
                       'expected_status': status, 'actual_status': response.status_code,
                       'replica': replica + 1})
        if response.status_code != status:
            raise RuntimeError(name)
        return response.json() if response.content else None

    def new_account():
        account = (requests.Session(), {'Origin': ORIGIN})
        accounts.append(account)
        auth = call(account, 'register disposable synthetic learner', 'POST',
                    '/api/v1/auth/register', 201,
                    {'email': 'product-smoke-' + uuid.uuid4().hex + '@fixture.test',
                     'name': 'Product fixture', 'password': password})
        account[1]['X-CSRF-Token'] = auth['csrf_token']
        call(account, 'enroll synthetic learner', 'POST', '/api/v1/courses/fixture-course/enroll', 201, {})
        return account

    try:
        alice, bob = new_account(), new_account()
        path_id = 'smoke_' + uuid.uuid4().hex
        definition = {'id': path_id, 'goal': 'Practice synthetic source topics',
                      'course_ids': ['fixture-course'], 'expected_revision': 0,
                      'steps': [{'id': 'first', 'title': 'First topic', 'objectives': [],
                                 'sources': [{'course_id': 'fixture-course', 'lesson_id': 'fixture-lesson-1', 'start': 0}],
                                 'prerequisites': [], 'goal_focus': True},
                                {'id': 'next', 'title': 'Dependent topic', 'objectives': [],
                                 'sources': [{'course_id': 'fixture-course', 'lesson_id': 'fixture-lesson-2', 'start': 0}],
                                 'prerequisites': ['first'], 'goal_focus': False}]}
        path_url = '/api/v1/learning-paths/' + path_id
        saved = call(alice, 'create explicitly manual path', 'POST', '/api/v1/learning-paths/manual', 201,
                     definition, extra={'Idempotency-Key': 'path-create'})
        replay = call(alice, 'replay path creation on replica', 'POST', '/api/v1/learning-paths/manual', 201,
                      definition, replica=1, extra={'Idempotency-Key': 'path-create'})
        assertion('creation replay is immutable snapshot', saved == replay)
        call(bob, 'deny another learner path read', 'GET', path_url, 404, replica=1)
        listed = call(bob, 'other learner path list is private', 'GET', '/api/v1/learning-paths', 200)
        assertion('another learner cannot list the path', not listed['paths'])
        call(alice, 'reject missing path CSRF', 'PUT', path_url + '/steps/first', 403,
             {'completed': True, 'expected_revision': 1}, extra={'X-CSRF-Token': '', 'Idempotency-Key': 'csrf-denied'})
        call(alice, 'reject locked prerequisite completion', 'PUT', path_url + '/steps/next', 409,
             {'completed': True, 'expected_revision': 1}, extra={'Idempotency-Key': 'locked'})
        completed = call(alice, 'complete private checklist step', 'PUT', path_url + '/steps/first', 200,
                         {'completed': True, 'expected_revision': 1}, replica=1, extra={'Idempotency-Key': 'complete'})
        assertion('checklist grants no assessed mastery', completed['completed_steps'] == 1 and completed['assessed_topics'] == 0)
        progress = call(alice, 'read separate lesson completion', 'GET', '/api/v1/lessons/fixture-lesson-1/progress', 200)
        assertion('path checklist does not complete lesson', not progress['completed'])
        call(alice, 'require real executor for generated path', 'POST', '/api/v1/learning-paths', 503,
             {'course_ids': ['fixture-course'], 'goal': 'Generate synthetic topics'}, extra={'Idempotency-Key': 'generate'})
        call(alice, 'connect authorized path to planner', 'PUT', '/api/v1/planner/preferences', 200,
             {'daily_minutes': 45, 'expected_revision': 0, 'path_id': path_id}, extra={'Idempotency-Key': 'path-planner'})
        today = datetime.now(timezone.utc).date().isoformat()
        call(alice, 'build source-backed plan with path adapter', 'POST', '/api/v1/planner/days', 201,
             {'study_date': today}, replica=1, extra={'Idempotency-Key': 'plan'})

        lesson = '/api/v1/lessons/fixture-lesson-1'
        opened = call(alice, 'open independent visible page activity', 'POST', lesson + '/activity-session', 201, {})
        assertion('page open grants no time', opened['activity_seconds'] == 0 and opened['owner'])
        activity_url = '/api/v1/activity/' + opened['id'] + '/heartbeat'
        call(bob, 'deny other learner activity heartbeat', 'POST', activity_url, 404,
             {'sequence': 1, 'visible': True, 'elapsed_seconds': 20})
        time.sleep(0.5)
        pulse = {'sequence': 1, 'visible': True, 'elapsed_seconds': 20}
        ack = call(alice, 'credit server-bounded visible interval', 'POST', activity_url, 200, pulse, replica=1)
        assertion('client cannot invent twenty seconds', 0 < ack['activity_seconds'] < 5 and ack['accepted'])
        duplicate = call(alice, 'retry activity sequence on replica', 'POST', activity_url, 200, pulse)
        assertion('duplicate interval grants no second credit', not duplicate['accepted'] and duplicate['activity_seconds'] == ack['activity_seconds'])
        summary = call(alice, 'read private lifetime learning summary', 'GET', '/api/v1/me/learning', 200, replica=1)
        assertion('visible, watched and focus totals remain distinct', summary['activity_seconds'] == ack['activity_seconds'] and summary['watched_seconds'] == 0 and summary['measured_focus_seconds'] == 0)
        call(alice, 'end page activity permanently', 'POST', activity_url, 200,
             {'sequence': 2, 'visible': False, 'elapsed_seconds': 0, 'ended': True})

        player = call(alice, 'open native playback owner', 'POST', '/api/v1/playback/sessions', 201,
                      {'lesson_id': 'fixture-lesson-1'})
        bound = call(alice, 'bind activity to exact playback session', 'POST', lesson + '/activity-session', 201,
                     {'player_session_id': player['id']}, replica=1)
        call(alice, 'release native playback ownership', 'POST', '/api/v1/playback/sessions/' + player['id'] + '/release', 200, {})
        baseline = call(alice, 'released player cannot own activity', 'POST', '/api/v1/activity/' + bound['id'] + '/heartbeat', 200,
                        {'sequence': 1, 'visible': True, 'elapsed_seconds': 20}, replica=1)
        assertion('released bound activity gets zero credit', not baseline['owner'] and baseline['activity_seconds'] == 0)
        call(alice, 'explicitly reclaim native owner', 'POST', '/api/v1/playback/sessions/' + player['id'] + '/claim', 200, {'take_over': False})
        call(alice, 'deliberate takeover creates fresh native session', 'POST', '/api/v1/playback/sessions', 201,
             {'lesson_id': 'fixture-lesson-2', 'take_over': True}, replica=1)
        closed = call(alice, 'takeover closes previous bound activity', 'POST', '/api/v1/activity/' + bound['id'] + '/heartbeat', 200,
                      {'sequence': 2, 'visible': True, 'elapsed_seconds': 20})
        assertion('taken-over activity is permanently closed', closed['closed'] and not closed['accepted'] and not closed['owner'])
        call(alice, 'remove private path at current revision', 'DELETE', path_url, 200,
             {'expected_revision': completed['revision']}, extra={'Idempotency-Key': 'path-delete'})
        call(alice, 'deleted path unavailable on replica', 'GET', path_url, 404, replica=1)
    except Exception as failure:
        error = type(failure).__name__
    finally:
        for account in accounts:
            if 'X-CSRF-Token' in account[1]:
                try:
                    call(account, 'remove disposable smoke account', 'DELETE', '/api/v1/auth/me', 200, {'password': password})
                except Exception:
                    error = error or 'CleanupFailure'
            account[0].close()
        report = {'observed_at': datetime.now(timezone.utc).isoformat(),
                  'command': 'python3 scripts/rewrite_product_smoke.py --isolated-staging',
                  'contracts': ['docs/rewrite/PATHS_CONTRACT.md', 'docs/rewrite/ACTIVITY_CONTRACT.md'],
                  'scope': 'Two fixed isolated Go replicas; disposable synthetic learners; manual paths and activity/playback lifecycle; no media/provider/model/load calls',
                  'checks': checks, 'passed': sum(c['passed'] for c in checks),
                  'failed': sum(not c['passed'] for c in checks), 'harness_error': error,
                  'capacity_proven': False, 'restart_proven': False}
        (ROOT / 'docs/rewrite/PRODUCT_STAGING_HTTP.json').write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps({key: report[key] for key in ['passed', 'failed', 'harness_error']}))
    return 1 if report['failed'] or error else 0


if __name__ == '__main__':
    raise SystemExit(main())
