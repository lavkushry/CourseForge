#!/usr/bin/env python3
"""Exercise the planning contract on the two fixed isolated staging replicas.

Uses one disposable synthetic account. Emits aggregate checks only, never cookies,
CSRF tokens, passwords, response bodies or timer identifiers. No provider/load calls.
"""
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta, datetime, timezone
from pathlib import Path
import argparse
import json
import uuid

import requests

ROOT = Path(__file__).resolve().parents[1]
BASES = ['http://127.0.0.1:18090', 'http://127.0.0.1:18091']
ORIGIN = 'http://127.0.0.1:5173'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--isolated-staging', action='store_true', required=True)
    parser.parse_args()
    checks = []
    session = requests.Session()
    password = 'SyntheticPlanning2026!'
    email = 'planning-smoke-' + uuid.uuid4().hex + '@fixture.test'
    headers = {'Origin': ORIGIN}
    error = None

    def check(name, method, path, expected, body=None, replica=0, extra=None):
        response = session.request(method, BASES[replica] + path, json=body,
                                   headers=headers | (extra or {}), timeout=10)
        passed = response.status_code == expected
        checks.append({'name': name, 'passed': passed, 'expected_status': expected,
                       'actual_status': response.status_code, 'replica': replica + 1})
        if not passed:
            raise RuntimeError(name + ': status ' + str(response.status_code))
        return response.json() if response.content else None

    try:
        auth = check('synthetic registration', 'POST', '/api/v1/auth/register', 201,
                     {'email': email, 'name': 'Planning fixture', 'password': password})
        headers['X-CSRF-Token'] = auth['csrf_token']
        auth = check('synthetic sign-in with rotated cookie', 'POST', '/api/v1/auth/login', 200,
                     {'email': email, 'password': password})
        headers['X-CSRF-Token'] = auth['csrf_token']
        check('private preference defaults', 'GET', '/api/v1/planner/preferences', 200)
        check('reject missing CSRF', 'PUT', '/api/v1/planner/preferences', 403,
              {'daily_minutes': 45, 'expected_revision': 0},
              extra={'X-CSRF-Token': '', 'Idempotency-Key': 'bad-csrf'})
        check('require command key', 'PUT', '/api/v1/planner/preferences', 400,
              {'daily_minutes': 45, 'expected_revision': 0})
        body = {'daily_minutes': 60, 'expected_revision': 0}
        saved = check('save daily preference', 'PUT', '/api/v1/planner/preferences', 200,
                      body, extra={'Idempotency-Key': 'prefs'})
        replay = check('durable command replay on replica', 'PUT', '/api/v1/planner/preferences', 200,
                       body, replica=1, extra={'Idempotency-Key': 'prefs'})
        checks.append({'name': 'replay equals committed snapshot', 'passed': saved == replay})
        check('same key changed command denied', 'PUT', '/api/v1/planner/preferences', 409,
              body | {'daily_minutes': 90}, extra={'Idempotency-Key': 'prefs'})
        check('stale planner revision denied', 'PUT', '/api/v1/planner/preferences', 409,
              body, replica=1, extra={'Idempotency-Key': 'stale'})

        def race(index):
            with requests.Session() as client:
                client.cookies.update(session.cookies)
                return client.put(BASES[index] + '/api/v1/planner/preferences',
                                  json={'daily_minutes': 75 + index * 15,
                                        'expected_revision': saved['revision']},
                                  headers=headers | {'Idempotency-Key': 'race' + str(index)},
                                  timeout=10).status_code

        with ThreadPoolExecutor(max_workers=2) as pool:
            statuses = sorted(pool.map(race, range(2)))
        checks.append({'name': 'concurrent edits have one winner across replicas',
                       'passed': statuses == [200, 409], 'actual_statuses': statuses})
        check('save week budgets', 'PUT', '/api/v1/planner/week-preferences', 200,
              {'weekday_minutes': [45, 45, 45, 45, 45, 0, 0], 'expected_revision': 0},
              extra={'Idempotency-Key': 'weekprefs'})
        check('read week budgets on replica', 'GET', '/api/v1/planner/week-preferences', 200, replica=1)
        today = datetime.now(timezone.utc).date()
        monday = today - timedelta(days=today.weekday())
        check('create day snapshot', 'POST', '/api/v1/planner/days', 201,
              {'study_date': today.isoformat()}, extra={'Idempotency-Key': 'day'})
        check('read day snapshot on replica', 'GET', '/api/v1/planner/days/' + today.isoformat(), 200, replica=1)
        check('create weekly snapshot', 'POST', '/api/v1/planner/weeks', 201,
              {'week_start': monday.isoformat()}, extra={'Idempotency-Key': 'week'})
        check('read weekly snapshot on replica', 'GET', '/api/v1/planner/weeks/' + monday.isoformat(), 200, replica=1)
        focus = check('start server focus timer', 'POST', '/api/v1/focus/sessions', 201,
                      {'duration_minutes': 25}, extra={'Idempotency-Key': 'focus'})
        active = check('read active focus on replica', 'GET', '/api/v1/focus/active', 200, replica=1)
        checks.append({'name': 'replica reads same focus identifier',
                       'passed': active['session']['id'] == focus['id']})
        check('second active timer conflicts', 'POST', '/api/v1/focus/sessions', 409, {},
              replica=1, extra={'Idempotency-Key': 'second-focus'})
        action = '/api/v1/focus/sessions/' + focus['id'] + '/actions'
        paused = check('hidden pauses server timer', 'POST', action, 200,
                       {'action': 'hidden', 'expected_revision': focus['revision']},
                       replica=1, extra={'Idempotency-Key': 'hidden'})
        checks.append({'name': 'hidden state is paused', 'passed': paused['status'] == 'paused'})
        check('client cannot submit elapsed time', 'POST', action, 400,
              {'action': 'resume', 'expected_revision': paused['revision'], 'elapsed_seconds': 999},
              extra={'Idempotency-Key': 'invent-time'})
        ended = check('cancel focus timer', 'POST', action, 200,
                      {'action': 'cancel', 'expected_revision': paused['revision']},
                      extra={'Idempotency-Key': 'cancel'})
        checks.append({'name': 'cancel is terminal', 'passed': ended['status'] == 'cancelled'})
        for path in ['/focus/history', '/focus/analytics/' + monday.isoformat(), '/me/habits', '/studio/insights']:
            check('private read ' + path, 'GET', '/api/v1' + path, 200, replica=1)
    except Exception as failure:
        error = type(failure).__name__
    finally:
        if 'X-CSRF-Token' in headers:
            try:
                response = session.delete(BASES[0] + '/api/v1/auth/me', headers=headers,
                                          json={'password': password}, timeout=10)
                checks.append({'name': 'remove synthetic smoke account',
                               'passed': response.status_code in [200, 204],
                               'actual_status': response.status_code})
            except requests.RequestException:
                checks.append({'name': 'remove synthetic smoke account', 'passed': False})
        report = {'observed_at': datetime.now(timezone.utc).isoformat(),
                  'command': 'python3 scripts/rewrite_planning_smoke.py --isolated-staging',
                  'contract': 'docs/rewrite/PLANNING_CONTRACT.md',
                  'scope': 'Two fixed isolated staging replicas; one synthetic disposable account; no production/provider/media/AI/load calls',
                  'checks': checks, 'passed': sum(c['passed'] for c in checks),
                  'failed': sum(not c['passed'] for c in checks), 'harness_error': error,
                  'capacity_proven': False, 'restart_proven': False}
        (ROOT / 'docs/rewrite/PLANNING_STAGING_HTTP.json').write_text(json.dumps(report, indent=2) + '\n')
        session.close()
        print(json.dumps({key: report[key] for key in ['passed', 'failed', 'harness_error']}))
    return 1 if report['failed'] or error else 0


if __name__ == '__main__':
    raise SystemExit(main())
