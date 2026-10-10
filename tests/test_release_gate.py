"""Step 11: diagnostic smoke tests must not be mistaken for release proof."""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timedelta, timezone
import json

from scripts import release_gate

COMMIT = 'a' * 40
NOW = datetime(2026, 10, 10, 10, 0, tzinfo=timezone.utc)


def valid_report():
    checks = [{'name': name, 'status': 'PASS', 'detail': ''} for name in release_gate.REQUIRED_CHECKS]
    return {'schema_version': 1, 'generated_at_utc': NOW.isoformat(), 'git_commit': COMMIT,
            'summary': {'PASS': len(checks), 'FAIL': 0, 'SKIP': 0}, 'checks': checks}


def issues(data):
    return release_gate.evaluate(data, expected_commit=COMMIT, now=NOW)['issues']


def test_complete_fresh_matching_device_report_is_review_ready():
    data = release_gate.evaluate(valid_report(), expected_commit=COMMIT, now=NOW)
    assert data['ready'] and data['passed'] == 20


def test_missing_or_skipped_capability_blocks_release():
    for status in ('SKIP', 'FAIL'):
        data = valid_report()
        data['checks'][5]['status'] = status
        data['summary']['PASS'] -= 1
        data['summary'][status] += 1
        assert any('Mandatory check not passed: timestamped note read' in x for x in issues(data))
    data = valid_report()
    data['checks'].pop()
    data['summary']['PASS'] -= 1
    assert any('browser uncaught JavaScript errors (MISSING)' in x for x in issues(data))


def test_duplicate_checks_and_tampered_counts_fail_closed():
    data = valid_report()
    data['checks'].append(deepcopy(data['checks'][0]))
    assert any('Duplicate check entries' in x for x in issues(data))
    data = valid_report()
    data['summary']['PASS'] += 1
    assert any('Summary totals' in x for x in issues(data))


def test_stale_future_or_tz_naive_reports_rejected():
    data = valid_report()
    data['generated_at_utc'] = (NOW-timedelta(hours=73)).isoformat()
    assert any('older than' in x for x in issues(data))
    data['generated_at_utc'] = (NOW+timedelta(minutes=6)).isoformat()
    assert any('future' in x for x in issues(data))
    data['generated_at_utc'] = NOW.replace(tzinfo=None).isoformat()
    assert any('UTC generation timestamp' in x for x in issues(data))


def test_version_and_sha_mismatch_rejected():
    data = valid_report()
    data['git_commit'] = 'b'*40
    data['schema_version'] = 2
    assert any('expected Git revision' in x for x in issues(data))
    assert any('schema version' in x for x in issues(data))


def test_malformed_report_and_invented_status_rejected():
    assert not release_gate.evaluate(None, expected_commit=COMMIT, now=NOW)['ready']
    data = valid_report()
    data['checks'][0]['status'] = 'SUCCESS'
    assert not release_gate.evaluate(data, expected_commit=COMMIT, now=NOW)['ready']
    data = valid_report()
    data['checks'] = 'PASS'
    assert not release_gate.evaluate(data, expected_commit=COMMIT, now=NOW)['ready']


def test_git_tree_audit_guards_local_assets():
    assert release_gate.tracked_file_audit(['README.md', '.env.example', 'courses/.gitkeep', 'data/.gitkeep']) == []
    bad = ['.env', 'data/courseforge.sqlite3', 'courses/lecture.mp4',
           'data/acceptance-report.json', 'private.pem', 'docs/courseforge-acceptance.png']
    assert sorted(release_gate.tracked_file_audit(bad)) == sorted(bad)


def test_cli_fails_on_partial_report_and_succeeds_only_full_report(tmp_path, capsys):
    report = valid_report()
    report['generated_at_utc'] = datetime.now(timezone.utc).isoformat()
    output = tmp_path / 'report.json'
    output.write_text(json.dumps(report))
    argv = ['--report', str(output), '--expected-commit', COMMIT]
    assert release_gate.main(argv) == 0
    report['checks'][0]['status'] = 'SKIP'
    report['summary']['SKIP'] = 1
    report['summary']['PASS'] -= 1
    output.write_text(json.dumps(report))
    assert release_gate.main(argv) == 1
    assert 'BLOCKED' in capsys.readouterr().out
