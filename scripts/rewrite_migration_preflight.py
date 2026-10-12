#!/usr/bin/env python3
"""Read-only, aggregate-only validation of an explicitly isolated SQLite snapshot.

No application imports, provider traffic, PostgreSQL writes, content/hash/token
exports, or automatic production path discovery. A structurally sound snapshot
is not an implemented semantic migration or feature-parity pass.
"""
from __future__ import annotations
import argparse
from collections import Counter
from contextlib import closing
from datetime import date, datetime
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import stat
import time
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]
INVENTORY = ROOT / 'docs/rewrite/MIGRATION_INVENTORY.json'
FTS_INTERNALS = {'chunk_fts_data','chunk_fts_idx','chunk_fts_content','chunk_fts_docsize','chunk_fts_config'}
JSON_ARRAY_COLUMNS = {'tags_json','courses_json','questions_json','bullets_json','ranges_json','minutes_json','forecast_json'}
TIMESTAMP_COLUMNS = {'created_at','updated_at','expires_at','last_seen','due_at','reviewed_at','completed_at','generated_at','indexed_at','last_attempt','last_success','watched_at','cleared_at','began_at','ended_at'}
NUMERIC_COLUMNS = {'position','duration','start','end','source_start','playing_seconds','activity_seconds','watched_seconds','last_heartbeat','reset_at','mtime_ns','bytes','duration_seconds','minutes','actual_minutes','budget_minutes','daily_minutes','last_sequence','attempt','repetitions','interval_days','ease','prompt_tokens','completion_tokens','cost_estimate','readiness_score'}
DATE_COLUMNS = {'study_date','week_start','day'}
OWNER_PARENTS = {'review_attempts':('card_id','review_cards','id'), 'learning_path_completions':('path_id','learning_paths','id'), 'topic_assessments':('path_id','learning_paths','id'), 'topic_assessment_attempts':('assessment_id','topic_assessments','id'), 'practice_sessions':('session_id','lab_sessions','id'), 'practice_attempts':('session_id','practice_sessions','session_id'), 'focus_intervals':('session_id','focus_sessions','id')}
OPTIONAL_OWNER = {'ai_tutor_logs'}


def q(identifier: str) -> str:
    # Only inventory-controlled identifiers enter SQL queries.
    if not re.fullmatch(r'[A-Za-z_]\w*', identifier): raise ValueError('invalid_identifier')
    return '"'+identifier+'"'


def affinity(spec: str) -> str:
    value=spec.upper()
    if 'INT' in value: return 'INTEGER'
    if any(t in value for t in ('CHAR','CLOB','TEXT')): return 'TEXT'
    if not value or 'BLOB' in value: return 'BLOB'
    if any(t in value for t in ('REAL','FLOA','DOUB')): return 'REAL'
    return 'NUMERIC'


def strict_json(raw):
    def invalid_constant(_): raise ValueError('nonfinite_json')
    if not isinstance(raw,str) or len(raw)>16*1024*1024: raise ValueError('invalid_json_size')
    def unique_object(pairs):
        value={}
        for key,item in pairs:
            if key in value: raise ValueError('duplicate_json_key')
            value[key]=item
        return value
    return json.loads(raw,parse_constant=invalid_constant,object_pairs_hook=unique_object)


def number(value) -> bool:
    return type(value) in (float,int) and math.isfinite(value)


class Report:
    def __init__(self):
        self.issues=Counter(); self.counts={}; self.schema_valid=set(); self.inventory_current=False
    def issue(self,code: str,table: str|None=None,count: int=1):
        if count: self.issues[(code,table)]+=count
    def result(self):
        # Every code/table comes from this implementation or the fixed inventory.
        diagnostics=[{'code':code,'count':count,**({'table':table} if table else {})} for (code,table),count in sorted(self.issues.items(),key=lambda pair:(pair[0][0],pair[0][1] or ''))]
        source_blockers=[d for d in diagnostics if not d['code'].startswith(('mapping_','recovery_','inventory_'))]
        return {'format_version':1,'operation':'read_only_snapshot_preflight','report_scope':'aggregate diagnostics; no learner or credential values','inventory_source_current':self.inventory_current,'snapshot_checks_passed':not source_blockers,'migration_authorized':False,'postgresql_writes':0,'row_counts':dict(sorted(self.counts.items())),'diagnostics':diagnostics,'verdict':'blocked'}


def safe_snapshot(raw: str, asserted: bool) -> Path:
    if not asserted: raise ValueError('isolated_snapshot_assertion_required')
    p=Path(raw).expanduser()
    if p.is_symlink(): raise ValueError('snapshot_symlink_rejected')
    p=p.resolve(strict=True)
    if not stat.S_ISREG(p.stat().st_mode): raise ValueError('snapshot_regular_file_required')
    prohibited=[ROOT/'data']
    configured=os.environ.get('DATA_DIR')
    if configured: prohibited.append(Path(configured).expanduser().resolve())
    if any(p.is_relative_to(root.resolve()) for root in prohibited): raise ValueError('live_data_directory_rejected')
    # No live DB is opened. An inode comparison prevents a hard-link alias of the
    # conventional live database from bypassing directory checks.
    for root in prohibited:
        live=root/'courseforge.sqlite3'
        if live.exists() and os.path.samefile(p,live): raise ValueError('live_database_alias_rejected')
    if any(Path(str(p)+suffix).exists() for suffix in ('-wal','-shm','-journal')): raise ValueError('snapshot_sidecar_rejected')
    return p


def normalize_sql(expression: str) -> str:
    tokens=re.findall(r"'(?:''|[^'])*'|[A-Za-z_]\w*|[^\s]",expression)
    return ''.join(token if token.startswith("'") else token.lower() for token in tokens)


def checks(sql: str) -> list[str]:
    expressions=[]
    for match in re.finditer(r'\bCHECK\s*\(',sql,re.I):
        depth=1; i=match.end(); start=i; quoted=None
        while i<len(sql):
            char=sql[i]
            if quoted:
                if char==quoted:
                    if i+1<len(sql) and sql[i+1]==quoted: i+=2; continue
                    quoted=None
            elif char in "'\"": quoted=char
            elif char=='(': depth+=1
            elif char==')':
                depth-=1
                if depth==0:
                    # Preserve case within quoted enum values; fold SQL outside.
                    expressions.append(normalize_sql(sql[start:i]))
                    break
            i+=1
    return sorted(expressions)


def unique_keys(db, table: str) -> set[tuple]:
    keys=set()
    for index in db.execute('PRAGMA index_list('+q(table)+')'):
        if not index[2]: continue
        columns=tuple(r[2] for r in db.execute('PRAGMA index_info('+q(index[1])+')'))
        row=db.execute("SELECT sql FROM sqlite_schema WHERE type='index' AND name=?",(index[1],)).fetchone()
        where=re.search(r'\bWHERE\s+(.+)',row[0],re.I) if row and row[0] else None
        keys.add((columns,normalize_sql(where[1]) if where else None))
    return keys


def expected_schema(table: str, spec: dict) -> tuple[list, list, list, set]:
    # Interpret schema text from the source-only inventory in disposable memory.
    # Never import app code or reconstruct data from source literals.
    with closing(sqlite3.connect(':memory:')) as memory:
        columns=spec['columns']; order=spec.get('column_order',list(columns))
        if spec['virtual']:
            ddl='CREATE VIRTUAL TABLE '+q(table)+' USING fts5('+','.join(q(c)+' '+columns[c] for c in order)+')'
        else:
            ddl='CREATE TABLE '+q(table)+'('+','.join([q(c)+' '+columns[c] for c in order]+spec['constraints'])+')'
        memory.execute(ddl)
        info=[(r[1],affinity(r[2]),bool(r[3]),r[5]) for r in memory.execute('PRAGMA table_info('+q(table)+')')]
        foreign=[tuple(r[2:]) for r in memory.execute('PRAGMA foreign_key_list('+q(table)+')')]
        uniques=unique_keys(memory,table)
        for index in spec.get('indexes',[]):
            if index['unique']:
                column_text=index['columns_and_predicate'].split(')')[0]
                where=re.search(r'\bWHERE\s+(.+)',index['columns_and_predicate'],re.I)
                uniques.add((tuple(c.strip() for c in column_text.split(',')),normalize_sql(where[1]) if where else None))
        return info,sorted(foreign),checks(ddl),uniques


def validate_schema(db, inv, report):
    tables={r[0] for r in db.execute("SELECT name FROM sqlite_schema WHERE type='table'")}
    expected={r['table'] for r in inv['tables']}
    internals={'sqlite_sequence'}| (FTS_INTERNALS if 'chunk_fts' in tables else set())
    report.issue('unknown_tables',count=len(tables-expected-internals))
    report.issue('unknown_views_or_triggers',count=db.execute("SELECT count(*) FROM sqlite_schema WHERE type IN ('view','trigger')").fetchone()[0])
    for row in inv['tables']:
        table=row['table']
        if table not in tables: report.issue('missing_table',table); continue
        actual=[(r[1],affinity(r[2]),bool(r[3]),r[5]) for r in db.execute('PRAGMA table_info('+q(table)+')')]
        exp,foreign,expected_checks,expected_uniques=expected_schema(table,row['source_schema'])
        actual_names={r[0] for r in actual}; expected_names={r[0] for r in exp}
        report.issue('unknown_columns',table,len(actual_names-expected_names))
        report.issue('missing_columns',table,len(expected_names-actual_names))
        # Ordinal drift changes SELECT * snapshot serialization and needs an
        # explicit decision, but data queries always use named columns.
        if actual!=exp: report.issue('schema_column_definition_mismatch',table)
        actual_foreign=sorted(tuple(r[2:]) for r in db.execute('PRAGMA foreign_key_list('+q(table)+')'))
        if actual_foreign!=foreign: report.issue('schema_foreign_key_definition_mismatch',table)
        actual_ddl=db.execute("SELECT sql FROM sqlite_schema WHERE name=? AND type='table'",(table,)).fetchone()[0]
        check_match=checks(actual_ddl)==expected_checks
        unique_match=unique_keys(db,table)==expected_uniques
        if not check_match: report.issue('schema_check_constraint_mismatch',table)
        if not unique_match: report.issue('schema_unique_constraint_mismatch',table)
        if actual==exp and actual_foreign==foreign and check_match and unique_match: report.schema_valid.add(table)
        report.counts[table]=db.execute('SELECT count(*) FROM '+q(table)).fetchone()[0]
    integrity_rows=list(db.execute('PRAGMA integrity_check'))
    report.issue('sqlite_integrity_failed',count=sum(r[0]!='ok' for r in integrity_rows))
    # PRAGMA returns row IDs and reference text; count without emitting either.
    report.issue('sqlite_foreign_key_violations',count=sum(1 for _ in db.execute('PRAGMA foreign_key_check')))


def reference_checks(db, inv, report):
    if 'users' not in report.schema_valid or 'videos' not in report.schema_valid: return
    for item in inv['tables']:
        table=item['table']; cols=item['source_schema']['columns']
        if table not in report.schema_valid: continue
        if 'user_id' in cols:
            allow_null=table in OPTIONAL_OWNER
            allowed=" AND t.user_id<>'anonymous'" if table=='streaming_analytics' else ''
            count=db.execute(f'SELECT count(*) FROM {q(table)} t LEFT JOIN users u ON u.id=t.user_id WHERE '+('t.user_id IS NOT NULL AND ' if allow_null else '')+'(u.id IS NULL OR t.user_id=\'legacy\')'+allowed).fetchone()[0]
            report.issue('owner_missing_or_legacy',table,count)
        if 'actor_id' in cols:
            report.issue('audit_actor_missing',table,db.execute(f'SELECT count(*) FROM {q(table)} t LEFT JOIN users u ON u.id=t.actor_id WHERE t.actor_id IS NOT NULL AND u.id IS NULL').fetchone()[0])
        for ref in ('video_id','recommended_lesson_id'):
            if ref not in cols: continue
            report.issue('lesson_reference_missing',table,db.execute(f'SELECT count(*) FROM {q(table)} t LEFT JOIN videos v ON v.id=t.{q(ref)} WHERE t.{q(ref)} IS NOT NULL AND v.id IS NULL').fetchone()[0])
            if 'course' in cols:
                report.issue('lesson_course_mismatch',table,db.execute(f'SELECT count(*) FROM {q(table)} t JOIN videos v ON v.id=t.{q(ref)} WHERE t.course IS NOT NULL AND t.course<>v.course').fetchone()[0])
        if 'lesson_id' in cols:
            report.issue('material_lesson_reference_missing',table,db.execute(f'SELECT count(*) FROM {q(table)} t LEFT JOIN videos v ON v.id=t.lesson_id WHERE t.lesson_id IS NOT NULL AND v.id IS NULL').fetchone()[0])
            if 'course' in cols:
                report.issue('material_lesson_course_mismatch',table,db.execute(f'SELECT count(*) FROM {q(table)} t JOIN videos v ON v.id=t.lesson_id WHERE t.course<>v.course').fetchone()[0])
        if table in OWNER_PARENTS:
            col,parent,key=OWNER_PARENTS[table]
            if parent in report.schema_valid:
                report.issue('cross_owner_parent_reference',table,db.execute(f'SELECT count(*) FROM {q(table)} t JOIN {q(parent)} p ON t.{q(col)}=p.{q(key)} WHERE t.user_id<>p.user_id').fetchone()[0])
    for table in ('native_totals','native_sessions'):
        if table in report.schema_valid:
            report.issue('source_duration_discrepancy',table,db.execute(f'SELECT count(*) FROM {q(table)} t JOIN videos v ON v.id=t.video_id WHERE v.duration IS NOT NULL AND v.duration>0 AND t.duration>0 AND abs(t.duration-v.duration)>max(1,v.duration*0.01)').fetchone()[0])
    if 'lesson_quizzes' in report.schema_valid:
        report.issue('multiple_quizzes_per_lesson', 'lesson_quizzes',db.execute('SELECT count(*) FROM (SELECT video_id FROM lesson_quizzes GROUP BY video_id HAVING count(*)>1)').fetchone()[0])
    if {'lesson_quizzes','lesson_quiz_attempts'}<=report.schema_valid:
        report.issue('quiz_attempt_lesson_mismatch','lesson_quiz_attempts',db.execute('SELECT count(*) FROM lesson_quiz_attempts a JOIN lesson_quizzes q ON q.id=a.quiz_id WHERE a.video_id<>q.video_id').fetchone()[0])


def validate_row(table, row, cols, report):
    parsed={}
    for col in cols:
        value=row[col]
        if value is None: continue
        if col.endswith('_json') or (table=='task_queue' and col in ('payload','result')):
            try:
                value=strict_json(value); parsed[col]=value
                expected=list if col in JSON_ARRAY_COLUMNS else dict
                if not isinstance(value,expected): report.issue('json_shape_invalid',table)
            except (ValueError,TypeError,RecursionError): report.issue('json_invalid',table)
        elif col=='expires_at' and table in ('activity_leases','native_leases','player_ownership'):
            if not number(value) or value<0: report.issue('numeric_time_or_count_invalid',table)
        elif col in TIMESTAMP_COLUMNS:
            try:
                dt=datetime.fromisoformat(value.replace('Z','+00:00'))
                if dt.tzinfo is None: report.issue('timestamp_timezone_ambiguous',table)
            except (ValueError,TypeError,AttributeError): report.issue('timestamp_invalid',table)
        elif col in DATE_COLUMNS:
            try:
                d=date.fromisoformat(value)
                if d.isoformat()!=value: raise ValueError('noncanonical')
                if col=='week_start' and d.weekday()!=0: report.issue('week_start_not_monday',table)
            except (ValueError,TypeError): report.issue('local_date_invalid',table)
        elif col in NUMERIC_COLUMNS:
            if not number(value) or value<0: report.issue('numeric_time_or_count_invalid',table)
        elif col=='tz_offset_minutes':
            if type(value)!=int or not -840<=value<=840: report.issue('timezone_offset_invalid',table)
        elif col in ('completed','passed','verified','suspended','autoplay','theater','removed','goal_met','reminder_email','closed','consumed','offline_fallback'):
            if type(value)!=int or value not in (0,1): report.issue('boolean_invalid',table)
    if table=='player_preferences' and (not number(row['speed']) or not .25<=row['speed']<=4): report.issue('playback_speed_invalid',table)
    if table=='chunks' and number(row['start']) and number(row['end']) and row['end']<row['start']: report.issue('source_interval_reversed',table)
    if table=='course_materials_meta':
        if row['scope'] not in ('course','lesson','section'): report.issue('material_scope_invalid',table)
        if row['scope']=='lesson' and not row['lesson_id']: report.issue('material_lesson_scope_without_lesson',table)
        name=row['filename']
        if not isinstance(name,str) or not name or '/' in name or '\\' in name or name in ('.','..') or '\x00' in name: report.issue('material_filename_unsafe',table)
    if table=='native_totals' and isinstance(parsed.get('ranges_json'),list):
        previous=-1
        for interval in parsed['ranges_json']:
            if not isinstance(interval,list) or len(interval)!=2 or not all(number(x) for x in interval) or interval[0]<0 or interval[1]<interval[0]: report.issue('coverage_interval_invalid',table); continue
            if interval[0]<previous: report.issue('coverage_overlap_or_order_invalid',table)
            if number(row['duration']) and row['duration']>0 and interval[1]>row['duration']+0.001: report.issue('coverage_exceeds_duration',table)
            previous=interval[1]
    if table=='lesson_quizzes' and isinstance(parsed.get('questions_json'),list):
        questions=parsed['questions_json']; seen=set()
        if not 1<=len(questions)<=20: report.issue('quiz_question_count_unsupported',table)
        for question in questions:
            if not isinstance(question,dict): report.issue('quiz_question_invalid',table); continue
            ident=question.get('id'); options=question.get('options'); correct=question.get('correct_index')
            if not isinstance(ident,str) or not ident or ident in seen: report.issue('quiz_question_id_invalid',table)
            else: seen.add(ident)
            if not isinstance(options,list) or not 2<=len(options)<=6 or not all(isinstance(x,str) for x in options) or type(correct)!=int or not 0<=correct<len(options): report.issue('quiz_answer_key_invalid',table)
            if 'source_start' in question and (not number(question['source_start']) or question['source_start']<0): report.issue('quiz_source_time_invalid',table)
    if table in ('lesson_quiz_attempts','topic_assessment_attempts'):
        total,correct,score=row['total_count'],row['correct_count'],row['score']
        if not all(type(x)==int for x in (total,correct,score)) or total<=0 or not 0<=correct<=total or not 0<=score<=100 or abs(score-round(correct/total*100))>1: report.issue('assessment_score_discrepancy',table)
    if table in ('focus_sessions','focus_intervals'):
        if table=='focus_sessions' and row['status']=='running': report.issue('active_focus_requires_freeze',table)
        if table=='focus_intervals' and row['ended_at'] is None: report.issue('open_focus_interval_requires_freeze',table)
        if table=='focus_intervals' and row['ended_at'] is not None:
            try:
                if datetime.fromisoformat(row['ended_at'].replace('Z','+00:00'))<datetime.fromisoformat(row['began_at'].replace('Z','+00:00')): report.issue('focus_interval_reversed',table)
            except (ValueError,TypeError,AttributeError): pass
    if table in ('task_queue','jobs') and row['status'] in ('running','processing'): report.issue('active_job_requires_worker_drain',table)
    return parsed


def json_reference_checks(db, parsed, table, report, deadline):
    pending=list(parsed.values()); examined=0
    while pending:
        examined+=1
        if examined>100000: report.issue('json_reference_size_unsupported',table); return
        if examined%1000==0 and time.monotonic()>deadline: raise TimeoutError('validation_budget_exceeded')
        value=pending.pop()
        if isinstance(value,list): pending.extend(value); continue
        if not isinstance(value,dict): continue
        pending.extend(value.values())
        lesson=value.get('video_id',value.get('lesson_id'))
        if lesson is not None and 'videos' in report.schema_valid:
            source=db.execute('SELECT course,duration FROM videos WHERE id=?',(lesson,)).fetchone() if isinstance(lesson,str) else None
            if source is None: report.issue('json_lesson_reference_missing',table)
            elif value.get('course') is not None and value['course']!=source['course']: report.issue('json_lesson_course_mismatch',table)
        chunk=value.get('chunk_id')
        if chunk is not None and 'chunks' in report.schema_valid:
            source=db.execute('SELECT video_id FROM chunks WHERE id=?',(chunk,)).fetchone() if isinstance(chunk,str) else None
            if source is None: report.issue('json_chunk_reference_missing',table)
            elif lesson is not None and lesson!=source['video_id']: report.issue('json_chunk_lesson_mismatch',table)


def row_checks(db, inv, report, deadline):
    for item in inv['tables']:
        table=item['table']
        if table not in report.schema_valid: continue
        cols=item['source_schema']['columns']; names=list(cols)
        # Exclude credential/account/address text that checks do not need.
        select_names=[c for c in names if c not in ('password_hash','token_hash','csrf_token','email','name','ip','device','question','answer','content','text','feedback','label','error')]
        cursor=db.execute('SELECT '+','.join(q(c) for c in select_names)+' FROM '+q(table))
        for row in cursor:
            if time.monotonic()>deadline: raise TimeoutError('validation_budget_exceeded')
            parsed=validate_row(table,row,select_names,report)
            json_reference_checks(db,parsed,table,report,deadline)
        count=report.counts.get(table,0)
        if count and item['policy']=='feature-migration':
            if not item.get('target_schema_exists'): report.issue('mapping_destination_missing',table)
            if item['unresolved_columns']: report.issue('mapping_source_fields_unmapped',table,len(item['unresolved_columns']))
            # No importer is invoked; even complete name matches are explicitly
            # candidate-needs-semantic-check in the inventory, not approved transforms.
            report.issue('mapping_semantics_unverified',table)
        if count and table in ('videos','chunks','course_materials_meta','course_metadata','lab_sessions'):
            report.issue('recovery_artifact_manifest_unverified',table)
        if count and table in ('videos','chunks'): report.issue('recovery_vector_generation_unverified',table)
    report.issue('mapping_importer_not_executed')


def preflight(raw: str, asserted: bool=False, inventory_path: Path=INVENTORY, timeout: float=30) -> dict:
    report=Report(); db=None
    try:
        snapshot=safe_snapshot(raw,asserted)
        before=snapshot.stat(); signature=(before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns)
        inv=json.loads(inventory_path.read_text())
        if inv.get('format_version')!=1: raise ValueError('inventory_format_unsupported')
        report.inventory_current=True
        for name,digest in inv['source_hashes'].items():
            if not re.fullmatch(r'(?:app|backend|scripts)/[A-Za-z0-9_./-]+|sync_paid_course_to_db\.py',name): raise ValueError('inventory_source_path_invalid')
            source=ROOT/name
            if not source.is_file() or hashlib.sha256(source.read_bytes()).hexdigest()!=digest: report.inventory_current=False; report.issue('inventory_source_stale'); break
        deadline=time.monotonic()+timeout
        # immutable prevents WAL/SHM/lock creation. Requiring absent sidecars
        # prevents silently ignoring uncheckpointed writes. The operator must
        # supply a consistent standalone backup after source writers are drained.
        uri='file:'+quote(str(snapshot),safe='/')+'?mode=ro&immutable=1'
        db=sqlite3.connect(uri,uri=True,timeout=1); db.row_factory=sqlite3.Row
        db.execute('PRAGMA query_only=ON'); db.execute('PRAGMA trusted_schema=OFF')
        db.set_progress_handler(lambda: int(time.monotonic()>deadline),10000)
        with db:
            validate_schema(db,inv,report)
            reference_checks(db,inv,report)
            row_checks(db,inv,report,deadline)
        after=snapshot.stat()
        if signature!=(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns): report.issue('snapshot_changed_during_preflight')
    except (OSError,ValueError,KeyError,TypeError,sqlite3.Error,TimeoutError) as exc:
        # Never emit paths, SQL, database error text or source values.
        allowed={'isolated_snapshot_assertion_required','snapshot_symlink_rejected','snapshot_regular_file_required','live_data_directory_rejected','live_database_alias_rejected','snapshot_sidecar_rejected','inventory_format_unsupported','inventory_source_path_invalid','validation_budget_exceeded'}
        code=str(exc) if isinstance(exc,(ValueError,TimeoutError)) and str(exc) in allowed else 'snapshot_validation_failed'
        if isinstance(exc,sqlite3.OperationalError) and getattr(exc,'sqlite_errorcode',None)==sqlite3.SQLITE_INTERRUPT: code='validation_budget_exceeded'
        report.issue(code)
    finally:
        if db is not None: db.close()
    return report.result()


def main() -> int:
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--snapshot',required=True,help='Explicit standalone isolated snapshot; never defaults to production')
    parser.add_argument('--isolated-snapshot',action='store_true',help='Assert the supplied path is an isolated, drained/consistent snapshot')
    parser.add_argument('--timeout-seconds',type=float,default=30,help='Bound validation work; interrupted checks fail closed')
    args=parser.parse_args()
    if not math.isfinite(args.timeout_seconds) or not 0<args.timeout_seconds<=600: parser.error('timeout must be finite and within (0,600]')
    result=preflight(args.snapshot,args.isolated_snapshot,timeout=args.timeout_seconds)
    print(json.dumps(result,sort_keys=True,indent=2))
    return 0 if result['migration_authorized'] else 1
if __name__=='__main__': raise SystemExit(main())
