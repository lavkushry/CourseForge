#!/usr/bin/env python3
"""Offline source/current-UI parity inventory; never imports or starts CourseForge.

Only allowlisted source/config/docs paths are read. No database, environment,
provider manifests, images, learner files, network, or running service is accessed.
Extracted values are symbol names, HTTP paths, SQL table names, CSS selectors and
HTML control IDs; arbitrary source literals (including credentials) are not emitted.
"""
from __future__ import annotations
import argparse
import ast
from collections import Counter
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
VERSION = 1
SUFFIXES = {'.py', '.go', '.ts', '.js', '.css', '.html', '.sql', '.sh', '.yaml', '.yml', '.toml', '.conf', '.md'}
SKIP_DIRS = {'node_modules', 'dist', '__pycache__', '.venv', 'venv', 'output', '.git', '.playwright-cli'}
ROOT_FILES = ['AGENTS.md', 'compose.yaml', 'compose.rewrite.yaml', 'watchdog.sh',
              'build_paid_curriculum.py', 'odysee_batch_upload.py', 'sync_paid_course_to_db.py',
              'linux_pipeline.py', 'monitor_status.py', '.github/workflows/tests.yml']
INPUT_DOCS = ['docs/GO_TYPESCRIPT_REWRITE_PLAN.md', 'docs/GO_TYPESCRIPT_CAPACITY.md',
              'docs/GO_TYPESCRIPT_AGENTS.md', 'docs/rewrite/PARITY_CONTRACT.md']
EVIDENCE = ['docs/rewrite/M1_HTTP_BEHAVIOR.json', 'docs/rewrite/M1_HTTP_RESTART.json',
            'docs/rewrite/LEARNING_HTTP_BEHAVIOR.json', 'docs/rewrite/STANDALONE_MEDIA_BEHAVIOR.json',
            'docs/rewrite/browser-evidence/fixture-results.json', 'docs/rewrite/browser-evidence/unit-results.json',
            'docs/rewrite/LEGACY_ROUTE_INVENTORY.json', 'docs/rewrite/MIGRATION_INVENTORY.json',
            'docs/rewrite/PLANNING_STAGING_HTTP.json', 'docs/rewrite/CERTIFICATE_STAGING_HTTP.json',
            'docs/rewrite/PRODUCT_STAGING_HTTP.json', 'docs/rewrite/PATHS_HANDOFF.md',
            'docs/rewrite/ACTIVITY_HANDOFF.md', 'docs/rewrite/JOB_PUBLICATION_HANDOFF.md',
            'docs/rewrite/browser-evidence/ui-player-2026-10-12/manifest.json']


def read(path):
    return (ROOT / path).read_text(errors='replace')


def sha(path):
    return hashlib.sha256((ROOT / path).read_bytes()).hexdigest()


def canon(path):
    return re.sub(r'\{[^}]+\}', '{}', path)


def ref(path, symbol=None):
    content = read(path)
    line = 1
    if symbol:
        match = re.search(r'(?m)^\s*(?:(?:async\s+)?def\s+|(?:export\s+)?(?:async\s+)?function\s+|func\s+(?:\([^\n]*?\)\s+)?|(?:private\s+)?(?:async\s+)?|window\.)' + re.escape(symbol) + r'\b', content)
        if not match:
            match = re.search(re.escape(symbol), content)
        if match:
            line = content.count('\n', 0, match.start()) + 1
    return {'file': path, 'line': line, 'symbol': symbol}


def scan_files():
    paths = set(ROOT_FILES + INPUT_DOCS + EVIDENCE)
    for base in ['app', 'backend', 'web', 'scripts', 'tests', 'docs/rewrite']:
        for p in (ROOT / base).rglob('*'):
            if not p.is_file() or p.suffix not in SUFFIXES or p.name.startswith('._'):
                continue
            if any(part in SKIP_DIRS for part in p.relative_to(ROOT).parts):
                continue
            rel = p.relative_to(ROOT).as_posix()
            if rel in {'scripts/rewrite_feature_inventory.py', 'docs/rewrite/FULL_FEATURE_PARITY.md'}:
                continue
            paths.add(rel)
    records = []
    for path in sorted(paths):
        if not (ROOT / path).is_file():
            continue
        raw = (ROOT / path).read_bytes()
        content = raw.decode(errors='replace')
        record = {'file': path, 'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw),
                  'lines': len(content.splitlines()), 'kind': (ROOT / path).suffix.lstrip('.')}
        if path.endswith('.py'):
            try:
                tree = ast.parse(content)
                record['symbols'] = [{'name': n.name, 'line': n.lineno, 'kind': type(n).__name__}
                                     for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))]
                record['imports'] = sorted({n.module or '' for n in ast.walk(tree) if isinstance(n, ast.ImportFrom)} |
                                           {a.name for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names})
                record['sql_tables'] = sorted({m.group(1).lower() for n in ast.walk(tree)
                    if isinstance(n, ast.Constant) and isinstance(n.value, str)
                    for m in re.finditer(r'(?i)\b(?:FROM|JOIN|INTO|UPDATE|TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?)\s+([A-Za-z_][A-Za-z_0-9]*)', n.value)})
                record['parse_status'] = 'ok'
            except SyntaxError as e:
                record['parse_status'] = 'syntax_error'
                record['parse_error_line'] = e.lineno
        elif path.endswith(('.js', '.ts', '.go')):
            patterns = (r'(?m)^\s*(?:export\s+)?(?:async\s+)?function\s+([\w$]+)',
                        r'(?m)^func\s+(?:\([^\n]*?\)\s+)?(\w+)', r'window\.([\w$]+)\s*=')
            symbols = []
            for pattern in patterns:
                for m in re.finditer(pattern, content):
                    symbols.append({'name': m.group(1), 'line': content.count('\n', 0, m.start()) + 1})
            record['symbols'] = sorted(symbols, key=lambda s: s['line'])
        elif path.endswith('.html'):
            record['ids'] = sorted(set(re.findall(r'\bid=["\']([\w-]+)', content)))
            record['views'] = sorted(set(re.findall(r'data-(?:nav|view)=["\']([\w-]+)', content)))
            record['asset_paths'] = sorted(set(re.findall(r'(?:src|href)=["\'](/static/[^"\']+)', content)))
        elif path.endswith('.css'):
            record['selector_tokens'] = sorted(set(re.findall(r'(?<![\w-])[.#]([A-Za-z_][\w-]*)', content)))
            record['media_query_count'] = len(re.findall(r'@media\b', content))
        elif path.endswith('.sql'):
            record['tables'] = sorted(set(re.findall(r'(?i)CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w]+)', content)))
        records.append(record)
    return records


# Explicit replacement candidates. Renaming a route does not establish semantics.
ALIASES = {
 ('GET', '/'): 'GET /health/live',
 ('GET', '/api/health'): 'GET /health/ready',
 ('GET', '/api/me/bootstrap'): 'GET /api/v1/auth/me',
 ('GET', '/api/me/learning'): 'GET /api/v1/me/learning',
 ('GET', '/api/me/playback'): None,
 ('POST', '/api/videos/{video_id}/native-session'): 'POST /api/v1/playback/sessions',
 ('POST', '/api/videos/{video_id}/player-session'): 'POST /api/v1/playback/sessions',
 ('POST', '/api/player-sessions/{sid}/claim'): 'POST /api/v1/playback/sessions/{id}/claim',
 ('POST', '/api/player-sessions/{sid}/heartbeat'): 'POST /api/v1/playback/sessions/{id}/pulse',
 ('POST', '/api/player/{sid}/events'): 'POST /api/v1/playback/sessions/{id}/pulse',
 ('POST', '/api/activity/{sid}/heartbeat'): 'POST /api/v1/activity/{id}/heartbeat',
 ('POST', '/api/videos/{video_id}/activity-session'): 'POST /api/v1/lessons/{id}/activity-session',
 ('GET', '/api/videos/{video_id}/media/{sid}'): 'GET /api/v1/playback/sessions/{id}/media',
 ('HEAD', '/api/videos/{video_id}/media/{sid}'): 'HEAD /api/v1/playback/sessions/{id}/media',
 ('GET', '/api/videos/{video_id}/stream'): 'GET /api/v1/playback/sessions/{id}/media',
 ('HEAD', '/api/videos/{video_id}/stream'): 'HEAD /api/v1/playback/sessions/{id}/media',
 ('GET', '/api/me/player-preferences'): 'GET /api/v1/player/preferences',
 ('PUT', '/api/me/player-preferences'): 'PUT /api/v1/player/preferences',
 ('DELETE', '/api/notes/{note_id}'): 'DELETE /api/v1/lessons/{id}/notes/{note_id}',
 ('PATCH', '/api/courses/{course_id}'): 'PATCH /api/v1/admin/courses/{id}',
 ('PUT', '/api/admin/courses/{course_id}/publication'): 'PATCH /api/v1/admin/courses/{id}',
 ('GET', '/api/materials/{course}/{filename}'): 'GET /api/v1/materials/{id}/download',
 ('PATCH', '/api/admin/courses/{course_id}/materials/{filename}'): 'PUT /api/v1/admin/materials/{id}',
 ('DELETE', '/api/admin/courses/{course_id}/materials/{filename}'): 'DELETE /api/v1/admin/materials/{id}',
 ('GET', '/api/admin/courses/{course}/quizzes'): 'GET /api/v1/admin/courses/{id}/quizzes',
 ('POST', '/api/admin/videos/{video_id}/quiz/regenerate'): 'POST /api/v1/admin/lessons/{id}/quiz/regenerate',
 ('GET', '/api/streaming/courses/{course_slug_or_id}'): 'GET /api/v1/public/courses/{id}',
 ('GET', '/api/videos'): 'GET /api/v1/courses/{id}',
 ('GET', '/api/tasks/{tid}'): 'GET /api/v1/jobs/{id}',
}
# No comparable Go operation, even if a nearby generic route exists.
MISSING = {'/manifest.json', '/manifest.webmanifest', '/sw.js',
 '/api/artwork/courses/{course_id_or_slug}/backdrop', '/api/artwork/courses/{course_id_or_slug}/poster',
 '/api/artwork/lectures/{video_id}/thumbnail', '/api/chunks/{chunk_id}/frame',
 '/api/admin/courses', '/api/admin/courses/{course_id}/detail', '/api/admin/courses/{course_id}/materials',
 '/api/admin/overview', '/api/admin/playback', '/api/admin/playback/export', '/api/admin/player-activity',
 '/api/admin/player-activity/export', '/api/admin/provider-sync', '/api/admin/system', '/api/admin/teacher-insights',
 '/api/admin/videos/{video_id}/provider', '/api/ask', '/api/syllabus', '/api/syllabus/generate',
 '/api/smart-resume', '/api/reviews/adaptive', '/api/videos/{video_id}/brief', '/api/scan',
 '/api/videos/{video_id}/reindex', '/api/videos/{video_id}/vault-frame', '/api/videos/{video_id}/vault-session',
 '/api/videos/{video_id}/playback-session', '/api/videos/{video_id}/player-capabilities'}

LABELS = {
 'index': 'Serve the existing academy/learner UI shell', 'heartbeat': 'Accept bounded visible lesson activity/ownership heartbeat',
 'learner_bootstrap': 'Bootstrap catalog, learner progress, materials, jobs and learning state together',
 'videos': 'List authorized videos and indexing state', 'get_video': 'Read lesson metadata/chunks and authorized source state',
 'my_learning': 'Summarize enrolled courses, completion, totals and last visited lesson',
 'course_cover': 'Read custom or generated course cover', 'upload_course_cover': 'Upload and validate custom course artwork',
 'remove_course_cover': 'Reset course cover to generated fallback', 'get_course_detail': 'Read streaming title, grouped episodes, progress and related courses',
 'capabilities': 'Negotiate native/embedded playback availability and tracking capabilities',
 'create_playback': 'Create single-use signed embedded playback token', 'playback_frame': 'Consume authorized embedded playback frame',
 'create_native': 'Prepare native source and create lesson/account/login-bound media session',
 'media_bytes': 'Serve authorized native media HEAD/Range/full bytes', 'stream': 'Serve protected local source bytes with HEAD/Range',
 'record_event': 'Record sequenced playing/position/coverage events without duplicate credit',
 'open_player': 'Open lesson native/embedded ownership session', 'claim_player': 'Deliberately claim or take over playback ownership',
 'open_activity': 'Open visible lesson-page activity session and last-visit record',
 'save_progress': 'Write explicit lesson progress/completion separately from watched coverage',
 'resume_point': 'Write private resume position without completion credit',
 'get_home_feed': 'Read featured, continue, ranked, category and new-episode home rows',
 'trending_lectures': 'Rank available lectures from recent scoped activity',
 'get_watch_history': 'Read private watch event history', 'clear_watch_history': 'Clear history with watermark preventing resurrection',
 'get_my_list': 'Read private saved courses/lessons', 'add_to_my_list': 'Save a course or lecture without duplicates',
 'remove_from_my_list': 'Remove a private saved course or lecture',
 'get_streaming_analytics': 'Read bounded administrator streaming event analytics',
 'record_analytics_event': 'Accept allowlisted bounded streaming analytics event metadata',
 'map_provider': 'Assign exact Odysee claim name/id to a lesson',
 'provider_sync': 'Synchronize provider manifest mappings and sanitized health status',
 'cleanup_records': 'Expire detailed account/activity/player logs while retaining aggregate totals',
 'get_admin_teacher_insights': 'Read teacher weak-concept, readiness and learner recommendation insights',
 'complete_review': 'Credit a completed review session without duplicate habit credit',
 'create_review_cards': 'Generate source-backed flashcards through AI task lifecycle',
 'course_certificate': 'Issue certificate only when real course retention requirements pass',
 'verify_certificate_api': 'Publicly verify issued certificate code', 'verify_certificate_page': 'Render shareable certificate verification page',
 'service_worker': 'Serve versioned service worker with private API/media exclusions',
 'manifest': 'Serve installable PWA manifest and icons', 'health': 'Read sanitized application/provider/model/vector/worker health',
}

# Observed semantic differences, independent of whether the route's scoped tests
# pass. A nearby API is not permission to drop these legacy behaviors.
SEMANTIC_GAPS = {
 '/api/health': 'Go readiness only checks PostgreSQL; the legacy sanitized model/vector/provider/worker health summary is absent.',
 '/api/streaming/home-feed': 'Go emits continue/trending/featured only; legacy next-lecture hero metadata, new-episode/category rows, artwork and deep links differ.',
 '/api/streaming/trending': 'Go ranks recent playback_totals; legacy activity/source availability, returned artwork/deep links and ranking semantics need comparison.',
 '/api/streaming/analytics/event': 'Go stores daily aggregate event-name counts and discards learner/event timestamp/metadata; legacy per-event reporting/retention requires an explicit reviewed transform.',
 '/api/admin/streaming-analytics': 'Go returns grouped recent type/name counts; legacy row engagement/search success/failover/up-next reports and retained metadata are incomplete.',
 '/api/materials/{course}/{filename}': 'Go downloads an artifact by ID; legacy material route also fetches authorized provider documents and renders PDF/notebook/PPTX/DOCX/text/table previews.',
 '/api/courses/{course_id}/cover': 'Go cover delivery exists; custom cover upload/reset and generated frame/gradient/artwork selection/caching remain incomplete.',
 '/api/videos/{video_id}': 'Go lesson metadata/materials/progress exists; legacy source chunks/indexing/error/frame metadata projection is incomplete.',
 '/api/videos/{video_id}/quiz': 'Go returns pending until an approved quiz exists; legacy read lazily creates a deterministic quiz. Preserve usable quiz flow or record an explicit reviewed behavioral correction.',
 '/api/reviews/generate': 'Go queue submits lesson-bound review generation; legacy course/global selection and real generation executor are incomplete.',
 '/api/admin/videos/{video_id}/quiz/regenerate': 'Go source-checked queued generation/publisher exists; legacy regeneration adapter and real provider execution remain incomplete.',
 '/api/videos/{video_id}/resume-point': 'Go has a dedicated position-only decoder; regression and staging checks reject completion/percent injection and retain prior completion. Legacy semantic import and full browser parity remain open.',
 '/api/activity/{sid}/heartbeat': 'Independent activity is wired in isolated staging with ordered duplicate suppression and server-bounded credit; native visible diagnostics remain separate. Frontend/admin/import/recovery gates remain open.',
 '/api/videos/{video_id}/activity-session': 'Independent page open and explicit last visit are wired in isolated staging, including optional exact native player binding; opening grants no time. Frontend/fallback/admin/import gates remain open.',
}

GATES = {
 'identity_access': ('Guest, active/verified state, CSRF/origin, invitation/reset single-use/expiry, password/session revocation, role and last-admin boundaries via public HTTP; test two replicas.',
                     'Preserve stable user IDs, normalized-email collision decisions, Argon2 bytes, role/enrollment/history and timestamps; invalidate active auth/account tokens at cutover.'),
 'catalog_discovery': ('Public/private enrollment/publication, ordered page boundaries, stable IDs/slug aliases, unavailable lesson states, safe files/artwork and browser discovery actions.',
                       'Preserve original folder/course/lesson IDs, title/order/flow/material scope/tombstones/source fingerprints/provider IDs; checksum covers/materials/frames and compare clear-history watermarks.'),
 'player': ('Decoded media, seek/resume, native/embedded capabilities, atomic takeover/revoke, stalled source cancellation, Range/206/416/HEAD, duplicate/out-of-order durable pulses and autoplay only after ended.',
            'Preserve independent position/coverage intervals/wall playing/visible activity/preferences/lifetime totals; retain history and invalidate live media/ownership sessions; never replay credit.'),
 'learning_records': ('Two learners exercise create/read/update/history through public interfaces; reject cross-owner/unenrolled access, malformed citations/answers and duplicate credit; prove due/results/order boundaries.',
                      'Preserve private notes/bookmarks/cards/SM-2 schedules/path steps/questions/attempt answers/feedback/citations/scores/timestamps and certificates; resolve missing destinations and historical revision provenance.'),
 'planning_habits': ('Actual API/browser lifecycle with deterministic clock, pause/resume/end/hidden/retry, local day/week/DST, private history and path/lab ownership; keep actual/focus/watch/page time separate.',
                     'Preserve budgets/preferences/timezones/rest days/ordered plans/actual totals/focus intervals/habit dedup keys and day aggregates; pause active timers at freeze without inventing time.'),
 'ai_import': ('Real bounded adapter execution with authorized restored citations; queued/running/done/failed/cancel transitions, kill/retry/expiry fencing and duplicate-safe SQL/artifact/vector publication.',
               'Drain old workers; preserve task/job IDs/kind/payload/checkpoints/results/provenance, transcripts/frames/source fingerprints and versioned vector points; restore retrieval before accepting cutover.'),
 'labs': ('Curated isolated runner workflow, owner denial, workspace traversal/symlink protections, timeout/cancel/resource limits, worker death/fencing and repeat-safe verified practice credit.',
          'Preserve owner/session/curated slug/path-step bindings/files/results/check counts/timestamps in SQL plus checksummed allowlisted owned workspaces; never rerun historical submissions.'),
 'administration': ('Deny students for every admin action/report; last-admin/revoke across replicas, paginated filters/export CSV injection protections, bounded upload/export and secret-redacted audit.',
                    'Preserve audit/access/learning history and independently retained aggregates, provider/source mappings/publication, role/enrollment changes and deletion/retention policy; restore artifact references.'),
 'delivery_operations': ('Desktop/mobile/browser UI, accessible navigation/focus, cache refresh/private exclusions, readiness/shutdown/drain, release/backup and complete post-write recovery rehearsal.',
                         'Preserve source/bundle/artifact manifests; rebuild FTS and versioned vectors under one-writer freeze/drain/import/verify; measure maintenance window and demonstrate post-write replay/fix-forward.'),
}

UI_MODULES = {
 'identity_access': ['app/static/academy.js'], 'catalog_discovery': ['app/static/academy.js', 'app/static/app.js', 'app/static/streaming-home.js', 'app/static/streaming-browse.js', 'app/static/streaming-title.js', 'app/static/streaming-search.js'],
 'player': ['app/static/native-player.js', 'app/static/player-session.js', 'app/static/player-tracking.js', 'app/static/player-studio.js', 'app/static/player-recovery.js'],
 'learning_records': ['app/static/app.js', 'app/static/learning-paths.js', 'app/static/assessments.js', 'app/static/practice.js'],
 'planning_habits': ['app/static/planner.js', 'app/static/weekly.js', 'app/static/focus.js', 'app/static/habits.js', 'app/static/app.js'],
 'ai_import': ['app/static/app.js', 'app/static/services.js'], 'labs': ['app/static/app.js', 'app/static/practice.js'],
 'administration': ['app/static/academy.js', 'app/static/app.js'], 'delivery_operations': ['app/static/index.html', 'app/static/loaders.js', 'app/static/sw.js', 'app/static/mobile.js'],
}


def route_declarations(records):
    result = []
    for record in records:
        path = record['file']
        if not path.startswith('backend/') or not path.endswith('.go') or path.endswith('_test.go'):
            continue
        for match in re.finditer(r'"((?:GET|HEAD|POST|PUT|PATCH|DELETE) /[^"\n]+)"', read(path)):
            result.append({'route': match.group(1), 'file': path, 'line': read(path).count('\n', 0, match.start()) + 1,
                           'wiring': 'registered in cmd/api; scoped staging handoff documented' if any('/'+module+'/' in path for module in ('planning','certificates','paths','activity')) else
                                     'private diagnostics listener' if '/observe/' in path else
                                     'simulator only' if '/mediasim/' in path else 'application/gateway declaration'})
    return result


def api_rows(legacy, declarations):
    declared = {a['route'].split(' ', 1)[0] + ' ' + canon(a['route'].split(' ', 1)[1]): a for a in declarations}
    rows = []
    for i, route in enumerate(legacy['routes'], 1):
        method, path, feature = route['method'], route['path'], route['feature']
        if path.startswith(('/api/planner', '/api/focus', '/api/me/habit')) or path == '/api/studio/insights':
            feature = 'planning_habits'
        candidate = ALIASES.get((method, path), method + ' ' + path.replace('/api/', '/api/v1/', 1).replace('/videos/', '/lessons/'))
        if path in MISSING or path.startswith(('/api/lab-sessions', '/api/labs', '/api/interview-prep')) or '/placement-test' in path:
            candidate = None
        if method == 'POST' and path == '/api/admin/users':
            candidate = None
        if '/cover' in path and method in {'PUT', 'DELETE'}:
            candidate = None
        replacement = declared.get(candidate.split(' ', 1)[0] + ' ' + canon(candidate.split(' ', 1)[1])) if candidate else None
        # Shell delivery is a web artifact, never equivalent to health.
        if path == '/':
            replacement = None
        backend_status = 'missing'
        evidence = []
        limitation = 'No comparable Go operation found in registered source.'
        if replacement:
            backend_status = 'unverified'
            limitation = 'Source operation exists; per-operation legacy/new semantic equivalence remains unverified.'
            if feature == 'planning_habits':
                backend_status = 'partial'
                evidence = ['docs/rewrite/PLANNING_STAGING_HTTP.json', 'docs/rewrite/PLANNING_CONTRACT.md']
                limitation = 'Planning is wired in isolated staging;15 PostgreSQL/race tests and31 HTTP checks pass, plus integrated path-adapter smoke. TS UI, cross-course paths/labs, reminder/admin/migration/restart gates remain open.'
            elif path.startswith('/api/certificates/') or path.endswith('/certificate') or path == '/verify/{code}':
                backend_status = 'partial'
                evidence = ['docs/rewrite/CERTIFICATE_HANDOFF.md', 'docs/rewrite/CERTIFICATE_STAGING_HTTP.json']
                limitation = 'Certificate readiness, explicit CSRF/idempotent POST issuance and public JSON/printable HTML are wired in staging;10 PG/race tests and20 smoke checks pass. Legacy GET issuance becomes explicit POST; TS issuance/import/recovery parity remains open.'
            elif path.startswith(('/api/learning-paths', '/api/assessments')):
                backend_status = 'partial'
                evidence = ['docs/rewrite/PATHS_HANDOFF.md', 'docs/rewrite/PRODUCT_STAGING_HTTP.json']
                limitation = 'Paths/assessments are wired in isolated staging;22 PG/race tests and integrated42-check product smoke pass. Safe job references and immutable retries are integrated; real generation, full UI/practice and semantic migration remain open.'
            elif path.startswith('/api/activity/') or path.endswith('/activity-session') or path=='/api/me/learning':
                backend_status = 'partial'
                evidence = ['docs/rewrite/ACTIVITY_HANDOFF.md', 'docs/rewrite/PRODUCT_STAGING_HTTP.json']
                limitation = 'Standalone page activity and private separate time summary are wired;16 PG/race tests and integrated42-check product smoke pass. Frontend/admin/retention/import/recovery/capacity gates remain open.'
            elif feature in {'identity_access', 'catalog_discovery'} or path in {'/api/progress', '/api/videos/{video_id}/progress', '/api/videos/{video_id}/notes', '/api/notes/{note_id}'}:
                backend_status = 'implemented'
                evidence = ['docs/rewrite/M1_HTTP_BEHAVIOR.json']
                limitation = 'Implemented scoped Go slice with prior HTTP evidence; complete operation-level response, legacy UI and migration parity remain open.'
            elif path.startswith('/api/reviews/') or path.endswith(('/bookmarks', '/quiz', '/quiz/attempts', '/quizzes/status')) or '/quizzes/' in path or path.startswith('/api/bookmarks/'):
                backend_status = 'implemented'
                evidence = ['docs/rewrite/LEARNING_HTTP_BEHAVIOR.json']
                limitation = 'Scoped public learning behavior evidence exists; generation adapter, legacy UI and historical migration are separate open gates.'
            elif feature == 'player':
                backend_status = 'partial'
                evidence = ['docs/rewrite/STANDALONE_MEDIA_BEHAVIOR.json', 'docs/rewrite/UI_PLAYER_CONTRACT.md']
                limitation = 'Native gateway/ownership foundation exists; embedded fallback, independent page-activity/session/report and full recovery/device parity are not established.'
            if path in {'/api/me/bootstrap', '/api/videos', '/api/streaming/courses/{course_slug_or_id}', '/api/tasks/{tid}', '/api/jobs'} or '/artwork/' in path:
                backend_status = 'partial'
                limitation = 'Candidate replacement only supplies part of the legacy aggregate/shape/selection/lifecycle; compatibility and semantic migration need explicit implementation.'
            if path in SEMANTIC_GAPS:
                backend_status = 'partial'
                limitation = SEMANTIC_GAPS[path]
        web_status = 'missing'
        web_refs = []
        web_note = 'No TypeScript panel/client action for this operation.'
        if path == '/':
            web_status = 'partial'; web_refs = [ref('web/src/main.ts', 'renderApp')]
            web_note = 'New discovery/classroom shell exists; many legacy panels and navigation/appearance behaviors are absent.'
        if path in {'/api/auth/login', '/api/auth/logout', '/api/me', '/api/public/courses', '/api/public/courses/{course_id}', '/api/courses/{course_id}/enroll', '/api/courses', '/api/courses/{course_id}/cover', '/api/streaming/my-list', '/api/streaming/my-list/{item_type}/{item_id}', '/api/streaming/continue-watching', '/api/videos/{video_id}', '/api/progress', '/api/videos/{video_id}/progress', '/api/videos/{video_id}/notes', '/api/notes/{note_id}', '/api/me/player-preferences'} and (path != '/api/me' or method == 'GET'):
            web_status = 'partial'; web_refs = [ref('web/src/api.ts'), ref('web/src/main.ts')]
            web_note = 'TypeScript action exists; current source shape/visual/edge parity still needs operation-specific browser comparison.'
        if feature == 'player' and replacement:
            web_status = 'partial'; web_refs = [ref('web/src/player/controller.ts'), ref('web/src/api.ts')]
            web_note = 'Native typed player/recovery has scoped browser handoff; complete legacy embedded capability/report/activity semantics, real devices and provider/capacity gates remain open.'
        if '/cover' in path and method in {'PUT', 'DELETE'}:
            web_status = 'missing'; web_refs = []; web_note = 'TypeScript has no artwork upload/reset controls.'
        status = 'missing' if backend_status == 'missing' and web_status == 'missing' else 'partial'
        old_ref = {'file': route['source'], 'line': route['line'], 'symbol': route['handler']}
        tree = ast.parse(read(route['source']))
        handler = next(n for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == route['handler'])
        def qualified_symbol(node):
            if isinstance(node, ast.Name):
                return node.id
            if isinstance(node, ast.Attribute):
                base = qualified_symbol(node.value)
                return base + '.' + node.attr if base else None
            return None
        calls = sorted({name for n in ast.walk(handler) if isinstance(n, ast.Call) and (name := qualified_symbol(n.func))})
        operation = LABELS.get(route['handler'], route['handler'].replace('_', ' ').capitalize())
        specific = operation + ': compare actual request fields, result/error shape, side effects and lifecycle against the legacy fixture; route existence alone is insufficient.'
        ui_refs = [ref(p) for p in UI_MODULES[feature]]
        rows.append({'id': f'API-{i:03}', 'kind': 'http_operation', 'feature': feature, 'operation': operation,
                     'legacy_route': method + ' ' + path, 'legacy_refs': [old_ref], 'legacy_called_symbols': calls,
                     'legacy_ui_refs': ui_refs, 'go_status': backend_status, 'go_replacement': replacement,
                     'go_limitation': limitation, 'web_status': web_status, 'web_refs': web_refs, 'web_limitation': web_note,
                     'status': status, 'evidence_refs': evidence, 'behavior_gate': GATES[feature][0] + ' ' + specific,
                     'migration_gate': GATES[feature][1], 'gate_status': 'pending',
                     'owner': route['owner'], 'legacy_candidate_tests': route['legacy_candidate_tests']})
    return rows


# Each entry names an observable operation, not just a module/category. A source
# function is only a locator; candidate tests and evidence are not a new test run.
# Format: feature | operation | legacy file | symbol | web locator or - | detail
UI_DATA = r'''
identity_access|Published guest course catalog and syllabus preview|academy.js|catalog|discovery/view.ts|TypeScript bootstrap requires sign-in; guest discovery/signup entry behavior needs restoration.
identity_access|Login and explicit sign-out|academy.js|signIn|main.ts|Existing browser login/logout is scoped; test stale login/CSRF and post-logout privacy.
identity_access|Registration mode, name/email/password and verification guidance|academy.js|signIn|-|Go account endpoints exist but create-account screen is absent.
identity_access|Forgot password and resend verification with email availability guidance|academy.js|signIn|-|Recovery/resend form and disabled-mail/invitation guidance are absent.
identity_access|Activation, verification and reset token URL handling|academy.js|boot|-|Token deep-link forms are absent; single-use expiry and neutral errors must remain.
identity_access|Profile name and current/new password editing|academy.js|myAccount|-|Account settings panel is absent despite Go lifecycle endpoints.
identity_access|List signed-in devices and revoke other sessions|academy.js|myAccount|-|Device/session management panel is absent.
identity_access|Private watched-time and saved-position account history|academy.js|myAccount|-|Private playback account report API and panel are absent.
identity_access|Password-confirmed account deletion and browser reset|academy.js|myAccount|-|Deletion flow and retention wording are absent.
identity_access|Verified-account guard before entering enrolled workspace|academy.js|workspace|main.ts|Compare unverified/suspended, enroll/published scope and session-expired return behavior.
catalog_discovery|Home featured billboard, slide controls and hover/focus timer pause|streaming-home.js|initStreamingBillboard|discovery/view.ts|New hero exists; multiple-slide/dots/pause behavior is absent.
catalog_discovery|Continue learning selects saved position and recent/next lesson|app.js|nextUpLesson|main.ts|Preserve last visit versus progress selection and lesson availability.
catalog_discovery|Ranked top lectures and new episode discovery rows|streaming-home.js|renderStreamingRows|discovery/view.ts|New discovery does not consume legacy home-feed/trending/new-episode interfaces.
catalog_discovery|Saved list add/remove for courses and individual lessons|streaming-browse.js|renderMyListView|discovery/view.ts|Course saving exists; individual lesson save UI and legacy list metadata require parity.
catalog_discovery|Watch-history view, saved positions and clear confirmation|streaming-browse.js|renderHistoryView|-|Go history APIs exist; TypeScript history screen/clear controls are absent.
catalog_discovery|Browse category pills, sort, progress and indexed/available filters|streaming-browse.js|syncCategoryPills|discovery/view.ts|Category discovery exists; legacy status/progress/filter/sort combinations need comparison.
catalog_discovery|Course-card hover/preview and title modal opening|streaming-browse.js|attachHoverPreview|discovery/view.ts|New course cards/open flow exists; hover preview/modal parity is open.
catalog_discovery|Title modal season/section selection, episodes, related and details tabs|streaming-title.js|renderTitleContent|main.ts|New classroom section list exists; title-modal tabs/related content are absent.
catalog_discovery|Title modal deep-link routing, close focus and play/enroll/saved actions|streaming-title.js|wireTitleEventHandlers|main.ts|Original hash/close-focus semantics and modal actions need preservation.
catalog_discovery|Search suggestions, recent-search deletion and keyboard selection|streaming-search.js|setupSearchListeners|-|TypeScript course query exists; recent searches/typeahead/keyboard suggestion flow is absent.
catalog_discovery|Universal course/lesson/material/source search with timestamp links|app.js|renderUniversalSearch|-|Go search exists; TypeScript discovery searches course titles only.
catalog_discovery|Course list metadata, source indexing/error status and empty scan states|app.js|renderCatalog|discovery/view.ts|New discovery lacks importer/indexing-status presentation.
catalog_discovery|Combined ordered lesson/material flow with section headers|app.js|getCourseFlow|main.ts|TypeScript section lesson list and downloads exist; interleaved material flow is absent.
catalog_discovery|Inline PDF/document/code material preview and lesson drawer resources|app.js|previewMaterialInline|main.ts|TypeScript download links exist; inline preview/flow integration is absent.
catalog_discovery|Private resources dialog and course/lesson-scoped material filtering|academy.js|materials|main.ts|Downloads exist; dialog/focus/filter/scope behaviors need comparison.
catalog_discovery|Admin course metadata editor and cover upload/reset|app.js|openCourseEditor|-|Metadata update API exists; cover mutations and editor controls are absent.
player|Native playback preparation and loading/unavailable/error presentation|app.js|openVideo|player/controller.ts|Native foundation exists; source-recovery owner is still completing handoff.
player|Embedded fallback, capability-specific seeking and honest tracking warnings|app.js|openVideo|-|TypeScript only builds native video; embedded signed-frame mode/capability UI absent.
player|Resume prompt, restart and persisted speed/volume/mute/theater|player-studio.js|resumePrompt|main.ts|Controls exist; compare original resume prompt and per-account preference semantics.
player|Play/pause, seekbar, skip, keyboard seeking and volume controls|native-player.js|open|main.ts|Exercise actual media and ignored input/modifier keys; all engines/device proof remains open.
player|Touch double-tap seeking and accidental-control lock/unlock|native-player.js|open|main.ts|Touch controls exist; real-device behavior remains unverified.
player|Fullscreen native fallback and theater mode layout|player-studio.js|toggleTheater|main.ts|Browser viewport evidence is scoped; real device fullscreen/safe areas remain open.
player|Captions and native controls fallback when browser capabilities differ|native-player.js|open|main.ts|Native video controls exist; caption track delivery/toggling needs explicit source-backed validation.
player|User watermark, episode drawer focus and close restoration|native-player.js|open|main.ts|Controls exist; inspect focus trap/close restoration, watermark and small-screen parity.
player|Timestamp capture into private note and source-linked seek|player-studio.js|capture|main.ts|Notes/capture exist; drawer/tab association and persisted timestamp behavior need comparison.
player|Previous and next available lesson including materials between episodes|player-studio.js|adjacent|main.ts|Next lesson exists; previous action and combined lesson/material navigation are absent.
player|Autoplay preference, ended-only countdown and cancel|player-studio.js|ended|player/navigation.ts|Intentional correction: do not preserve legacy early near-end advance bug; confirm disabled autoplay never navigates.
player|Multiple tabs, deliberate move-here and ownership-loss overlay|player-session.js|CourseForgePlayerSession|player/ownership.ts|Durable ownership exists; prove no hidden/offline/reconnect automatic takeover.
player|Hidden/offline/page-exit pause, release and deliberate resume|native-player.js|suspend|player/controller.ts|Lifecycle exists; do not confuse visible page activity with playback credit.
player|Retry/backoff after stall/provider failure and fresh authorized source session|player-recovery.js|CourseForgePlayerRecovery|player/recovery.ts|Recovery handoff records35fault,37unit and25 unique real-Go passing checks; full provider/device/capacity/restart parity remains open.
player|Durable bounded retry queue and sequenced progress acknowledgment|player-tracking.js|CourseForgePlaybackDelivery|player/delivery.ts|Foundation exists; kill/restart/reorder/queue exhaustion/terminal denial must stay explicit.
learning_records|Explicit completion action and completed lesson presentation|app.js|openVideo|main.ts|Go/TS explicit completion exists; do not derive it solely from coverage.
learning_records|Timestamp notes list/create/delete and seek-to-note|app.js|loadNotes|main.ts|Go/TS slice exists; compare source text bounds, deletion ownership and pagination.
learning_records|Bookmark label, timestamp parsing, add/list/delete and seek|academy.js|loadBookmarks|-|Go bookmarks exist; TypeScript bookmark controls are absent.
learning_records|Lesson quiz answer, result, explanation, retry and course quiz status|app.js|renderLessonQuiz|-|Go quiz APIs exist; lesson quiz panel is absent.
learning_records|Recall/review reveal, self-grade and due queue|app.js|showReview|-|Go review APIs exist; flashcard/reveal/grade screen is absent.
learning_records|Adaptive review tags, weak areas, historical grades and source links|app.js|loadDue|-|Basic Go reviews are not adaptive-review/companion parity.
learning_records|Review session completion, card generation and duplicate-safe habit credit|app.js|showReview|-|Review endpoints exist; generation adapter and UI are incomplete.
learning_records|Source-backed learning path creation across selected courses/goals|learning-paths.js|loadLearningPaths|-|Go path core is wired with22PG/race and integrated product HTTP checks; real generation and TypeScript path panel remain absent.
learning_records|Path DAG prerequisite ordering, source seek, completion and outdated marker|learning-paths.js|showLearningPath|-|Preserve source fingerprints/prerequisites and explicit private step completions.
learning_records|Topic assessment generation, MCQ submission/results and source review|assessments.js|begin|-|Go topic assessment core is wired with22PG/race and safe job-status references; real generation and TypeScript assessment dialog remain absent.
learning_records|Path mastery and private topic attempt history|assessments.js|statusLabel|-|Go immutable attempts/private history/distinct mastery exist with scoped tests; TypeScript view, real generation and semantic import remain open.
learning_records|Adaptive practice recommendations with reason and linked lab launch|practice.js|load|-|Recommendations/linked launch model/API/panel absent.
learning_records|Practice history verified grade, checks and path-step completion|practice.js|load|-|Historical results and repeat-safe verified completion absent.
learning_records|Certificate readiness/completion celebration and public verification link|app.js|showCourseCompletion|-|Go issuance/verification is wired and tested; TypeScript completion/certificate issuance flow absent.
planning_habits|Daily budget/path preference and selected-day plan generation/refresh|planner.js|init|-|Planning is wired in isolated staging with15PG/race and31HTTP checks; full migration/recovery and TypeScript planner remain open.
planning_habits|Daily item done/skip/start lesson/review/lab and focus action|planner.js|render|-|Path adapter is integrated with first-course limitation; lab adapter and full operation-specific UI remain open.
planning_habits|Daily actual minutes edit separately from planned/focus time|planner.js|render|-|Preserve reported actual time, not inferred timer credit.
planning_habits|Weekly weekday budgets, rest days and week navigation|weekly.js|controls|-|007 source exists; TypeScript weekly calendar absent.
planning_habits|Weekly forecast/review distribution and generate/refresh|weekly.js|render|-|Preserve due forecast/backlog and selected private path semantics.
planning_habits|Focus/break start, pause/resume/finish/cancel and remaining countdown|focus.js|begin|-|Focus is registered with scoped tests reported passed; staged runtime/restart and UI handoff pending.
planning_habits|Focus active-session restore, hidden pause and history/weekly analytics|focus.js|reload|-|Preserve elapsed wall-time intervals; do not add paused/hidden time.
planning_habits|Studio recall/mastery/weak-area/activity charts and analytics|app.js|loadInsights|-|Go planning insights source pending; existing dashboard panels absent.
planning_habits|Habit daily goal, timezone/reminder opt-in and streak/day summary|app.js|loadInsights|-|Current core includes persisted habit controls; separate dirty habits.js reachability still needs verification.
planning_habits|Goal celebration, weekly recap and continue-learning momentum|app.js|updateWeeklyRecap|-|Dashboard habit/recap UI absent; local-only goal preference must migrate explicitly.
planning_habits|Notifications for due reviews and learning activity|app.js|closeNotify|-|Notification popover and review routing absent.
ai_import|Library scan action, indexing queue progress and failure retry|app.js|scanLibrary|-|Durable Go queue is not import-scan/indexer adapter or UI parity.
ai_import|Tutor course/video/time scope and explanation/quiz/outline/answer modes|app.js|askTutor|-|Tutor endpoint/adapter and TypeScript screen absent.
ai_import|Tutor cited lesson/time/frame sources and jump-to-source|app.js|renderTutorAnswer|-|Restored authorized retrieval and citations need semantic/artifact proof.
ai_import|Tutor confidence/needs-practice feedback stored per learner device|app.js|recordConceptSignal|-|Local concept-feedback feature absent; preserve private storage ownership.
ai_import|Build/refetch syllabus topics/objectives/deduplicated source references|app.js|loadSyllabus|-|Syllabus model/adapter/API and TypeScript screen absent.
ai_import|Lesson brief bullets/prerequisites/outcome and cited source jump|app.js|renderLessonBrief|-|Companion brief model/API/panel absent.
ai_import|Smart resume since-last-time banner|streaming-home.js|loadStreamingHome|-|Smart-resume model/API/banner absent.
ai_import|Interview topic selection, question/answer/evaluation/readiness feedback|app.js|interviewPrepModeBtn|-|Interview controls and dialogs exist in index/core; Go/TS replacements absent, runtime browser verification pending.
ai_import|Placement diagnostic answer/evaluation/recommended first lesson|app.js|openPlacementBtn|-|Placement controls and dialogs exist in index/core; Go/TS replacements absent, runtime browser verification pending.
labs|Curated track catalog, category selection and lab start|app.js|paintLabCatalog|-|Lab model/runner/API and TypeScript lab screen absent.
labs|Private lab workspace load/edit/save and submission|app.js|activateLabSession|-|Owner-bound session files/results and resource constraints absent.
labs|Lab grade/check feedback, timeout/live-kind option and retry|app.js|saveLab|-|Actual sandbox/curated grader and linked verified practice credit absent.
administration|Overview totals, recent activity, engagement/return/retention metrics|academy.js|adminHome|-|Overview/engagement model/API and TS admin dashboard absent.
administration|Search/paginate students and inspect private student detail|academy.js|adminUsers|-|Go identity user list/detail exists; full progress/playback/learning detail and TS UI absent.
administration|Create/invite student, show-once activation/recovery link and copy|academy.js|adminHome|-|Go invitation/link exists; direct create-user behavior and TS panel absent.
administration|Suspend/reactivate, revoke sessions, change role and enrollment|academy.js|adminStudent|-|Scoped Go controls exist; TS admin actions and complete private detail absent.
administration|Course publication, source provider mapping and sync status|academy.js|adminCourses|-|Go publication patch exists; provider map/sync and TS editor absent.
administration|Course organization drag/order/section and mixed lesson/material flow|academy.js|adminCourseDetail|-|Go organization exists; TS organization UI and exact mixed flow migration open.
administration|Upload/replace material with progress, assignment/type/order edit and delete|academy.js|uploadMaterialRequest|-|Go metadata update/delete exists; upload/replace artifact lifecycle and TS UI absent.
administration|Quiz curation/edit/regenerate and teacher weak-concept/readiness report|academy.js|adminCourseDetail|-|Go quiz curation exists; teacher insight API and all TS panels absent.
administration|Player activity filters, pagination and spreadsheet-safe CSV export|academy.js|adminPlayer|-|Player/activity/report/export backend and TS panels absent.
administration|Provider/system/worker checks, access logs and sanitized audit history|academy.js|adminSystem|-|System/provider/audit reports and TS panel absent.
delivery_operations|Hash/deep-link lesson timestamp/tab navigation and browser back|app.js|readLessonRoute|main.ts|TS internal navigation exists; legacy URLs/tab/hash/back behavior not preserved.
delivery_operations|Responsive sidebar drawer, scrim, keyboard focus and mobile nav|app.js|openMobileMenu|main.ts|New responsive discovery/episode drawer exists; full legacy workspace navigation absent.
delivery_operations|Appearance light/dark/system mode and accent persistence|app.js|applyTheme|-|TS styling is fixed; appearance preferences and settings popover absent.
delivery_operations|Account avatar dropdown and notification/theme escape/outside close|streaming-home.js|initAvatarDropdown|main.ts|TS logout exists; account/admin/catalog dropdown and settings popovers absent.
delivery_operations|Settings daily-goal selection, shortcut reference and private local state|app.js|syncGoal|-|Settings screen/shortcuts documentation/local goal preference absent.
delivery_operations|Mobile visual viewport keyboard, sticky controls and reduced motion|mobile.js|keyboard|style.css|Compare live layouts at representative sizes; real phones/browser playback remain unverified.
delivery_operations|Lazy study-tool CSS/JS loading, failure message and retry|loaders.js|CourseForgeLoadTools|-|Go TS build has no equivalent study tools; current bundle/source reachability must be preserved.
delivery_operations|Pinned Media Chrome lazy load and native-control fallback|loaders.js|CourseForgeLoadPlayer|main.ts|TS uses native video controls; explicit compatibility/keyboard/caption parity required.
delivery_operations|PWA install/offline shell, cache rotation and API/media exclusions|sw.js|-|-|No rewrite service worker/manifest/install flow; old service worker stale client handling remains gate.
delivery_operations|Reusable controls/layout tokens and skeleton/empty/error states|components.js|-|style.css|Current dirty component/layout assets may be unloaded; source presence is not visible runtime proof.
'''

WORKER_DATA = r'''
ai_import|Filesystem course scan reconciles changed/deleted videos and materials|app/library.py|scan_courses|backend/internal/jobs/jobs.go|missing|Preserve relative-path IDs, size/mtime fingerprints, removed material tombstones and queue invalidation.
ai_import|Video duration/probe and fingerprint-validated Whisper transcription cache|app/extractor.py|transcribe|backend/internal/jobs/executor.go|missing|No bounded Python executor service for this Go-owned job is implemented.
ai_import|DHash slide extraction, OCR and time-linked frame artifacts|app/extractor.py|extract_frames|backend/internal/jobs/executor.go|missing|Preserve visual-only frames and citations even where OCR text is empty.
ai_import|Vision caption enrichment and model failure fallback|app/vision.py|enrich_frames|backend/internal/jobs/executor.go|missing|Preserve per-frame provenance and bounded model timeouts without losing source links.
ai_import|Stable transcript chunk IDs and source time boundaries|app/chunking.py|transcript_chunks|backend/internal/jobs/executor.go|missing|Adapter needs deterministic chunk IDs and original start/end semantics.
ai_import|Embedding batches, Qdrant collection and stable point publication/deletion|app/vectorstore.py|index_video|backend/internal/jobs/executor.go|missing|Go queue does not implement embedding/Qdrant or versioned rebuild.
ai_import|Authorized semantic/keyword retrieval and mode-specific tutor prompt|app/tutor.py|retrieve|backend/internal/jobs/executor.go|missing|Course context and source citations require restored real adapter execution.
ai_import|Syllabus topic clustering, duplicate collapse and source fingerprint invalidation|app/syllabus.py|generate|backend/internal/jobs/executor.go|missing|Generation/get/persistence absent; never regenerate historic content in import.
ai_import|Source-backed review-card generation and fenced publication|app/reviews.py|generate_cards|backend/internal/learning/generation.go|partial|Queue/quiz-review publisher exists; real generation executor and retrieved-citation evidence remain absent.
ai_import|Path generation, source topic/DAG validation and private completions|app/learning_paths.py|generate|backend/internal/jobs/executor.go|missing|Generic jobs cannot supply missing path tables/product adapters.
ai_import|Assessment question validation, source fingerprint and attempts/mastery|app/assessments.py|create|backend/internal/jobs/executor.go|missing|Product adapter/model/API missing.
ai_import|Durable task submit/status and authorized academy dispatch|app/tasks.py|enqueue|backend/internal/jobs/jobs.go|partial|Go lease/queue exists; legacy kinds/global/course scope/results need mapping.
ai_import|Academy worker account/enrollment revalidation and task failure reporting|app/academy_worker.py|process_one|backend/cmd/worker/main.go|partial|Foundation fences publication; complete legacy task kinds and Python adapter absent.
ai_import|Index worker stage progress, interrupted recovery and source replacement checks|app/worker.py|process|backend/cmd/worker/main.go|partial|No index executor; migrated indexing IDs/stages/checkpoints and partial external effects unproven.
ai_import|Single-worker kernel/process lock and independent resource budgets|app/academy_worker.py|main|backend/internal/jobs/jobs.go|partial|Go resource slots/leases are foundation; measure model/transcription/lab budgets separately.
ai_import|Job kill/retry/lease renewal, outbox and stale-result fencing|app/worker.py|main|backend/internal/jobs/executor.go|partial|Scoped tests exist; worker-process fault/restart and external artifact/vector idempotency remain open.
ai_import|Companion brief, smart resume, adaptive review and interview/placement scoring|app/companion.py|get_smart_resume|backend/internal/jobs/executor.go|missing|All product-specific storage and adapters absent.
labs|Curated lab/track metadata and safe owned workspace materialization|app/labs.py|start_lab|backend/internal/jobs/executor.go|missing|No Go lab service or bounded Python lab executor implemented.
labs|Python/shell/Kubernetes graders and isolated Docker resource constraints|app/lab_graders/grade.py|main|backend/internal/jobs/executor.go|missing|Prove real bounded isolated execution, cancellation and no host credential mounting.
labs|SQL/Docker/Ansible/backend/PySpark track graders|app/lab_graders/tracks.py|sql_lab|backend/internal/jobs/executor.go|missing|Preserve curated checks and private output; fake JSON queue result is insufficient.
labs|Offline grading/live-kind option and verified adaptive-practice publication|app/labs.py|submit_lab|backend/internal/jobs/executor.go|missing|No runner/path-practice linkage and repeat-safe verified credit.
labs|Curated multi-track task/source/starter/check catalog|app/lab_tracks.py|-|backend/internal/jobs/executor.go|missing|Preserve original track slugs, starter filenames and declared exercise/check expectations.
learning_records|Deterministic weak-topic scoring and compatible lab recommendation reasons|app/practice.py|recommend|backend/internal/jobs/executor.go|missing|Curated topic matching, latest assessment/result signals and transparent recommendation reasons absent.
learning_records|Verified practice grading append-only history and path-step outcome aggregation|app/practice.py|record_verified_grade|backend/internal/jobs/executor.go|missing|Preserve private history and latest verified checks; do not infer mastery or completion from launch.
planning_habits|Daily/weekly planner candidate scoring, dedup and due-review forecast|app/planner.py|generate|backend/internal/planning/plans.go|partial|007 is staged with15PG/race+31HTTP checks; Paths adapter is integrated with first-course limitation; Labs, real reminders, semantic migration and full UI remain open.
planning_habits|Weekly Monday normalization, weekday budgets, forecast and unscheduled reviews|app/weekly.py|build|backend/internal/planning/weeks.go|partial|Scoped staged preferences/week forecast checks pass; TypeScript calendar/backlog, semantic migration and recovery remain open.
planning_habits|Private recall dashboard due count, self-grade mastery signal and weak/history plots|app/studio.py|insights|backend/internal/planning/insights.go|partial|Scoped staged insights/habits reads pass; TypeScript dashboard, historical migration and full recall semantics remain open.
planning_habits|Focus interval reconciliation, pause lifecycle and active-session recovery|app/focus.py|_reconcile|backend/internal/planning/focus.go|partial|Focus is staged with public clock/pause/revision checks; full browser/history/import/crash recovery remains open.
planning_habits|Habit action/day dedup, timezone goals and reminder dispatch|app/habits.py|send_reminders|backend/internal/planning/habits.go|partial|007 habits are staged with scoped timezone/day tests; actual reminder dispatch/mail, UI and semantic import remain open.
planning_habits|Engagement cohort seven-day return, active learners and retention metrics|app/engagement.py|report|backend/internal/planning/insights.go|missing|Studio learner insights are not administrator cohort metrics.
learning_records|SM-2 grade schedule and historical recall/quiz/review credit|app/study.py|sm2|backend/internal/learning/reviews.go|partial|Scoped Go public tests exist; historic missing revision/link data needs conservative import.
learning_records|Quiz generation/pass thresholds and certificate eligibility|app/retention.py|check_or_issue_certificate|backend/internal/certificates/service.go|partial|Quiz and certificate eligibility/immutable issuance/public verification are tested scoped slices; real generation, TypeScript issuance and semantic import remain open.
player|Server-side Odysee SDK authentication/preparation/resolution and restricted source URLs|app/native_player.py|source_for|backend/internal/media/odysee.go|partial|Native adapter/sample exists; embedded/multi-account and full legacy provider behavior not proven.
player|Native gateway admission, approved redirects and stream revalidation|app/native_player.py|media_bytes|backend/internal/media/gateway.go|partial|Scoped simulator/range checks exist; live full decoded/device/capacity evidence remains open.
player|Embedded signing, consumed frame token and native/embedded fallback|app/media.py|signed_embed|backend/internal/media/odysee.go|missing|Go adapter supports native resolution; signed-frame fallback absent.
player|Native lifetime coverage/playing aggregation and private/admin exports|app/native_player.py|playback_totals|backend/internal/playback/accounting.go|partial|Accounting foundation exists; retained detailed reports/exports and migration semantics missing.
administration|Retention cleanup expires sessions/logs while preserving cumulative totals|app/academy.py|cleanup_records|backend/internal/identity/lifecycle.go|missing|Account deletion/revoke code does not provide scheduled legacy retention cleanup.
administration|Sanitized audit events and system/provider health-check persistence|app/admin_console.py|audit|backend/internal/identity/accounts.go|partial|Some Go audit mutations exist; service_checks/access logs/reporting and source field semantics incomplete.
catalog_discovery|Artwork cache: custom covers, themed gradient, poster/backdrop and thumbnail|app/artwork.py|get_or_create_lecture_thumbnail|backend/internal/api/catalog.go|partial|Single cover endpoint is not poster/backdrop/thumbnail generation/cache parity.
catalog_discovery|Metadata material classification, section inference and cover fallback selection|app/course_metadata.py|classify_material_type|backend/internal/api/materials.go|partial|Model fields/read/update exist; scan/upload/generated-cover and preservation semantics remain open.
catalog_discovery|Provider-backed document manifest reconciliation and authenticated byte retrieval|app/main.py|_fetch_odysee_doc_bytes|backend/internal/api/materials.go|missing|Local artifact download does not replace provider document fetching; preserve assignment/filename/claim mapping without exposing credentials.
catalog_discovery|Notebook cell/output HTML preview and download original file|app/main.py|get_course_material|backend/internal/api/materials.go|partial|Go artifact download exists; sanitized notebook rich preview branch is absent.
catalog_discovery|PPTX slide-text and DOCX paragraph preview with original download|app/main.py|get_course_material|backend/internal/api/materials.go|partial|Go artifact download exists; safe ordered archive/XML preview transformation is absent.
catalog_discovery|PDF, code/text/JSON and tabular data material rendering|app/main.py|get_course_material|backend/internal/api/materials.go|partial|Preserve actual content/type/disposition and safe preview/download behavior; compare bounded text/escaping.
delivery_operations|SQLite learner context functions and authorization-aware queries|app/db.py|connect|backend/internal/access/access.go|partial|Go explicit predicates exist; audit every missing operation and migration owner binding.
delivery_operations|Legacy SQL schema/migrations and typed PostgreSQL importer/preflight|app/migrations.py|migrate|backend/internal/store/migrations/007_planning.sql|partial|67 table source inventory/preflight only; typed importer/destinations/semantic rehearsal unfinished.
delivery_operations|Compressed HTML/static delivery and deterministic current bundle assembly|app/web_delivery.py|PageCompression|web/vite.config.ts|partial|Vite/Nginx artifacts exist; cache, compatibility entrypoints and preserved panel/style delivery unproven.
delivery_operations|Admin CLI provisioning/publication/provider/cleanup operations|scripts/academy_manage.py|-|backend/cmd/seed/main.go|partial|Synthetic seeder is not full admin operator CLI parity.
delivery_operations|Local doctor/validation and release-gate workflow|scripts/release_gate.py|-|web/scripts/verify_nginx.py|partial|Rewrite checks exist; full parity/capacity/recovery gates must remain blocking.
delivery_operations|Consistent SQL/artifact/vector/job backup and post-write restore/recovery|scripts/rewrite_migration_preflight.py|-|backend/internal/store/store.go|missing|Preflight never imports; no complete rehearsed cross-store recovery or post-write replay implementation.
delivery_operations|Existing server/Cloudflare routing, migration freeze/drain and safe deploy|watchdog.sh|-|backend/cmd/api/main.go|partial|Development entrypoints exist; production cutover/topology/provider envelope remains unresolved.
ai_import|Paid curriculum build, source download/index and DB synchronization tooling|build_paid_curriculum.py|-|backend/internal/jobs/executor.go|unverified|Top-level operator tools are scanned, not executed; Go-owned adapter mapping requires explicit operator contract.
ai_import|Batch Odysee upload and sanitized progress/provider manifest sync|odysee_batch_upload.py|-|backend/internal/media/odysee.go|missing|Native source resolution is not upload/remapping pipeline; credentials must remain server-side.
ai_import|Linux ingest pipeline, monitoring and worker restart operational flow|linux_pipeline.py|-|backend/cmd/worker/main.go|unverified|Offline source scan only; preserve checkpoints/artifacts and define operator migration contract.
'''


def extra_rows(legacy):
    rows = []
    for kind, data in [('ui_operation', UI_DATA), ('non_http_operation', WORKER_DATA)]:
        for line in data.strip().splitlines():
            parts = line.split('|')
            if kind == 'ui_operation':
                feature, operation, filename, symbol, newfile, detail = parts
                oldfile = 'app/static/' + filename
                replacement = None if newfile == '-' else 'web/src/' + newfile
                web_status = 'missing' if replacement is None else 'partial'
                go_status = 'unverified'
                refs = [ref(replacement)] if replacement else []
                go_ref = None
                status = web_status
            else:
                feature, operation, oldfile, symbol, newfile, status, detail = parts
                replacement = None if newfile == '-' else newfile
                go_status = status
                web_status = 'unverified'
                refs = []
                go_ref = ref(replacement) if replacement else None
            oldsymbol = None if symbol == '-' else symbol
            entry = {'id': ('UI' if kind == 'ui_operation' else 'OPS') + f'-{1 + sum(x["kind"] == kind for x in rows):03}',
                     'kind': kind, 'feature': feature, 'operation': operation, 'legacy_refs': [ref(oldfile, oldsymbol)],
                     'go_status': go_status, 'go_replacement': go_ref, 'web_status': web_status, 'web_refs': refs,
                     'status': status, 'limitation': detail, 'behavior_gate': GATES[feature][0] + ' Exercise: ' + operation + '.',
                     'migration_gate': GATES[feature][1], 'gate_status': 'pending',
                     'owner': legacy['features'][feature]['owner'],
                     'legacy_candidate_tests': legacy['features'][feature]['tests'], 'evidence_refs': []}
            if feature == 'planning_habits':
                entry['go_status'] = 'partial'
            rows.append(entry)
    return rows


def markdown(report):
    counts = report['summary']
    out = ['# Full source and current-UI feature parity inventory', '',
           'Snapshot: ' + report['revision'] + '. This is an **offline source audit**, not a production or browser execution. The working tree is dirty; source hashes below identify the inspected content. Existing source and UI changes were preserved.', '',
           f'The inventory contains **{counts["operation_count"]} concrete operations**: {counts["http_operation_count"]} registered legacy method/path pairs, {counts["ui_operation_count"]} UI actions/flows and {counts["non_http_operation_count"]} worker, adapter, persistence and operator operations. All full-parity gates remain pending. Route count and the 67-table input inventory are scope checks, not semantic completeness proof.', '',
           'The Go/TypeScript rewrite does **not yet preserve every implemented legacy feature or current UI panel**. Missing or partial backend areas include generated paths/topic assessments/adaptive practice/labs/tutor/syllabus/companion and detailed administrative reports/provider controls. TypeScript account, admin, review, quiz, planning, focus, habit, path, practice, lab, tutor and certificate flows remain incomplete. Native playback/discovery, planning and certificate APIs exist as scoped slices, with gaps recorded separately.', '',
           'Planning007 and certificates009 are registered in `backend/cmd/api/main.go` and isolated staging. Scoped planning15PG/race+31HTTP and certificates10PG/race+20HTTP checks pass. Playback008 permanently closes displaced media capabilities while allowing authorized409 recovery; curated browser handoff records37unit,60UI,35fault and25 unique real-stack passing checks. These are partial slices: browser parity, path/lab/AI adapters, reminders/admin reports, semantic migration, restart, real-device/provider and capacity gates remain open. Paths010/activity011 are staged with22/16PG race tests and42 integrated HTTP checks; real AI, frontend/admin/import/recovery gates remain open.', '',
           '## Scope and reproducibility', '',
           '`python3 scripts/rewrite_feature_inventory.py` regenerates both reports from allowlisted source using Python AST and constrained symbol/path extraction. It never imports the application, opens a database, reads environment/provider artifacts, starts services, creates accounts or contacts providers. The JSON records every scanned path, byte/line count, SHA-256, parse outcome and extracted symbol/control/selector metadata. It also records declared Go routes, frontend asset roots, candidate tests and migration issues.', '',
           f'Scanned **{counts["scanned_file_count"]} files**, including **{counts["python_app_module_count"]} Python app modules** and **{counts["legacy_static_file_count"]} current HTML/JS/CSS assets**. The source manifest digest is `{report["coverage"]["manifest_sha256"]}`. The self-generator hash is recorded separately; generated reports are excluded to avoid self-referential hashes.', '',
           'Excluded: `.env`, private SQLite/PostgreSQL state, provider/download manifests and session files, learner workspaces, media/images, dependencies/build output and resource-load evidence. `app/._artwork.py` is an AppleDouble metadata sidecar, not a Python module, and is explicitly excluded. Hardcoded provider credentials detected in existing `media.py`/`native_player.py` were never reproduced; only symbols, routes and file hashes are emitted.', '',
           'This is exhaustive **enumerated source scope**, not proof that every branch, UI action or latent feature is exercised. Python symbols include helpers and dependencies in the JSON, so an endpoint inventory cannot hide unregistered modules. Current HTML entrypoints and generated bundles are inspected alongside their constituent source. Source-only/unloaded dirty assets and legacy interview/placement panel reachability are marked unverified where runtime evidence is absent.', '',
           '## Status and gates', '',
           '- `implemented`: a comparable Go operation belongs to a previously documented scoped behavioral slice. This never means full legacy, UI or migration parity.',
           '- `partial`: some code/action exists, but lifecycle, response shape, capability, runtime wiring, UI or another required part is missing.',
           '- `missing`: no comparable operation/panel/adapter was found in the inspected replacement source.',
           '- `unverified`: source/helper/operator behavior or semantic comparison has not been demonstrated.', '',
           'The overall row status includes product/browser gaps. Separate Go and TypeScript status avoids counting an API route as a shipped screen. Every row links legacy source and Go/TS replacement or absence, names an owner and carries behavioral and migration gates in the JSON. Candidate legacy tests establish where to start, not rewritten behavior coverage. Existing M1, learning, range and browser reports are historical scoped evidence; this audit ran no service tests.', '',
           '| Kind | Implemented | Partial | Missing | Unverified |', '| --- | ---: | ---: | ---: | ---: |']
    for kind in ['http_operation', 'ui_operation', 'non_http_operation']:
        c = Counter(x['status'] for x in report['operations'] if x['kind'] == kind)
        out.append(f'| {kind} | {c["implemented"]} | {c["partial"]} | {c["missing"]} | {c["unverified"]} |')
    out += ['', '## Current HTML, loader and style delivery', '',
            '`index.html` currently loads `core.css`/`core.js` with its own versions. `scripts/build_web_assets.py` combines service/app/discovery/player/academy/mobile modules into core and path/assessment/practice/planner/weekly/focus modules into tools. `loaders.js` loads tools and pinned Media Chrome separately. The actual `core`/`tools` bundles are hashed independently from constituent source; editing a constituent alone cannot prove the delivered bundle has changed.', '',
            '`habits.js`/`habits.css`, `components.js`/`components.css` and `layout.css` have source in the current dirty tree but are absent from the inspected build groups. The report therefore inventories their operations/styles without assuming the browser loads them. Verify actual reachability before deciding whether to retain, replace or remove them. Service-worker precache asset versions differ from the inspected HTML versions; stale cache refresh and private API/media exclusion remain explicit gates.', '',
            'The rewrite TypeScript browser renders login, discovery (home/courses/saved), course/classroom, native video, lesson list, downloads and notes. It has no imported account/admin/learning-tool screen modules. New responsive styling is useful scoped work; it cannot replace the missing screens, fixed-theme/appearance controls, original deep links, title-modal tabs or material previews.', '',
            '## Concrete operations', '']
    for feature in report['features']:
        out += ['### ' + feature.replace('_', ' ').title(), '',
                '| ID / operation | Legacy source / route | Go replacement and status | TypeScript status | Remaining requirement |',
                '| --- | --- | --- | --- | --- |']
        for row in report['operations']:
            if row['feature'] != feature:
                continue
            loc = row['legacy_refs'][0]
            old = f'[{loc["file"]}:{loc["line"]}](../../{loc["file"]}#L{loc["line"]})'
            if row.get('legacy_route'):
                old += '<br>`' + row['legacy_route'] + '`'
            new = row.get('go_replacement')
            if new and new.get('route'):
                newtext = '`' + new['route'] + '`'
            elif new:
                newtext = '[' + new['file'] + '](../../' + new['file'] + ')'
            else:
                newtext = 'missing' if row['kind'] != 'ui_operation' else 'see linked API/OPS rows'
            note = row.get('limitation', row.get('go_limitation', ''))
            if row['kind'] == 'http_operation' and row['web_status'] == 'missing':
                note += ' TS panel/action absent.'
            out.append(f'| {row["id"]}: {row["operation"]} | {old} | {newtext}<br>**{row["go_status"]}** | **{row["web_status"]}** | {note.replace("|", "/")} |')
        out += ['', '**Behavior gate:** ' + GATES[feature][0], '', '**Migration gate:** ' + GATES[feature][1], '']
    out += ['## Migration, artifacts and retained behavior', '',
            'The machine report includes the complete existing migration input inventory and current PostgreSQL table declaration list. Its stored 67-table manifest is an input at its own source hash/revision; planning 007 can add destinations without completing field transforms or a working importer. Source-table counts must be refreshed after concurrent handoff. Every persistent route also requires field/ownership/timestamp/ordering/result semantic comparisons, not count equality alone.', '',
            'Required separate stores: original video path/fingerprint mapping; transcript caches; frames/OCR/vision; custom/generated covers; local and provider-mapped materials; versioned Qdrant points/citations; owned lab workspaces; job checkpoints/staged artifacts. Preserve learning time dimensions independently: position, explicit completion, watched intervals, wall playing time, visible page activity, focus intervals, reported actual minutes and habit/day credit. Historic quiz/review revision gaps cannot be repaired by inventing provenance, and old lifetime totals must not have retained sessions added again.', '',
            'Keep Python/SQLite authoritative until one consistent freeze/drain/snapshot/import/verify/cutover sequence passes. Invalidate active login/player/tokens and communicate re-sign-in. Typed transforms, artifact/vector restore, citation retrieval, complete backup restore and post-write replay/fix-forward remain release blockers. A read-only preflight or generic jobs table is not a migrated product feature.', '',
            '## Verification boundary and capacity', '',
            'This report validates only inventory structure and coverage accounting. Required next evidence is isolated two-learner/admin public API and actual browser workflows for each row, authorization/CSRF failures, retry/durability/revoke/fencing probes, and semantic imports with synthetic edge fixtures. Test ownership and existing report filenames are not assertions that those gates passed.', '',
            'No performance measurement was run. The 10,000-concurrent-learner figure remains a target. API capacity, realistic media delivery/decoded browser behavior, live Odysee provider scale and AI/lab job throughput need separate sustained/soak/fault verdicts under `GO_TYPESCRIPT_CAPACITY.md`. No production readiness or cutover approval follows from this inventory.', '',
            '## Coverage manifest', '',
            'The following path counts account for the hashed files; detailed per-file symbols, HTML controls, CSS tokens and SHA-256 values are in `FULL_FEATURE_PARITY.json`.', '',
            '| Source family | Files |', '| --- | ---: |']
    for group, count in sorted(report['coverage']['counts_by_family'].items()):
        out.append(f'| {group} | {count} |')
    out += ['', 'Aggregate source manifest: `' + report['coverage']['manifest_sha256'] + '`.', '',
            'Re-run after concurrent planning/player handoffs and review changed hashes before using this snapshot as current evidence.', '']
    return '\n'.join(out)


def generate():
    spec = importlib.util.spec_from_file_location('rewrite_route_source', ROOT / 'scripts/rewrite_inventory.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    legacy = module.inventory()  # AST-only, no application imports.
    records = scan_files()
    declarations = route_declarations(records)
    operations = api_rows(legacy, declarations) + extra_rows(legacy)
    families = Counter(p['file'].split('/')[0] if '/' in p['file'] else 'root/operator' for p in records)
    app_files = [p for p in records if p['file'].startswith('app/') and p['file'].endswith('.py')]
    static_files = [p for p in records if p['file'].startswith('app/static/') and p['kind'] in {'html', 'css', 'js'}]
    module_coverage = []
    for f in app_files:
        direct = [r['id'] for r in operations if any(a['file'] == f['file'] for a in r['legacy_refs'])]
        module_coverage.append({'file': f['file'], 'direct_operation_ids': direct,
                               'scope': 'direct operations' if direct else 'supporting dependency/schema/configuration; symbols captured in source manifest'})
    migration = json.loads(read('docs/rewrite/MIGRATION_INVENTORY.json'))
    manifest = '\n'.join(p['file'] + '\0' + p['sha256'] for p in records)
    result = {'schema_version': VERSION, 'revision': legacy['revision'], 'audit_method': 'offline source/AST + curated operation mapping; no app import, DB/network or service execution',
              'working_tree_is_dirty': bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT, text=True)),
              'status_definitions': {'implemented': 'scoped comparable operation with prior documented evidence; full parity gate still pending',
                                     'partial': 'some source/action present, required behavior/UI/wiring incomplete',
                                     'missing': 'no comparable replacement operation/panel/adapter found',
                                     'unverified': 'no behavioral or semantic proof; may be source/helper/operator only'},
              'summary': {'operation_count': len(operations), 'http_operation_count': len(legacy['routes']),
                          'ui_operation_count': sum(r['kind'] == 'ui_operation' for r in operations),
                          'non_http_operation_count': sum(r['kind'] == 'non_http_operation' for r in operations),
                          'scanned_file_count': len(records), 'python_app_module_count': len(app_files), 'legacy_static_file_count': len(static_files),
                          'overall_status_counts': dict(Counter(r['status'] for r in operations)),
                          'go_status_counts': dict(Counter(r['go_status'] for r in operations)),
                          'web_status_counts': dict(Counter(r['web_status'] for r in operations)), 'completed_full_parity_gate_count': 0},
              'features': legacy['features'], 'operations': operations,
              'coverage': {'manifest_sha256': hashlib.sha256(manifest.encode()).hexdigest(), 'manifest_digest_algorithm': 'SHA256(sorted newline-joined file + NUL + file-sha256 records)',
                           'generator_sha256': sha('scripts/rewrite_feature_inventory.py'), 'counts_by_family': dict(families),
                           'source_files': records, 'python_module_coverage': module_coverage,
                           'legacy_mounts': legacy['mounts'], 'legacy_framework_routes': legacy['framework_routes'],
                           'go_declared_routes': declarations,
                           'go_table_declarations': sorted({t for p in records if p['file'].startswith('backend/internal/store/migrations/') for t in p.get('tables', [])}),
                           'excluded': ['.env/private configuration values', 'SQLite/PostgreSQL/live DB', 'provider/download manifests and sessions',
                                        'learner workspaces', 'media/images', 'node_modules/dist/output', 'app/._artwork.py AppleDouble sidecar', 'generated parity reports'],
                           'entrypoints': ['app/static/index.html', 'app/static/core.js', 'app/static/core.css', 'app/static/loaders.js',
                                           'app/static/tools.js', 'app/static/tools.css', 'app/static/sw.js', 'scripts/build_web_assets.py',
                                           'web/index.html', 'web/src/main.ts', 'web/src/api.ts', 'web/src/style.css', 'backend/cmd/api/main.go', 'backend/cmd/worker/main.go', 'backend/cmd/media/main.go']},
              'migration_input': {'file': 'docs/rewrite/MIGRATION_INVENTORY.json', 'sha256': sha('docs/rewrite/MIGRATION_INVENTORY.json'),
                                  'scope': 'Existing 67-table/field manifest as input; destination/source changes must be regenerated by migration owner', 'inventory': migration},
              'verification': {'new_runtime_tests': 'none; this audit is source-only', 'full_parity': 'pending', 'migration': 'pending',
                               'planning_007': 'isolated staging/API/OpenAPI wired;15 disposable-PG/race +31 HTTP checks pass; UI/adapters/migration/restart gates pending',
                               'playback_008': 'displacement regression and fresh deliberate browser takeover pass; expired/revoked/cross-user remain denied',
                               'certificates_009': 'isolated staging/API/OpenAPI wired;10 PG/race +20 smoke checks pass; TS issuance/semantic import/recovery pending',
                               'paths_010': 'API/worker/projector/planner wired in isolated staging;22 PG/race tests and42 integrated product HTTP checks pass; real executor/selection/UI/practice/import/recovery pending',
                               'activity_011': 'isolated staging/API/OpenAPI wired;16 PG/race tests and42 integrated product HTTP checks pass; frontend/admin/retention/import/recovery/capacity pending',
                               'job_result_privacy': 'all job HTTP response paths project private results; unknown products/quiz raw output omitted; current lesson access rechecked; regression observed red then jobs/learning race passed',
                               'player_recovery': '37unit/60UI/35fault/25unique real-Go checks pass; full-run/rerun provenance in curated handoff; complete provider/device/capacity parity pending',
                               'capacity': 'unmeasured; 10,000 learner target only; API/media/provider/AI verdicts separate'},
              'limitations': ['Route matching is a candidate mapping, not endpoint or payload compatibility proof.',
                              'Source symbols/selectors/control extraction is reproducible enumeration, not branch or UI reachability proof.',
                              'Per-route UI reference families are discovery locators; UI rows supply action-specific locators.',
                              'Prior scoped HTTP/range/browser evidence was not rerun in this audit.',
                              'Concurrent dirty source can change during audit; refresh hashes after owner handoff.',
                              'No hardcoded credentials or arbitrary string constants are emitted.']}
    keys = [r['legacy_route'] for r in operations if r['kind'] == 'http_operation']
    assert len(keys) == len(set(keys)) == legacy['declared_method_path_count']
    assert all(r['status'] in {'implemented', 'partial', 'missing', 'unverified'} and r['behavior_gate'] and r['migration_gate'] for r in operations)
    assert all((ROOT / a['file']).is_file() for r in operations for a in r['legacy_refs'] + r.get('web_refs', []))
    assert all(p.get('parse_status') != 'syntax_error' for p in app_files)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', type=Path, default=ROOT / 'docs/rewrite')
    args = parser.parse_args()
    report = generate()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    (args.output_dir / 'FULL_FEATURE_PARITY.json').write_text(json.dumps(report, indent=2, sort_keys=True) + '\n')
    (args.output_dir / 'FULL_FEATURE_PARITY.md').write_text(markdown(report))
    print(json.dumps(report['summary'], sort_keys=True))


if __name__ == '__main__':
    main()
