"""Fail-closed CourseForge v3 release readiness evaluation.

This evaluates the local acceptance report's shape, freshness and revision.
It does not cryptographically attest the report or the testing device.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import re
import subprocess

REQUIRED_CHECKS = (
    'local FastAPI health',
    'indexed lecture and transcript',
    'source timestamps',
    'video byte-range seeking',
    'note create',
    'timestamped note read',
    'probe note cleanup',
    'focus session starts and links to lesson',
    'focus pauses',
    'focus resumes',
    'focus persisted history',
    'probe timer cleanup',
    'lab file save',
    'real isolated Docker grading',
    'real Whisper/Ollama/Qdrant/AI pipeline',
    'real Chromium app initialization',
    'real Chromium library navigation',
    'real Chromium planner navigation',
    'real Chromium video decode and seek',
    'browser uncaught JavaScript errors',
)
SHA = re.compile(r'^[0-9a-f]{40}$')


def evaluate(report: object, *, expected_commit: str, now: datetime | None = None,
             max_age_hours: int = 72) -> dict:
    """Evaluate one saved report offline. No network or privileged operations."""
    problems: list[str] = []
    clock = now or datetime.now(timezone.utc)
    if clock.tzinfo is None:
        raise ValueError('Current time must be timezone aware')
    clock = clock.astimezone(timezone.utc)
    if not isinstance(report, dict):
        return {'ready': False, 'issues': ['Report must be a JSON object'], 'passed': 0, 'required': len(REQUIRED_CHECKS)}
    if report.get('schema_version') != 1 or type(report.get('schema_version')) is not int:
        problems.append('Unsupported or missing acceptance report schema version (required: 1)')
    timestamp = report.get('generated_at_utc')
    try:
        if not isinstance(timestamp, str):
            raise ValueError('missing timestamp')
        generated = datetime.fromisoformat(timestamp.replace('Z', '+00:00'))
        if generated.tzinfo is None:
            raise ValueError('timezone missing')
        generated = generated.astimezone(timezone.utc)
        age = clock - generated
        if age < -timedelta(minutes=5):
            problems.append('Report generation time is in the future')
        elif age > timedelta(hours=max_age_hours):
            problems.append(f'Report is older than {max_age_hours} hours')
    except (ValueError, OverflowError):
        problems.append('Report must include a valid UTC generation timestamp')
    if not SHA.fullmatch(expected_commit):
        raise ValueError('Expected revision must be a 40-character lowercase Git SHA')
    if report.get('git_commit') != expected_commit:
        problems.append('Report was not generated at the expected Git revision')
    raw = report.get('checks')
    if not isinstance(raw, list):
        raw = []
        problems.append('Missing acceptance check list')
    if not raw:
        problems.append('Acceptance report contains no checks')
    check_names = []
    tally = Counter()
    observed: dict[str, str] = {}
    for item in raw:
        if not isinstance(item, dict) or not isinstance(item.get('name'), str) or not isinstance(item.get('status'), str):
            problems.append('Malformed check entry')
            continue
        name, status = item['name'], item['status']
        check_names.append(name)
        if status not in ('PASS', 'FAIL', 'SKIP'):
            problems.append(f'Invalid check status: {name}')
            continue
        tally[status] += 1
        observed[name] = status
    duplicates = [name for name, count in Counter(check_names).items() if count > 1]
    if duplicates:
        problems.append('Duplicate check entries: ' + ', '.join(sorted(duplicates)))
    summary = report.get('summary')
    if not isinstance(summary, dict) or any(type(summary.get(k)) is not int or summary[k] != tally[k]
                                             for k in ('PASS', 'FAIL', 'SKIP')):
        problems.append('Summary totals do not match individual checks')
    for name in REQUIRED_CHECKS:
        if observed.get(name) != 'PASS':
            problems.append(f'Mandatory check not passed: {name} ({observed.get(name, "MISSING")})')
    if tally['FAIL']:
        problems.append(f'{tally["FAIL"]} acceptance check(s) failed')
    if tally['SKIP']:
        problems.append(f'{tally["SKIP"]} acceptance check(s) skipped')
    return {'ready': not problems, 'issues': problems,
            'passed': sum(observed.get(name) == 'PASS' for name in REQUIRED_CHECKS),
            'required': len(REQUIRED_CHECKS), 'checks': len(raw)}


def tracked_file_audit(paths: list[str]) -> list[str]:
    """Detect accidentally tracked user files; allow intentional placeholders."""
    leaks=[]
    for path in paths:
        p=path.replace('\\','/')
        lower=p.lower()
        if p == '.env.example' or p in ('courses/.gitkeep','data/.gitkeep'):
            continue
        if p == '.env' or lower.endswith(('.sqlite','.sqlite3','.db','.pem','.key','.p12','.pfx')) or \
           lower.startswith(('courses/','data/')) or lower.endswith(('acceptance-report.json','courseforge-acceptance.png')):
            leaks.append(p)
    return sorted(set(leaks))


def git_tracked_files(root: Path) -> list[str]:
    result = subprocess.run(['git','-C',str(root),'ls-files','-z'],capture_output=True,check=True,timeout=20)
    return [p.decode('utf-8') for p in result.stdout.split(b'\0') if p]


def main(argv=None) -> int:
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report',type=Path,help='Private JSON output from scripts/acceptance_live.py')
    parser.add_argument('--expected-commit',help='Exact full Git SHA of the code tested on the device')
    parser.add_argument('--max-age-hours',type=int,default=72)
    parser.add_argument('--audit-tree',action='store_true',help='Also check tracked paths for personal/secret assets')
    parser.add_argument('--repo-root',type=Path,default=Path(__file__).resolve().parents[1])
    args=parser.parse_args(argv)
    if not args.report and not args.audit_tree:
        parser.error('Specify --report, --audit-tree, or both')
    if args.report and not args.expected_commit:
        parser.error('--expected-commit is required for release report evaluation')
    if not 1 <= args.max_age_hours <= 168:
        parser.error('--max-age-hours must be 1–168')
    issues=[]
    if args.audit_tree:
        try:
            leaks=tracked_file_audit(git_tracked_files(args.repo_root))
            issues += [f'Tracked private/unwanted file: {path}' for path in leaks]
            if not leaks:
                print('PASS: no forbidden paths in tracked Git tree')
        except (OSError,subprocess.CalledProcessError,subprocess.TimeoutExpired) as exc:
            issues.append('Could not inspect tracked files: '+type(exc).__name__)
    if args.report:
        try:
            raw=json.loads(args.report.read_text(encoding='utf-8'))
            result=evaluate(raw,expected_commit=args.expected_commit,max_age_hours=args.max_age_hours)
            issues += result['issues']
            print(f'Required acceptance checks: {result["passed"]}/{result["required"]} PASS')
        except (OSError,json.JSONDecodeError,UnicodeError,ValueError) as exc:
            issues.append('Invalid acceptance report: '+type(exc).__name__)
    for item in issues:
        print('BLOCK: '+item)
    print('RELEASE GATE:', 'BLOCKED' if issues else ('ACCEPTANCE READY FOR HUMAN REVIEW' if args.report else 'SOURCE AUDIT PASS'))
    return 1 if issues else 0


if __name__ == '__main__':
    raise SystemExit(main())
