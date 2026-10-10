"""Versioned, atomic upgrades of the original learning database."""
from pathlib import Path
import sqlite3
from .db import connect

PERSONAL_TABLES = (
    'video_progress', 'review_cards', 'review_attempts', 'video_notes',
    'lab_sessions', 'learning_paths', 'learning_path_completions',
    'topic_assessments', 'topic_assessment_attempts', 'practice_sessions',
    'practice_attempts', 'planner_preferences', 'daily_plans', 'daily_plan_items',
    'weekly_preferences', 'weekly_plans', 'focus_sessions', 'focus_intervals',
)

# Only keys that were global singletons/dates need rebuilding. Other IDs are
# already unique; path generation incorporates the owner after this upgrade.
REBUILDS = {
    'video_progress': '''user_id TEXT NOT NULL DEFAULT 'legacy',
        video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
        percent INTEGER NOT NULL DEFAULT 0 CHECK(percent BETWEEN 0 AND 100),
        position REAL NOT NULL DEFAULT 0, completed INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL, PRIMARY KEY(user_id,video_id)''',
    'planner_preferences': '''user_id TEXT NOT NULL DEFAULT 'legacy',
        singleton INTEGER NOT NULL CHECK(singleton=1), daily_minutes INTEGER NOT NULL DEFAULT 45,
        path_id TEXT REFERENCES learning_paths(id) ON DELETE SET NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(user_id,singleton)''',
    'daily_plans': '''user_id TEXT NOT NULL DEFAULT 'legacy', study_date TEXT NOT NULL,
        path_id TEXT REFERENCES learning_paths(id) ON DELETE SET NULL,
        budget_minutes INTEGER NOT NULL, tz_offset_minutes INTEGER NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(user_id,study_date)''',
    'daily_plan_items': '''user_id TEXT NOT NULL DEFAULT 'legacy', id TEXT PRIMARY KEY,
        study_date TEXT NOT NULL, item_key TEXT NOT NULL, kind TEXT NOT NULL,
        title TEXT NOT NULL, description TEXT NOT NULL, minutes INTEGER NOT NULL,
        action_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','done','skipped')), updated_at TEXT NOT NULL,
        actual_minutes INTEGER NOT NULL DEFAULT 0 CHECK(actual_minutes BETWEEN 0 AND 600),
        UNIQUE(user_id,study_date,item_key),
        FOREIGN KEY(user_id,study_date) REFERENCES daily_plans(user_id,study_date) ON DELETE CASCADE''',
    'weekly_preferences': '''user_id TEXT NOT NULL DEFAULT 'legacy',
        singleton INTEGER NOT NULL CHECK(singleton=1), minutes_json TEXT NOT NULL,
        updated_at TEXT NOT NULL, PRIMARY KEY(user_id,singleton)''',
    'weekly_plans': '''user_id TEXT NOT NULL DEFAULT 'legacy', week_start TEXT NOT NULL,
        tz_offset_minutes INTEGER NOT NULL, minutes_json TEXT NOT NULL, forecast_json TEXT NOT NULL,
        path_id TEXT REFERENCES learning_paths(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        unscheduled_reviews INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_id,week_start)''',
}

SCHEMA = '''
CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE COLLATE NOCASE,
 name TEXT NOT NULL,password_hash TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'student'
 CHECK(role IN ('student','admin')),verified INTEGER NOT NULL DEFAULT 0,
 suspended INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
CREATE TABLE auth_sessions(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 token_hash TEXT NOT NULL UNIQUE,csrf_token TEXT NOT NULL,created_at TEXT NOT NULL,
 expires_at TEXT NOT NULL,last_seen TEXT NOT NULL,device TEXT NOT NULL,ip TEXT NOT NULL);
CREATE INDEX auth_session_user ON auth_sessions(user_id);
CREATE TABLE account_tokens(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 kind TEXT NOT NULL,expires_at TEXT NOT NULL);
CREATE TABLE rate_limits(key TEXT PRIMARY KEY,count INTEGER NOT NULL,reset_at REAL NOT NULL);
CREATE TABLE course_publication(course TEXT PRIMARY KEY,published INTEGER NOT NULL DEFAULT 0,
 description TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL);
CREATE TABLE enrollments(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 course TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(user_id,course));
CREATE TABLE playback_sessions(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 auth_session_id TEXT NOT NULL REFERENCES auth_sessions(id) ON DELETE CASCADE,
 video_id TEXT NOT NULL REFERENCES videos(id),token_hash TEXT NOT NULL UNIQUE,
 expires_at TEXT NOT NULL,consumed INTEGER NOT NULL DEFAULT 0);
CREATE TABLE lecture_providers(video_id TEXT PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
 claim_name TEXT NOT NULL,claim_id TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE activity_sessions(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 auth_session_id TEXT NOT NULL,
 video_id TEXT NOT NULL REFERENCES videos(id),last_sequence INTEGER NOT NULL DEFAULT 0,
 last_heartbeat REAL NOT NULL,activity_seconds REAL NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
CREATE INDEX activity_user ON activity_sessions(user_id,last_heartbeat);
CREATE TABLE activity_leases(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,activity_id TEXT NOT NULL,expires_at REAL NOT NULL);
CREATE TABLE learning_events(id INTEGER PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 video_id TEXT,event_type TEXT NOT NULL,details TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL);
CREATE INDEX learning_event_user ON learning_events(user_id,created_at);
CREATE TABLE access_events(id INTEGER PRIMARY KEY,user_id TEXT,event_type TEXT NOT NULL,
 ip TEXT NOT NULL,device TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE INDEX access_event_date ON access_events(created_at);
CREATE TABLE lesson_visits(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 course TEXT NOT NULL,video_id TEXT NOT NULL REFERENCES videos(id),updated_at TEXT NOT NULL,
 PRIMARY KEY(user_id,course));
CREATE TABLE bookmarks(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 video_id TEXT NOT NULL REFERENCES videos(id),position REAL NOT NULL,label TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE INDEX bookmarks_user ON bookmarks(user_id,video_id);
CREATE TABLE task_queue(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 kind TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',result TEXT,error TEXT,
 created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE INDEX task_queue_status ON task_queue(status,created_at);
'''


def migrate(path: Path | None = None) -> None:
    with connect(path) as db:
        db.execute('CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL)')
        if db.execute('SELECT 1 FROM schema_migrations WHERE version=1').fetchone():
            migrate_console(db)
            migrate_player(db)
            return
        # Foreign keys are checked before commit; rebuilding a parent must not
        # cascade-delete its existing children in the middle of the transaction.
        db.execute('PRAGMA foreign_keys=OFF')
        db.execute('BEGIN IMMEDIATE')
        try:
            for table in PERSONAL_TABLES:
                if table in REBUILDS:
                    db.execute(f'CREATE TABLE upgrade_{table}({REBUILDS[table]})')
                    columns = [r['name'] for r in db.execute(f'PRAGMA table_info({table})')]
                    names = ','.join(columns)
                    db.execute(f'INSERT INTO upgrade_{table}({names}) SELECT {names} FROM {table}')
                    db.execute(f'DROP TABLE {table}')
                    db.execute(f'ALTER TABLE upgrade_{table} RENAME TO {table}')
                else:
                    db.execute(f"ALTER TABLE {table} ADD COLUMN user_id TEXT NOT NULL DEFAULT 'legacy'")
                db.execute(f'CREATE INDEX {table}_owner_idx ON {table}(user_id)')
            db.execute('DROP INDEX IF EXISTS focus_running_unique')
            db.execute("CREATE UNIQUE INDEX focus_running_unique ON focus_sessions(user_id) WHERE status='running'")
            db.execute('CREATE INDEX daily_plan_items_date ON daily_plan_items(user_id,study_date)')
            for sql in SCHEMA.split(';'):
                if sql.strip():
                    db.execute(sql)
            if db.execute('PRAGMA foreign_key_check').fetchone():
                raise sqlite3.IntegrityError('Existing data failed foreign-key validation')
            db.execute("INSERT INTO schema_migrations VALUES(1,strftime('%Y-%m-%dT%H:%M:%SZ','now'))")
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.execute('PRAGMA foreign_keys=ON')
        migrate_console(db)
        migrate_player(db)


def migrate_console(db):
    """Keep durable learning totals while retaining detailed sessions for 90 days."""
    if db.execute('SELECT 1 FROM schema_migrations WHERE version=2').fetchone():
        return
    db.execute('BEGIN IMMEDIATE')
    try:
        db.execute("ALTER TABLE activity_sessions ADD COLUMN device TEXT NOT NULL DEFAULT ''")
        db.execute("ALTER TABLE activity_sessions ADD COLUMN ip TEXT NOT NULL DEFAULT ''")
        db.execute('ALTER TABLE activity_sessions ADD COLUMN closed INTEGER NOT NULL DEFAULT 0')
        db.execute('''UPDATE activity_sessions SET device=COALESCE((SELECT device FROM auth_sessions s
            WHERE s.id=activity_sessions.auth_session_id),''),ip=COALESCE((SELECT ip FROM auth_sessions s
            WHERE s.id=activity_sessions.auth_session_id),'')''')
        db.execute('''CREATE TABLE lesson_activity_totals(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,activity_seconds REAL NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL,PRIMARY KEY(user_id,video_id))''')
        db.execute('''INSERT INTO lesson_activity_totals SELECT user_id,video_id,SUM(activity_seconds),MAX(created_at)
            FROM activity_sessions GROUP BY user_id,video_id''')
        db.execute('''CREATE TABLE admin_audit(id INTEGER PRIMARY KEY,actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
            action TEXT NOT NULL,resource TEXT NOT NULL,created_at TEXT NOT NULL)''')
        db.execute('CREATE INDEX admin_audit_date ON admin_audit(created_at)')
        db.execute('''CREATE TABLE service_checks(name TEXT PRIMARY KEY,last_attempt TEXT NOT NULL,
            last_success TEXT,summary_json TEXT NOT NULL DEFAULT '{}',last_error TEXT NOT NULL DEFAULT '')''')
        db.execute('CREATE INDEX activity_date ON activity_sessions(created_at)')
        db.execute("INSERT INTO schema_migrations VALUES(2,strftime('%Y-%m-%dT%H:%M:%SZ','now'))")
        db.commit()
    except BaseException:
        db.rollback()
        raise



def migrate_player(db):
    if db.execute('SELECT 1 FROM schema_migrations WHERE version=3').fetchone():return
    db.execute('BEGIN IMMEDIATE')
    try:
        db.execute('''CREATE TABLE native_sessions(id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            auth_session_id TEXT NOT NULL,video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
            token_hash TEXT NOT NULL UNIQUE,expires_at TEXT NOT NULL,created_at TEXT NOT NULL,
            device TEXT NOT NULL,ip TEXT NOT NULL,last_sequence INTEGER NOT NULL DEFAULT 0,
            last_heartbeat REAL NOT NULL,position REAL NOT NULL DEFAULT 0,duration REAL NOT NULL DEFAULT 0,
            state TEXT NOT NULL DEFAULT 'ready',playing_seconds REAL NOT NULL DEFAULT 0,
            closed INTEGER NOT NULL DEFAULT 0)''')
        db.execute('CREATE INDEX native_session_date ON native_sessions(created_at)')
        db.execute('''CREATE TABLE native_leases(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            session_id TEXT NOT NULL,expires_at REAL NOT NULL)''')
        db.execute('''CREATE TABLE native_totals(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
            playing_seconds REAL NOT NULL DEFAULT 0,position REAL NOT NULL DEFAULT 0,
            duration REAL NOT NULL DEFAULT 0,ranges_json TEXT NOT NULL DEFAULT '[]',updated_at TEXT NOT NULL,
            PRIMARY KEY(user_id,video_id))''')
        db.execute("INSERT INTO schema_migrations VALUES(3,strftime('%Y-%m-%dT%H:%M:%SZ','now'))")
        db.commit()
    except BaseException:
        db.rollback()
        raise
