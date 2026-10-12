#!/usr/bin/env python3
"""Inventory persistent SQL schemas from source only; never import/run app code.

No database, provider, credentials, or artifact file is opened. JSON and Markdown
are deterministic for the checked-out source hashes. Schema existence does not
prove implemented behavior, semantic migration, or parity.
"""
from __future__ import annotations
import argparse
import ast
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CREATE = re.compile(r"CREATE\s+(VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z_]\w*)\s*(?:USING\s+\w+\s*)?\(", re.I)
ALTER = re.compile(r"ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)\s+([^;]+)", re.I)
INDEX = re.compile(r"CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s+ON\s+(\w+)\s*\(([^;]+)", re.I)
CONSTRAINT = re.compile(r"^(?:PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\b", re.I)

# Destinations are candidates, not a claim that importers or product behavior exist.
# Renames are explicit; columns without a destination remain a hard migration gap.
MAP = {
 'users': ('users', {}, 'Preserve IDs and Argon2 hash bytes; normalize email only under a collision report; never synthesize owners.'),
 'videos': ('lessons', {'course':'course_id','duration':'duration_seconds'}, 'Course IDs remain original folder identifiers, not slugs. Preserve null duration distinctly; relative source paths need a validated root relocation map.'),
 'chunks': ('transcript_chunks', {'video_id':'lesson_id','start':'start_seconds','end':'end_seconds'}, 'Preserve chunk IDs, screen/transcript kinds and source times; frame_path must remain accessible in restored retrieval citations.'),
 'chunk_fts': ('transcript_chunks', {'chunk_id':'id'}, 'Rebuild PostgreSQL text search from chunks; compare searchable text, tokenization and authorization, not SQLite FTS shadow rows.'),
 'jobs': ('jobs', {'video_id':'lesson_id','status':'state'}, 'Legacy indexing jobs use integer IDs and no owner. Preserve IDs via an explicit namespace map; retain stage/attempt/checkpoints and assign an authorized import-service owner. queued/processing/done/failed require defined state mapping and worker-drain reconciliation.'),
 'course_publication': ('courses', {'course':'id'}, 'Union course references across all tables; preserve unpublished courses and description. Derive creation time only with documented provenance.'),
 'course_metadata': ('courses', {'course':'id','instructor':'instructor','tags_json':'tags'}, 'Validate tag JSON without truncation. cover_kind and fallback screen/covers must retain selection semantics; a single course updated_at cannot represent all independent source timestamps.'),
 'course_lesson_organization': ('lessons', {'video_id':'id','course':'course_id','position':'flow_order'}, 'Preserve fractional order, tie order and section; organization timestamp has no current destination. Reconcile raw title ordering versus organized flow.'),
 'course_materials_meta': ('materials', {'course':'course_id','friendly_name':'title'}, 'Preserve IDs, removed tombstones, filename, scope/section and position. Null lesson_id with legacy scope=lesson conflicts with the Go check; explicit fallback or rejected-row resolution is required, never silently drop.'),
 'enrollments': ('enrollments', {'course':'course_id'}, 'Preserve owner/course/timestamp; reject dangling references or repair under a signed plan.'),
 'lecture_providers': ('lesson_providers', {'video_id':'lesson_id'}, 'Preserve exact claim_name/claim_id and timestamp; provider authentication secrets are not source mappings.'),
 'video_progress': ('progress', {'video_id':'lesson_id'}, 'Legacy completion is not distinguished from explicit versus automatic completion. Define conservative migration semantics without replaying habit credits; import original position/percent/timestamp unchanged.'),
 'video_notes': ('notes', {'video_id':'lesson_id'}, 'Preserve ID/content/position/timestamp. Add deterministic import idempotency keys; rows longer than the Go 3000-character constraint require explicit schema/product resolution, not truncation.'),
 'bookmarks': ('bookmarks', {'video_id':'lesson_id'}, 'Preserve ID/position/label/owner/timestamp; reject or resolve strings outside new length bounds without truncation.'),
 'review_cards': ('review_cards', {'course':'course_id','video_id':'lesson_id'}, 'Preserve SM-2 repetitions, interval, ease and due/created timestamps. Initialize optimistic revision with provenance; historic loose text bounds may conflict with new constraints.'),
 'review_attempts': ('review_attempts', {}, 'Legacy integer attempt IDs need a stable text namespace. Course derives from card; historical card_revision and schedule JSON were not stored and must not be invented. A legacy-history representation is required.'),
 'review_sessions': ('review_sessions', {'course':'course_id'}, 'Preserve course-null global sessions, card counts and timestamps. Legacy sessions lack attempt linkage; importing cannot fabricate proof of specific attempts.'),
 'lesson_quizzes': ('lesson_quizzes', {'video_id':'lesson_id','course':'course_id'}, 'Split questions_json into immutable quiz_versions, preserve original IDs/status/timestamps and allow multiple legacy quizzes per lesson or explicitly reconcile; current UNIQUE(lesson_id) differs.'),
 'lesson_quiz_attempts': ('quiz_attempts', {'video_id':'lesson_id','answers_json':'answers'}, 'Preserve score/pass/correct/total and completed time. Define quiz_revision binding to imported immutable questions; result JSON absent in legacy cannot be fabricated. Do not reissue habit credit.'),
 'player_preferences': ('player_preferences', {}, 'Preserve false autoplay (legacy default false, Go default true), theater and supported speed; do not replace existing preferences with defaults.'),
 'native_totals': ('playback_totals', {'video_id':'lesson_id','ranges_json':'coverage'}, 'playing_seconds is wall playback time, not coverage length. Preserve independently; legacy intervals/position/duration require semantic validation and lifetime resume comparison. Do not SUM retained sessions onto already cumulative totals.'),
 'lesson_activity_totals': ('lesson_activity_totals', {'video_id':'lesson_id'}, 'Visible-page activity is distinct from native playing/watched time; preserve cumulative total and timestamp. Do not add retained activity sessions twice.'),
 'lesson_visits': ('lesson_visits', {'course':'course_id','video_id':'lesson_id'}, 'Preserve per-owner course last-visit selection and timestamp, separate from progress/history.'),
 'learning_events': ('learning_events', {'video_id':'lesson_id'}, 'Preserve ordered event IDs, details, owner, type and timestamp; retention and existing credited actions require explicit policy.'),
 'access_events': ('access_events', {}, 'Preserve IDs/user-null history/timestamps/device/IP under access-log retention. Current destination omits IP/device; raw archive does not satisfy operational report parity.'),
 'admin_audit': ('admin_audit', {}, 'Preserve legacy numeric IDs and actor-null audit. Current GENERATED ALWAYS identity needs OVERRIDING SYSTEM VALUE plus reseeding or an explicit stable ID map.'),
 'service_checks': ('service_checks', {}, 'Keep attempts/success/error/summary with sanitized historical errors; do not claim a migrated check as a fresh provider health proof.'),
 'my_list': ('saved_items', {}, 'Preserve course/lecture item IDs and created_at; derive and validate course_id/lesson_id even for currently unpublished content.'),
 'watch_history': ('watch_history', {'video_id':'lesson_id','course':'course_id','duration':'duration_seconds'}, 'Preserve numeric event ID and exact event timestamp/position/completion; reseed identity after import. Multiple events remain distinct.'),
 'history_cleared': ('history_cleared', {}, 'Preserve per-user clear watermark; do not resurrect old progress in continue-watching after import.'),
 'streaming_analytics': ('streaming_analytics', {}, 'Legacy rows contain ID/user/meta_json/exact timestamp; Go daily name counts lose those fields. Add retained event storage or an explicitly approved retention transformation; validate aggregate counts independently.'),
 'syllabi': ('syllabi', {'course':'course_id'}, 'Preserve content JSON and source_fingerprint/generated_at; citations carry course/video/chunk/source times and require recursively checked stable ID references.'),
 'learning_paths': ('learning_paths', {}, 'Preserve ID/goal/courses/content/source fingerprint/owner/update time; recursively validate step IDs and course/lesson citations.'),
 'learning_path_completions': ('learning_path_completions', {}, 'Preserve owner/path/step/completed timestamp; do not infer completion from percentage or reissue credits.'),
 'topic_assessments': ('topic_assessments', {}, 'Preserve owner/path/step/source fingerprint/questions/timestamp; never regenerate historical questions during import.'),
 'topic_assessment_attempts': ('topic_assessment_attempts', {}, 'Preserve private answers, counts, score and completed timestamp; verify assessment owner matches attempt owner.'),
 'lab_sessions': ('lab_sessions', {}, 'Preserve curated slug/status/private result/files and timestamps. Files live outside SQL and must be checksummed in a per-session owned workspace manifest.'),
 'practice_sessions': ('practice_sessions', {}, 'Preserve lab session ID/path/step/slug/owner/time and consistent cross-table ownership.'),
 'practice_attempts': ('practice_attempts', {}, 'Preserve pass/check counts/private result/completion; do not rerun historical submissions as migration.'),
 'planner_preferences': ('planner_preferences', {}, 'Preserve user/singleton/daily budget/path/update time; path ownership must match.'),
 'daily_plans': ('daily_plans', {}, 'Preserve local study_date, timezone offset, path, budget and original timestamps; do not reinterpret historical dates in server UTC.'),
 'daily_plan_items': ('daily_plan_items', {}, 'Preserve stable id/item key/kind/action JSON/status/estimated and actual minutes, local day and timestamp. Recursively check action citations.'),
 'weekly_preferences': ('weekly_preferences', {}, 'Preserve all seven weekday budgets and update time, including rest-day zero.'),
 'weekly_plans': ('weekly_plans', {}, 'Preserve week_start/timezone offset/minutes/forecast/path/unscheduled_reviews/timestamps; validate Monday and local-day semantics.'),
 'focus_sessions': ('focus_sessions', {'video_id':'lesson_id'}, 'Preserve focus versus break, status/duration/planner/lab/lesson links and timestamps. Active timers must be safely paused at freeze without inventing elapsed time.'),
 'focus_intervals': ('focus_intervals', {}, 'Preserve numeric interval ID/owner/session/began/ended; resolve open intervals at the recorded freeze boundary and retain provenance. Focus seconds remain separate from playback.'),
 'habit_preferences': ('habit_preferences', {}, 'Preserve timezone/goal/reminder opt-in and timestamp; DST/local day behavior remains an explicit product contract.'),
 'habit_actions': ('habit_actions', {}, 'Preserve deduplication keys action/resource/day/owner. Go learning_credits only accepts quiz/review and cannot represent lesson/other actions without a semantic map.'),
 'habit_days': ('habit_days', {}, 'Preserve exact watched seconds, lesson/quiz/review counts and goal_met by original local day; do not regenerate from incomplete retained event history.'),
 'reminder_deliveries': ('reminder_deliveries', {}, 'Preserve per-user week delivery state/timestamp to avoid duplicate reminders after cutover.'),
 'course_certificates': ('course_certificates', {'course':'course_id'}, 'Preserve stable ID, issued student_name, verification_code and completed time; do not reissue codes or retroactively apply new completion requirements.'),
 'lesson_briefs': ('lesson_briefs', {'video_id':'lesson_id','course':'course_id'}, 'Preserve bullets/prerequisites/outcome/generated time and citations; no regeneration during import.'),
 'ai_tutor_logs': ('ai_tutor_logs', {'video_id':'lesson_id','course':'course_id'}, 'Preserve nullable user and source/mode/language/model/cost/token counters and timestamp under agreed privacy retention; no secrets in manifests.'),
 'interview_prep_sessions': ('interview_prep_sessions', {'course':'course_id'}, 'Preserve private question/answer/feedback/topic/scores/status/timestamps; unfinished sessions retain resumability.'),
 'placement_tests': ('placement_tests', {'course':'course_id','recommended_lesson_id':'recommended_lesson_id'}, 'Preserve private answers/score/recommendation ID and issued title/time; validate referenced lesson belongs to course.'),
 'task_queue': ('jobs', {'status':'state'}, 'Legacy task kinds/payloads/results/errors may be course/global, while Go jobs require a lesson and restricted kinds. Define per-kind migration/adapters; preserve checkpoints and stable ID/owner/timestamps, fence or requeue only after worker drain.'),
}
INVALIDATE = {
 'auth_sessions': 'Invalidate active login sessions at cutover and require sign-in. Preserve historical device/IP/last_seen in a private report store if required; never reactivate cookie tokens.',
 'account_tokens': 'Invalidate outstanding verification/invitation/reset links; document reissue workflow. Never put token hashes in public manifests.',
 'playback_sessions': 'Invalidate embedded media tokens at cutover; consumed state and original report relationships require retained historical reporting.',
 'activity_sessions': 'Close active activity sessions at freeze. Preserve retained reports (including device/IP/sequence/activity_seconds/player link) separately from cumulative activity totals; invalidating a lease does not authorize dropping history.',
 'activity_leases': 'Invalidate all leases at cutover; never resume old process ownership.',
 'native_sessions': 'Close active native sessions at freeze; preserve retained native playback reports, playing_seconds/position/duration/state/device/IP/sequence/player relationships separately from totals.',
 'native_leases': 'Invalidate all native playback leases at cutover.',
 'player_sessions': 'Close native/embedded player sessions at freeze; preserve historical mode/session relationships where retained, never transfer active ownership.',
 'player_ownership': 'Invalidate all tab ownership leases at cutover.',
 'rate_limits': 'Expire ephemeral rate-limit windows at cutover under a documented brief reset policy; new login/public mutation rate-limit behavior still needs validation.',
 'schema_migrations': 'Record original applied versions in provenance; initialize Go migrations independently. Do not copy SQLite version numbers into Go schema_migrations.',
}


def split_sql(text: str, delimiter=',') -> list[str]:
    """Split outside parentheses/quotes, including doubled SQL quote escapes."""
    parts, start, depth, quote, i = [], 0, 0, None, 0
    while i < len(text):
        ch = text[i]
        if quote:
            if ch == quote:
                if i + 1 < len(text) and text[i+1] == quote:
                    i += 2
                    continue
                quote = None
        elif ch in "'\"": quote = ch
        elif ch == '(': depth += 1
        elif ch == ')': depth -= 1
        elif ch == delimiter and depth == 0:
            parts.append(text[start:i].strip()); start = i+1
        i += 1
    parts.append(text[start:].strip())
    return [p for p in parts if p]


def balanced_body(sql: str, start: int) -> str:
    depth, quote, i = 1, None, start
    while i < len(sql):
        ch = sql[i]
        if quote:
            if ch == quote:
                if i+1 < len(sql) and sql[i+1] == quote: i += 2; continue
                quote = None
        elif ch in "'\"": quote = ch
        elif ch == '(': depth += 1
        elif ch == ')':
            depth -= 1
            if depth == 0: return sql[start:i]
        i += 1
    raise ValueError('Unclosed SQL table definition')


def definition(body: str) -> dict:
    columns, constraints = {}, []
    for part in split_sql(body):
        part = ' '.join(part.split())
        if CONSTRAINT.match(part): constraints.append(part)
        else:
            m = re.match(r'([a-zA-Z_]\w*)\s*(.*)', part)
            if not m: raise ValueError(f'Unsupported SQL column: {part}')
            columns[m[1]] = m[2]
    return {'columns':columns,'constraints':constraints}


def inventory() -> dict:
    legacy, go, hashes, additions, indexdefs = {}, {}, {}, [], []
    pyfiles = [p for p in sorted((ROOT/'app').glob('*.py')) if not p.name.startswith('.')]
    migration_tree = None
    for p in pyfiles:
        raw = p.read_bytes(); tree = ast.parse(raw.decode('utf-8'))
        if p.name == 'migrations.py': migration_tree = tree
        found = False
        for node in ast.walk(tree):
            if not isinstance(node,ast.Constant) or not isinstance(node.value,str): continue
            sql = node.value
            for m in CREATE.finditer(sql):
                table = m[2]
                if table.startswith('upgrade_'): continue
                if table in legacy: raise ValueError(f'Duplicate source create: {table}')
                origin = {'path':str(p.relative_to(ROOT)), 'line':node.lineno+sql[:m.start()].count('\n')}
                legacy[table] = definition(balanced_body(sql,m.end())) | {'virtual':bool(m[1]),'sources':[origin]}
                found = True
            for m in INDEX.finditer(sql):
                indexdefs.append((m[3],m[2],bool(m[1]),' '.join(m[4].split()).rstrip(')')) )
                found = True
            for m in ALTER.finditer(sql):
                additions.append((m[1],m[2],m[3],{'path':str(p.relative_to(ROOT)),'line':node.lineno}))
                found = True
        if found: hashes[str(p.relative_to(ROOT))] = hashlib.sha256(raw).hexdigest()
    assert migration_tree is not None
    for node in migration_tree.body:
        if not isinstance(node,ast.Assign): continue
        names = [n.id for n in node.targets if isinstance(n,ast.Name)]
        if 'REBUILDS' in names:
            for table, body in ast.literal_eval(node.value).items():
                legacy[table].update(definition(body))
                legacy[table]['sources'].append({'path':'app/migrations.py','line':node.lineno,'kind':'ownership-rebuild'})
        if 'PERSONAL_TABLES' in names:
            for table in ast.literal_eval(node.value):
                legacy[table]['columns'].setdefault('user_id',"TEXT NOT NULL DEFAULT 'legacy'")
                legacy[table]['sources'].append({'path':'app/migrations.py','line':node.lineno,'kind':'explicit-owner-upgrade'})
    for table,col,spec,origin in additions:
        if table not in legacy: raise ValueError(f'Alter on unknown table: {table}')
        legacy[table]['columns'][col] = ' '.join(spec.split())
        if origin not in legacy[table]['sources']: legacy[table]['sources'].append(origin)
    for table,index,unique,body in indexdefs:
        if table in legacy:
            legacy[table].setdefault('indexes',[]).append({'name':index,'unique':unique,'columns_and_predicate':body})
    # Migration 1 explicitly replaces the global focus-running index. Dynamic
    # owner indexes are known from PERSONAL_TABLES rather than guessed from data.
    legacy['focus_sessions']['indexes'] = [i for i in legacy['focus_sessions'].get('indexes',[]) if i['name']!='focus_running_unique'] + [{'name':'focus_running_unique','unique':True,'columns_and_predicate':"user_id) WHERE status='running'"}]
    for table in ast.literal_eval(next(n.value for n in migration_tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='PERSONAL_TABLES' for t in n.targets))):
        legacy[table].setdefault('indexes',[]).append({'name':table+'_owner_idx','unique':False,'columns_and_predicate':'user_id'})
    for p in sorted((ROOT/'backend/internal/store/migrations').glob('*.sql')):
        raw=p.read_bytes(); sql=re.sub(r'--[^\n]*','',raw.decode('utf-8'))
        hashes[str(p.relative_to(ROOT))]=hashlib.sha256(raw).hexdigest()
        for m in CREATE.finditer(sql):
            table=m[2]
            if table in go: raise ValueError(f'Duplicate Go create: {table}')
            go[table]=definition(balanced_body(sql,m.end())) | {'sources':[str(p.relative_to(ROOT))]}
        for m in ALTER.finditer(sql):
            table,col=m[1],m[2]
            if table not in go: raise ValueError(f'Go alter before create: {table}')
            go[table]['columns'][col]=' '.join(m[3].split())
            if str(p.relative_to(ROOT)) not in go[table]['sources']: go[table]['sources'].append(str(p.relative_to(ROOT)))
    # This maintenance script repeats course_publication, but defines no new
    # persistent table. Parse only DDL literals; do not execute its module.
    helper=ROOT/'sync_paid_course_to_db.py'
    if helper.exists():
        raw=helper.read_bytes(); hashes[str(helper.relative_to(ROOT))]=hashlib.sha256(raw).hexdigest()
        for node in ast.walk(ast.parse(raw.decode('utf-8'))):
            if isinstance(node,ast.Constant) and isinstance(node.value,str):
                for m in CREATE.finditer(node.value):
                    table=m[2]
                    candidate=definition(balanced_body(node.value,m.end()))
                    if table not in legacy or candidate['columns']!=legacy[table]['columns'] or candidate['constraints']!=legacy[table]['constraints']:
                        raise ValueError(f'Maintenance-script schema diverges: {table}')
                    legacy[table]['sources'].append({'path':str(helper.relative_to(ROOT)),'line':node.lineno,'kind':'maintenance-definition'})
    artifact_sources=['app/library.py','app/extractor.py','app/vectorstore.py','app/worker.py','app/academy_worker.py','app/labs.py','app/course_metadata.py','app/chunking.py']
    for name in artifact_sources:
        hashes[name]=hashlib.sha256((ROOT/name).read_bytes()).hexdigest()
    unknown = set(legacy)-set(MAP)-set(INVALIDATE)
    stale = (set(MAP)|set(INVALIDATE))-set(legacy)
    if unknown or stale: raise ValueError(f'Mapping coverage mismatch unknown={sorted(unknown)} stale={sorted(stale)}')
    for schema in list(legacy.values())+list(go.values()):
        schema['column_order']=list(schema['columns'])
    rows=[]
    for name, schema in sorted(legacy.items()):
        if name in INVALIDATE:
            row={'table':name,'policy':'cutover-lifecycle','targets':[], 'requirement':INVALIDATE[name], 'column_mapping':[], 'unresolved_columns':list(schema['columns'])}
        else:
            target,renames,requirement=MAP[name]
            dest=go.get(target,{}).get('columns',{})
            mappings=[]
            for col in schema['columns']:
                candidate=renames.get(col,col)
                mappings.append({'source':col,'destination':f'{target}.{candidate}' if candidate in dest else None,'status':'candidate-needs-semantic-check' if candidate in dest else 'missing-destination'})
            row={'table':name,'policy':'feature-migration','targets':[target], 'target_schema_exists':target in go,'requirement':requirement,'column_mapping':mappings,'unresolved_columns':[m['source'] for m in mappings if not m['destination']], 'destination_only_columns': sorted(set(dest)-{renames.get(c,c) for c in schema['columns']})}
        rows.append(row|{'source_schema':schema,'owner_columns':[c for c in schema['columns'] if c in ('user_id','actor_id')], 'timestamp_columns':[c for c in schema['columns'] if c.endswith('_at') or c in ('last_seen','last_heartbeat','expires_at','reset_at','study_date','week_start','day','week','mtime_ns')], 'references':[spec for spec in schema['columns'].values() if 'REFERENCES' in spec]+[c for c in schema['constraints'] if c.startswith('FOREIGN')]})
    return {'format_version':1,'excluded_schema_objects': {'SQLite internals':'sqlite_sequence and FTS shadow tables are implementation indexes, not separate feature tables; snapshot preflight must recognize them explicitly', 'app/lab_graders/tracks.py':'customers/orders are isolated learner SQL grader fixtures, not application persistence', 'dynamic upgrade_<table>':'temporary ownership migration rebuild tables, not final schema'},'scope':'source-only; no live DB or filesystem artifacts read','evidence':'schema candidates only; not a migration or feature-parity pass; index definitions record source intent, not database execution state','source_hashes':dict(sorted(hashes.items())),'summary':{'legacy_tables':len(legacy),'go_tables':len(go),'feature_tables':len(MAP),'cutover_lifecycle_tables':len(INVALIDATE),'feature_tables_without_destination':sum(not row.get('target_schema_exists',True) for row in rows),'feature_columns_without_destination':sum(len(row['unresolved_columns']) for row in rows if row['policy']=='feature-migration')},'tables':rows,'go_schemas':go}


def markdown(data: dict) -> str:
    summary=data['summary']
    text=[ '# SQLite → PostgreSQL source migration inventory', '',
      'This report inspects source definitions only. It opens no live SQLite database, provider connection, artifact directory or vector collection. It does not establish live row counts, valid snapshots, a working importer, feature parity or production readiness.', '',
      f"The checked-out definitions contain **{summary['legacy_tables']} legacy tables** and **{summary['go_tables']} Go destination tables**. Of {summary['feature_tables']} feature tables, {summary['feature_tables_without_destination']} have no matching destination schema and {summary['feature_columns_without_destination']} source columns have no direct destination. Eleven lifecycle tables require explicit invalidation, rebuilding or history-retention decisions. Same-named columns remain semantic candidates, not completed transforms. SQLite internals/FTS shadow objects, temporary upgrade tables and isolated grader fixture tables are excluded explicitly; the maintenance script duplicate schema is cross-checked.", '',
      'Regenerate with `python3 scripts/rewrite_migration_inventory.py`; verify the checked-in outputs with `python3 scripts/rewrite_migration_inventory.py --check`. JSON contains complete effective columns, constraints, explicit owner upgrades, indexes, destination-only initialization fields, source locations and SHA-256 hashes. No source credential literals are emitted.', '',
      '| Legacy table | Candidate destination / lifecycle | Source fields without direct destination | Required semantic transformation |',
      '| --- | --- | --- | --- |' ]
    for row in data['tables']:
        target=', '.join(f'`{t}`'+(' (schema missing)' if not row.get('target_schema_exists',True) else '') for t in row['targets']) or 'Cutover lifecycle'
        missing=', '.join(f'`{x}`' for x in row['unresolved_columns']) or 'None; semantics still unverified'
        text.append(f"| `{row['table']}` | {target} | {missing} | {row['requirement'].replace('|','/')} |")
    text += ['', '## Cross-store recovery requirements', '',
      '| Store/reference | Required preservation and proof |', '| --- | --- |',
      '| Video files and source identity | `videos.path`, bytes, mtime_ns, language, indexing/error state and indexed_at are source identity/provenance. Relocate under explicit approved roots; preserve original paths separately. Verify source fingerprints and checksums without fetching provider secrets. IDs derive from relative paths in `app/library.py`; do not regenerate IDs from relocated absolute paths. |',
      '| Transcript cache | `data/transcripts/<video_id>.json` carries segments, language, source byte/mtime fingerprint and Whisper model. Include checksums, source lesson ID, generation/model and original relative path. Validate citations and determine whether to restore or deliberately rebuild caches. |',
      '| Screen/OCR frames | `chunks.frame_path` points into data-relative frame files; screens may have no text and no vector point. Preserve every referenced image, checksum, kind and source time; test restored artwork and retrieval image access. Blank OCR is not permission to discard the frame. |',
      '| Qdrant | `app/vectorstore.py` uses chunk IDs as point IDs and payload video/course/kind/start/end/text/frame_path. Manifest collection generation, distance, dimension, embedding model, point IDs and source checksums. Snapshot after workers stop or rebuild into a versioned staging collection, then prove equivalent authorized retrieval and source citations. Do not mutate the live collection during rehearsal. |',
      '| Covers | `course_metadata.cover_kind` selects custom/fallback artwork. Custom cover paths use SHA-256 of original course identifier, not title/slug. Preserve image checksums and selection semantics plus fallback screen references. |',
      '| Materials/provider manifests | SQL material metadata is not a file inventory. Reconcile original course-root filenames, removed tombstones, scope/lesson mapping, local content checksums, provider claim mappings and both configured manifest locations. Keep credentials out of manifests; record mismatches rather than silently selecting one source. |',
      '| Labs | Preserve private `data/labs/workspaces/<session_id>` files with session owner and curated slug mapping. Reject symlinks/path traversal; exclude kubeconfig/credential/private infrastructure files. Copy learner submissions only under the allowlisted workspace contract. |',
      '| Jobs and staged artifacts | Pause/drain both legacy workers before snapshot. Record each task/job state, attempt/stage/results/error and artifact/vector publication checkpoint. New fencing tokens and idempotency keys must prevent stale legacy attempts or resumed jobs from duplicating publication. A completed job cannot be proved from status alone when referenced stores are absent. |', '',
      '## Strict importer foundation', '',
      '1. Accept only an explicitly supplied consistent SQLite snapshot and artifact/vector manifests; never default to the production database path. Preflight source hashes, source schema/migration versions, SQLite integrity/foreign keys, owner mappings and immutable course/lesson identities. Use a read-only SQLite connection and an isolated target namespace.',
      '2. Produce a deterministic dry-run plan: every source table, row count, canonical row checksum, destination, typed transform version, unresolved row/column issue and explicit lifecycle policy. Unknown tables/columns, owner=`legacy`, malformed JSON/dates/non-finite times, ID collisions and new destination constraints fail closed unless resolved by a versioned decision file. Do not remap owner=`legacy` to an arbitrary administrator.',
      '3. Preserve all raw snapshot rows in a private typed recovery archive with table/column metadata, blob encoding, stable source primary key and canonical checksums. Hashes/tokens/passwords remain restricted. This archive is a recovery adjunct: an archived row never counts as a migrated product feature or excuses a missing semantic destination.',
      '4. Import typed destinations transactionally in dependency order. Keep original IDs, ownership, timestamps, ordering and references; document added revision/idempotency/provenance fields. Preserve independent watched/playing/visible/focus/planned/actual metrics. Do not regenerate historic feedback or replay completion/habit credit. Disable all session/ownership/token continuation under the recorded cutover policy.',
      '5. Check mapped row counts, every preserved field and semantic aggregate, sequence reseeding, all foreign keys, Argon2 compatibility, exact notes/feedback/questions and original coverage intervals. Validate file checksums and restored authorized material/frame access plus versioned vector retrieval citations. Capture unresolved transforms as a failing report, never a warning-only success.',
      '6. Rehearse with synthetic edge fixtures and isolated snapshots: owner collisions, null/missing references, oversized text, duplicate lesson quizzes, historical reviews without schedules, nullable AI owner, open focus intervals, clear-history watermarks and cumulative totals with retained sessions. Crash/retry import must produce either a complete committed generation or no destination mutation.',
      '7. Publish a migration generation only after all gates pass, retaining the consistent input snapshot/manifests and before/after semantic reports. Measure duration before specifying the write-freeze window. Prove complete backup restore and post-write fix-forward/replay recovery; routing back to old SQLite after new writes is insufficient.', '',
      '## Remaining evidence', '',
      'No importer execution, live row counts, artifact existence/checksums, vector snapshot, migration rehearsal or recovery pass is claimed here. Destination schema availability also does not prove the corresponding API or browser behavior. The JSON explicitly marks every field candidate as needing semantic verification.', '' ]
    return '\n'.join(text)


def main() -> int:
    parser=argparse.ArgumentParser(description=__doc__); parser.add_argument('--check',action='store_true'); args=parser.parse_args()
    data=inventory()
    outputs={ROOT/'docs/rewrite/MIGRATION_INVENTORY.json':json.dumps(data,indent=2,sort_keys=True,ensure_ascii=False)+'\n',ROOT/'docs/rewrite/MIGRATION_INVENTORY.md':markdown(data)}
    failed=[]
    for path,content in outputs.items():
        if args.check:
            if not path.exists() or path.read_text()!=content: failed.append(str(path.relative_to(ROOT)))
        else: path.parent.mkdir(parents=True,exist_ok=True); path.write_text(content)
    if failed: print('Stale inventory: '+', '.join(failed)); return 1
    print(json.dumps(data['summary'],sort_keys=True)); return 0
if __name__=='__main__': raise SystemExit(main())
