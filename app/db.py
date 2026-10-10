"""SQLite metadata and durable single-worker queue."""
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

from .config import settings


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


@contextmanager
def connect(path: Path | None = None) -> Iterator[sqlite3.Connection]:
    db_path = path or settings.db_path
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path), timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA foreign_keys = ON')
    conn.execute('PRAGMA busy_timeout = 30000')
    try:
        yield conn
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db(path: Path | None = None) -> None:
    with connect(path) as conn:
        conn.execute('PRAGMA journal_mode = WAL')
        conn.executescript('''
        CREATE TABLE IF NOT EXISTS videos (
            id TEXT PRIMARY KEY,
            path TEXT NOT NULL UNIQUE,
            course TEXT NOT NULL,
            title TEXT NOT NULL,
            bytes INTEGER NOT NULL,
            mtime_ns INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'queued',
            error TEXT,
            duration REAL,
            language TEXT,
            indexed_at TEXT,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS jobs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            video_id TEXT NOT NULL REFERENCES videos(id),
            status TEXT NOT NULL DEFAULT 'queued',
            stage TEXT NOT NULL DEFAULT 'Queued',
            attempt INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs(status, id);
        CREATE TABLE IF NOT EXISTS chunks (
            id TEXT PRIMARY KEY,
            video_id TEXT NOT NULL REFERENCES videos(id),
            kind TEXT NOT NULL,
            start REAL NOT NULL,
            end REAL NOT NULL,
            text TEXT NOT NULL,
            frame_path TEXT
        );
        CREATE INDEX IF NOT EXISTS chunks_video_idx ON chunks(video_id);
        CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(chunk_id UNINDEXED, text);
        ''')
    # Learning schema is idempotent and runs on upgrades without losing existing lectures.
    from .course_metadata import ensure_schema as ensure_course_schema
    ensure_course_schema(path)
    from .study import ensure_schema
    ensure_schema(path)
    from .labs import ensure_schema as ensure_lab_schema
    ensure_lab_schema(path)
    from .learning_paths import ensure_schema as ensure_path_schema
    ensure_path_schema(path)
    from .assessments import ensure_schema as ensure_assessment_schema
    ensure_assessment_schema(path)
    from .practice import ensure_schema as ensure_practice_schema
    ensure_practice_schema(path)
    from .planner import ensure_schema as ensure_planner_schema
    ensure_planner_schema(path)
    from .weekly import ensure_schema as ensure_weekly_schema
    ensure_weekly_schema(path)
    from .focus import ensure_schema as ensure_focus_schema
    ensure_focus_schema(path)


def fetch_videos(path: Path | None = None) -> list[dict]:
    with connect(path) as conn:
        rows = conn.execute('''SELECT v.*, (SELECT COUNT(*) FROM chunks c WHERE c.video_id=v.id) AS chunk_count
                               FROM videos v ORDER BY course COLLATE NOCASE, title COLLATE NOCASE''').fetchall()
        return [dict(row) for row in rows]


def fetch_video(video_id: str, path: Path | None = None) -> dict | None:
    with connect(path) as conn:
        row = conn.execute('SELECT * FROM videos WHERE id=?', (video_id,)).fetchone()
        return dict(row) if row else None


def fetch_jobs(path: Path | None = None) -> list[dict]:
    with connect(path) as conn:
        rows = conn.execute('''SELECT j.*, v.title, v.course FROM jobs j JOIN videos v ON v.id=j.video_id
                               ORDER BY j.id DESC LIMIT 150''').fetchall()
        return [dict(row) for row in rows]


def queue_video(video_id: str, path: Path | None = None) -> bool:
    with connect(path) as conn:
        row = conn.execute('SELECT id FROM videos WHERE id=?', (video_id,)).fetchone()
        if not row:
            return False
        existing = conn.execute('''SELECT id FROM jobs WHERE video_id=? AND status IN ('queued','processing')''',
                                (video_id,)).fetchone()
        if existing:
            return False
        now = utcnow()
        conn.execute('INSERT INTO jobs(video_id,status,stage,created_at,updated_at) VALUES (?, ?, ?, ?, ?)',
                     (video_id, 'queued', 'Queued', now, now))
        conn.execute("UPDATE videos SET status='queued', error=NULL WHERE id=?", (video_id,))
        return True


def claim_job(path: Path | None = None) -> dict | None:
    """Atomic claim; designed for one worker; sqlite protects against duplicate claims."""
    with connect(path) as conn:
        conn.execute('BEGIN IMMEDIATE')
        row = conn.execute("SELECT * FROM jobs WHERE status='queued' ORDER BY id LIMIT 1").fetchone()
        if not row:
            return None
        now = utcnow()
        conn.execute("UPDATE jobs SET status='processing', stage='Starting', attempt=attempt+1, updated_at=? WHERE id=?",
                     (now, row['id']))
        conn.execute("UPDATE videos SET status='processing', error=NULL WHERE id=?", (row['video_id'],))
        return dict(row)


def stage(job_id: int, label: str, path: Path | None = None) -> None:
    with connect(path) as conn:
        conn.execute('UPDATE jobs SET stage=?,updated_at=? WHERE id=?', (label[:120], utcnow(), job_id))


def finish_job(job_id: int, video_id: str, error: str | None = None, *, path: Path | None = None,
               language: str | None = None, duration: float | None = None) -> None:
    now = utcnow()
    with connect(path) as conn:
        if error:
            conn.execute("UPDATE jobs SET status='failed',stage=?,updated_at=? WHERE id=?", ('Failed', now, job_id))
            conn.execute("UPDATE videos SET status='failed',error=? WHERE id=?", (error[:2000], video_id))
        else:
            conn.execute("UPDATE jobs SET status='done',stage='Completed',updated_at=? WHERE id=?", (now, job_id))
            conn.execute('''UPDATE videos SET status='done',error=NULL,indexed_at=?,language=?,duration=?
                            WHERE id=?''', (now, language, duration, video_id))


def resume_interrupted(path: Path | None = None) -> int:
    """Run only when starting the single worker (not while another worker exists)."""
    with connect(path) as conn:
        rows = conn.execute("SELECT id,video_id FROM jobs WHERE status='processing'").fetchall()
        for row in rows:
            conn.execute("UPDATE jobs SET status='queued',stage='Resumed after restart',updated_at=? WHERE id=?",
                         (utcnow(), row['id']))
            conn.execute("UPDATE videos SET status='queued' WHERE id=?", (row['video_id'],))
        return len(rows)


def replace_chunks(video_id: str, chunks: list[dict], path: Path | None = None) -> None:
    with connect(path) as conn:
        old = conn.execute('SELECT id FROM chunks WHERE video_id=?', (video_id,)).fetchall()
        conn.executemany('DELETE FROM chunk_fts WHERE chunk_id=?', [(r['id'],) for r in old])
        conn.execute('DELETE FROM chunks WHERE video_id=?', (video_id,))
        conn.executemany('''INSERT INTO chunks(id,video_id,kind,start,end,text,frame_path)
                            VALUES (:id,:video_id,:kind,:start,:end,:text,:frame_path)''', chunks)
        conn.executemany('INSERT INTO chunk_fts(chunk_id,text) VALUES (?,?)',
                         [(c['id'], c['text']) for c in chunks if c['text'].strip()])


def frame_for_chunk(chunk_id: str, path: Path | None = None) -> str | None:
    with connect(path) as conn:
        row = conn.execute('SELECT frame_path FROM chunks WHERE id=?', (chunk_id,)).fetchone()
        return row['frame_path'] if row else None


def transcript_for_video(video_id: str, path: Path | None = None) -> list[dict]:
    with connect(path) as conn:
        return [dict(r) for r in conn.execute('''SELECT id,kind,start,end,text,frame_path FROM chunks
                                                WHERE video_id=? ORDER BY start,kind''', (video_id,))]


def keyword_search(phrase: str, *, course: str | None = None, video_id: str | None = None,
                   limit: int = 8, path: Path | None = None) -> list[dict]:
    # Safely turn user text into FTS5 quoted terms; never interpret query operators.
    words = [w.replace('"', '') for w in phrase.split() if w.replace('"', '').strip()]
    if not words:
        return []
    query = ' OR '.join('"' + w + '"' for w in words[:12])
    sql = '''SELECT c.*,v.title,v.course, bm25(chunk_fts) AS rank
             FROM chunk_fts JOIN chunks c ON c.id=chunk_fts.chunk_id
             JOIN videos v ON v.id=c.video_id WHERE chunk_fts MATCH ?'''
    params: list = [query]
    if course:
        sql += ' AND v.course=?'
        params.append(course)
    if video_id:
        sql += ' AND c.video_id=?'
        params.append(video_id)
    sql += ' ORDER BY rank LIMIT ?'
    params.append(limit)
    with connect(path) as conn:
        return [dict(r) for r in conn.execute(sql, params)]
