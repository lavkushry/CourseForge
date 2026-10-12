"""Synthetic source-snapshot tests; never import application modules or live data."""
import importlib.util
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import os

ROOT=Path(__file__).resolve().parents[1]
SPEC=importlib.util.spec_from_file_location('rewrite_preflight',ROOT/'scripts/rewrite_migration_preflight.py')
PREFLIGHT=importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(PREFLIGHT)
INVENTORY=json.loads((ROOT/'docs/rewrite/MIGRATION_INVENTORY.json').read_text())
NOW='2026-10-12T10:00:00Z'
CANARY='PRIVATE_CANARY_QUESTION_EMAIL_IP_PASSWORD_TOKEN_NEVER_REPORT'


class PreflightTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='courseforge-preflight-synthetic-')
        self.addCleanup(self.temp.cleanup)
        self.path=Path(self.temp.name)/'synthetic.sqlite3'
        self.db=sqlite3.connect(self.path)
        self.addCleanup(self.db.close)
        for row in INVENTORY['tables']:
            name=row['table']; s=row['source_schema']; columns=s['columns']; order=s['column_order']
            if s['virtual']:
                sql='CREATE VIRTUAL TABLE '+PREFLIGHT.q(name)+' USING fts5('+','.join(PREFLIGHT.q(c)+' '+columns[c] for c in order)+')'
            else:
                sql='CREATE TABLE '+PREFLIGHT.q(name)+'('+','.join([PREFLIGHT.q(c)+' '+columns[c] for c in order]+s['constraints'])+')'
            self.db.execute(sql)
            for index in s.get('indexes',[]):
                if not index['unique']: continue
                # Only source-derived explicit unique indexes (focus ownership)
                # are needed beyond inline constraints in these empty fixtures.
                text=index['columns_and_predicate']
                tail=text if ')' in text else text+')'
                self.db.execute('CREATE UNIQUE INDEX '+PREFLIGHT.q(index['name'])+' ON '+PREFLIGHT.q(name)+'('+tail)
        self.db.commit()
    def insert(self,table,**values):
        self.db.execute('INSERT INTO '+PREFLIGHT.q(table)+'('+','.join(PREFLIGHT.q(c) for c in values)+') VALUES('+','.join('?' for _ in values)+')',tuple(values.values())); self.db.commit()
    def user(self,uid='synthetic-owner'):
        self.insert('users',id=uid,email=uid+'@example.test',name=CANARY,password_hash=CANARY,role='student',verified=1,suspended=0,created_at=NOW)
    def video(self,vid='synthetic-lesson',course='synthetic-course'):
        self.insert('videos',id=vid,path='/synthetic/'+vid+'.mp4',course=course,title=CANARY,bytes=1000,mtime_ns=1234,status='done',duration=100,created_at=NOW)
    def report(self): return PREFLIGHT.preflight(str(self.path),True)
    def codes(self,report=None): return {d['code'] for d in (report or self.report())['diagnostics']}
    def test_full_empty_snapshot_structure_valid_but_migration_unproven(self):
        r=self.report(); self.assertTrue(r['snapshot_checks_passed'],r['diagnostics']); self.assertFalse(r['migration_authorized']); self.assertEqual(r['postgresql_writes'],0); self.assertEqual(len(r['row_counts']),67); self.assertIn('mapping_importer_not_executed',self.codes(r))
    def test_read_only_and_deterministic(self):
        self.user(); self.video(); before=self.path.read_bytes(); first=self.report(); second=self.report()
        self.assertEqual(first,second); self.assertEqual(self.path.read_bytes(),before); self.assertFalse(Path(str(self.path)+'-wal').exists()); self.assertFalse(Path(str(self.path)+'-shm').exists())
    def test_explicit_isolation_required_and_symlink_rejected(self):
        self.assertIn('isolated_snapshot_assertion_required',self.codes(PREFLIGHT.preflight(str(self.path))))
        alias=Path(self.temp.name)/'alias'; alias.symlink_to(self.path)
        self.assertIn('snapshot_symlink_rejected',self.codes(PREFLIGHT.preflight(str(alias),True)))
    def test_sidecar_rejected_before_database_read(self):
        Path(str(self.path)+'-wal').write_bytes(b'not a valid standalone snapshot')
        self.assertIn('snapshot_sidecar_rejected',self.codes())
    def test_unknown_table_and_column_are_hard_failures_without_identifiers(self):
        self.db.execute('CREATE TABLE "PRIVATE_CANARY_QUESTION_EMAIL_IP_PASSWORD_TOKEN_NEVER_REPORT"(private TEXT)'); self.db.execute('ALTER TABLE users ADD COLUMN "private-canary" TEXT'); self.db.commit()
        r=self.report(); self.assertFalse(r['snapshot_checks_passed']); self.assertIn('unknown_tables',self.codes(r)); self.assertIn('unknown_columns',self.codes(r)); self.assertNotIn(CANARY,json.dumps(r))
    def test_missing_table(self):
        self.db.execute('DROP TABLE placement_tests'); self.db.commit(); self.assertIn('missing_table',self.codes())
    def test_constraint_drift_rejected(self):
        self.db.execute('PRAGMA writable_schema=ON'); self.db.execute("UPDATE sqlite_schema SET sql=replace(sql,'CHECK(percent BETWEEN 0 AND 100)','CHECK(percent BETWEEN 0 AND 99)') WHERE name='video_progress'"); self.db.execute('PRAGMA writable_schema=OFF'); self.db.commit()
        self.assertIn('schema_check_constraint_mismatch',self.codes())
    def test_owner_and_dangling_reference_checks(self):
        self.video(); self.insert('video_progress',user_id='legacy',video_id='synthetic-lesson',percent=1,position=1,completed=0,updated_at=NOW)
        self.insert('bookmarks',id='fixture-bookmark',user_id='missing-owner',video_id='missing-lesson',position=0,label=CANARY,created_at=NOW)
        codes=self.codes(); self.assertIn('owner_missing_or_legacy',codes); self.assertIn('lesson_reference_missing',codes); self.assertIn('sqlite_foreign_key_violations',codes)
    def test_cross_owner_review_parent(self):
        self.user(); self.user('other-owner'); self.video()
        self.insert('review_cards',id='card',course='synthetic-course',video_id='synthetic-lesson',question=CANARY,answer=CANARY,due_at=NOW,created_at=NOW,user_id='synthetic-owner')
        self.insert('review_attempts',card_id='card',quality=3,reviewed_at=NOW,user_id='other-owner')
        self.assertIn('cross_owner_parent_reference',self.codes())
    def test_json_and_timestamp_validity_no_values_emitted(self):
        self.user(); self.video(); self.insert('syllabi',course='synthetic-course',content_json=CANARY,generated_at=CANARY,source_fingerprint=CANARY)
        r=self.report(); self.assertIn('json_invalid',self.codes(r)); self.assertIn('timestamp_invalid',self.codes(r)); self.assertNotIn(CANARY,json.dumps(r))
    def test_nonfinite_json_and_scalar_shape(self):
        self.user(); self.insert('learning_paths',id='p',goal=CANARY,courses_json='[NaN]',content_json='[]',source_fingerprint=CANARY,updated_at=NOW,user_id='synthetic-owner')
        self.assertIn('json_invalid',self.codes()); self.assertIn('json_shape_invalid',self.codes())
    def test_coverage_and_duration_are_separate_hazards(self):
        self.user(); self.video(); self.insert('native_totals',user_id='synthetic-owner',video_id='synthetic-lesson',playing_seconds=12,position=12,duration=150,ranges_json='[[0,20],[10,30],[149,160]]',updated_at=NOW)
        codes=self.codes(); self.assertIn('coverage_overlap_or_order_invalid',codes); self.assertIn('coverage_exceeds_duration',codes); self.assertIn('source_duration_discrepancy',codes); self.assertIn('mapping_source_fields_unmapped',codes)
    def test_material_scope_course_and_filename(self):
        self.user(); self.video()
        self.insert('course_materials_meta',id='m',course='other-course',filename='../private',scope='lesson',updated_at=NOW)
        codes=self.codes(); self.assertIn('material_lesson_scope_without_lesson',codes); self.assertIn('material_filename_unsafe',codes)
        self.db.execute("UPDATE course_materials_meta SET lesson_id='synthetic-lesson'"); self.db.commit(); self.assertIn('material_lesson_course_mismatch',self.codes())
    def test_duplicate_quizzes_and_invalid_keys(self):
        self.user(); self.video()
        question={'id':'q','question':CANARY,'options':['a','b'],'correct_index':9,'source_start':-1}
        for ident in ('q1','q2'): self.insert('lesson_quizzes',id=ident,video_id='synthetic-lesson',course='synthetic-course',questions_json=json.dumps([question]),created_at=NOW,status='approved')
        codes=self.codes(); self.assertIn('multiple_quizzes_per_lesson',codes); self.assertIn('quiz_answer_key_invalid',codes); self.assertIn('quiz_source_time_invalid',codes)
    def test_quiz_attempt_score_and_lesson_mismatch(self):
        self.user(); self.video(); self.video('another-lesson')
        self.insert('lesson_quizzes',id='quiz',video_id='synthetic-lesson',course='synthetic-course',questions_json='[{"id":"q","options":["a","b"],"correct_index":0}]',created_at=NOW,status='approved')
        self.insert('lesson_quiz_attempts',id='a',user_id='synthetic-owner',video_id='another-lesson',quiz_id='quiz',score=100,correct_count=0,total_count=1,passed=1,answers_json='{}',completed_at=NOW)
        self.assertIn('assessment_score_discrepancy',self.codes()); self.assertIn('quiz_attempt_lesson_mismatch',self.codes())
    def test_active_work_and_open_focus_require_freeze(self):
        self.user(); self.video(); self.insert('task_queue',id='job',user_id='synthetic-owner',kind='ask',payload='{}',status='running',created_at=NOW,updated_at=NOW)
        self.insert('focus_sessions',id='focus',mode='focus',status='running',duration_seconds=60,title=CANARY,created_at=NOW,updated_at=NOW,user_id='synthetic-owner')
        self.insert('focus_intervals',session_id='focus',began_at=NOW,user_id='synthetic-owner')
        codes=self.codes(); self.assertIn('active_job_requires_worker_drain',codes); self.assertIn('active_focus_requires_freeze',codes); self.assertIn('open_focus_interval_requires_freeze',codes)
    def test_naive_timestamp_weekday_offset(self):
        self.user(); self.insert('weekly_plans',user_id='synthetic-owner',week_start='2026-10-13',tz_offset_minutes=900,minutes_json='[0,0,0,0,0,0,0]',forecast_json='[]',created_at='2026-10-12T10:00:00',updated_at=NOW)
        codes=self.codes(); self.assertIn('timestamp_timezone_ambiguous',codes); self.assertIn('week_start_not_monday',codes); self.assertIn('timezone_offset_invalid',codes)
    def test_cli_never_exports_private_values_or_path_and_exits_blocked(self):
        self.user(); self.video()
        command=[sys.executable,str(ROOT/'scripts/rewrite_migration_preflight.py'),'--snapshot',str(self.path),'--isolated-snapshot']
        run=subprocess.run(command,text=True,capture_output=True,check=False)
        self.assertEqual(run.returncode,1); result=json.loads(run.stdout); self.assertFalse(result['migration_authorized']); self.assertNotIn(CANARY,run.stdout+run.stderr); self.assertNotIn(str(self.path),run.stdout+run.stderr)
    def test_known_live_directory_and_hardlink_alias_rejected(self):
        fake_root=Path(self.temp.name)/'fake-repository'; data=fake_root/'data'; data.mkdir(parents=True)
        live=data/'courseforge.sqlite3'; live.write_bytes(b'synthetic marker, not live data')
        alias=Path(self.temp.name)/'hardlink-snapshot'; os.link(live,alias)
        with patch.object(PREFLIGHT,'ROOT',fake_root):
            self.assertIn('live_data_directory_rejected',self.codes(PREFLIGHT.preflight(str(live),True)))
            self.assertIn('live_database_alias_rejected',self.codes(PREFLIGHT.preflight(str(alias),True)))
    def test_duplicate_json_keys_and_nested_citations_rejected(self):
        self.user(); self.video()
        self.insert('syllabi',course='synthetic-course',content_json='{"topics":[{"video_id":"missing-lesson","chunk_id":"missing-chunk"}]}',generated_at=NOW,source_fingerprint=CANARY)
        codes=self.codes(); self.assertIn('json_lesson_reference_missing',codes); self.assertIn('json_chunk_reference_missing',codes)
        self.db.execute("UPDATE syllabi SET content_json=?",('{"topics":[],"topics":[]}',)); self.db.commit(); self.assertIn('json_invalid',self.codes())
    def test_real_epoch_lease_times_are_valid(self):
        self.user(); self.insert('activity_leases',user_id='synthetic-owner',activity_id='old-session',expires_at=1728640800.0)
        self.assertNotIn('timestamp_invalid',self.codes())
    def test_budget_exhaustion_fails_closed(self):
        self.assertIn('validation_budget_exceeded',self.codes(PREFLIGHT.preflight(str(self.path),True,timeout=-1)))

if __name__=='__main__': unittest.main()
