"""Learner state, review scheduling (SM-2), and progress; no external accounts required."""
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4
from .db import connect, utcnow


def ensure_schema(path: Path | None = None) -> None:
    with connect(path) as db:
        db.executescript('''
        CREATE TABLE IF NOT EXISTS video_progress(
          video_id TEXT PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
          percent INTEGER NOT NULL DEFAULT 0 CHECK(percent BETWEEN 0 AND 100),
          position REAL NOT NULL DEFAULT 0,
          completed INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS review_cards(
          id TEXT PRIMARY KEY, course TEXT NOT NULL, video_id TEXT REFERENCES videos(id),
          question TEXT NOT NULL, answer TEXT NOT NULL, source_start REAL NOT NULL DEFAULT 0,
          repetitions INTEGER NOT NULL DEFAULT 0, interval_days INTEGER NOT NULL DEFAULT 0,
          ease REAL NOT NULL DEFAULT 2.5, due_at TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS review_due_idx ON review_cards(due_at,course);
        CREATE TABLE IF NOT EXISTS review_attempts(
          id INTEGER PRIMARY KEY AUTOINCREMENT, card_id TEXT NOT NULL REFERENCES review_cards(id),
          quality INTEGER NOT NULL CHECK(quality BETWEEN 0 AND 5), reviewed_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS video_notes(
          id TEXT PRIMARY KEY,video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
          position REAL NOT NULL DEFAULT 0,content TEXT NOT NULL,created_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS notes_video_idx ON video_notes(video_id,created_at);
        CREATE TABLE IF NOT EXISTS syllabi(
          course TEXT PRIMARY KEY, content_json TEXT NOT NULL,
          generated_at TEXT NOT NULL, source_fingerprint TEXT NOT NULL);
        ''')


def set_progress(video_id: str, *, percent: int, position: float, path: Path | None = None) -> dict:
    if not 0 <= percent <= 100 or not 0 <= position < 1e9:
        raise ValueError('Invalid progress')
    with connect(path) as db:
        if not db.execute('SELECT 1 FROM videos WHERE id=?', (video_id,)).fetchone():
            raise KeyError(video_id)
        db.execute('''INSERT INTO video_progress(user_id,video_id,percent,position,completed,updated_at)
                      VALUES(cf_user_id(),?,?,?,?,?) ON CONFLICT(user_id,video_id) DO UPDATE SET
                      percent=excluded.percent,position=excluded.position,
                      completed=excluded.completed,updated_at=excluded.updated_at''',
                   (video_id, percent, position, int(percent == 100), utcnow()))
    return {'video_id': video_id, 'percent': percent, 'position': position, 'completed': percent == 100}


def get_progress(course: str | None = None, path: Path | None = None) -> list[dict]:
    with connect(path) as db:
        sql = '''SELECT v.id AS video_id,v.course,v.title,COALESCE(p.percent,0) AS percent,
                        COALESCE(p.position,0) AS position,COALESCE(p.completed,0) AS completed,
                        p.updated_at AS updated_at
                 FROM videos v LEFT JOIN video_progress p ON p.video_id=v.id AND p.user_id=cf_user_id() WHERE cf_course_allowed(v.course)'''
        params = []
        if course:
            sql += ' AND v.course=?'
            params.append(course)
        return [dict(row) for row in db.execute(sql+' ORDER BY v.course,v.title', params)]


def add_cards(course: str, cards: list[dict], path: Path | None = None) -> list[dict]:
    """Store model-authored but validated questions with a source timestamp."""
    now = utcnow()
    output = []
    with connect(path) as db:
        for card in cards[:20]:
            video_id = card.get('video_id')
            matching = db.execute('SELECT 1 FROM videos WHERE id=? AND course=?', (video_id, course)).fetchone()
            if not matching:
                raise ValueError('Review card source must belong to the selected course')
            question, answer = str(card['question']).strip()[:500], str(card['answer']).strip()[:1000]
            if len(question) < 8 or len(answer) < 1:
                raise ValueError('Invalid review question or answer')
            row = {'id': str(uuid4()), 'course': course, 'video_id': video_id,
                   'question': question, 'answer': answer,
                   'source_start': max(0, float(card.get('source_start', 0))),
                   'due_at': now, 'created_at': now}
            db.execute('''INSERT INTO review_cards(user_id,id,course,video_id,question,answer,source_start,due_at,created_at)
                          VALUES(cf_user_id(),:id,:course,:video_id,:question,:answer,:source_start,:due_at,:created_at)''', row)
            output.append(row)
    return output


def due_cards(course: str | None = None, limit: int = 40, now: str | None = None,
              path: Path | None = None) -> list[dict]:
    sql = 'SELECT * FROM review_cards WHERE review_cards.user_id=cf_user_id() AND due_at<=?'
    params: list = [now or utcnow()]
    if course:
        sql += ' AND course=?'
        params.append(course)
    sql += ' ORDER BY due_at,id LIMIT ?'
    params.append(min(100, max(1, limit)))
    with connect(path) as db:
        return [dict(r) for r in db.execute(sql, params)]


def sm2(reps: int, interval: int, ease: float, quality: int) -> tuple[int, int, float]:
    """Simplified SM-2 schedule; quality 0..5 is learner self-evaluation."""
    if not 0 <= quality <= 5:
        raise ValueError('Quality must be between 0 and 5')
    new_ease = max(1.3, ease + 0.1 - (5-quality)*(0.08+(5-quality)*0.02))
    if quality < 3:
        return 0, 1, round(new_ease, 4)
    new_interval = 1 if reps == 0 else 6 if reps == 1 else max(1, round(interval * ease))
    return reps+1, new_interval, round(new_ease, 4)


def grade_card(card_id: str, quality: int, *, path: Path | None = None,
               now: datetime | None = None) -> dict:
    instant = now or datetime.now(timezone.utc)
    with connect(path) as db:
        row = db.execute('SELECT * FROM review_cards WHERE review_cards.user_id=cf_user_id() AND id=?', (card_id,)).fetchone()
        if not row:
            raise KeyError(card_id)
        reps, interval, ease = sm2(row['repetitions'], row['interval_days'], row['ease'], quality)
        next_due = (instant + timedelta(days=interval)).isoformat(timespec='seconds')
        db.execute('UPDATE review_cards SET repetitions=?,interval_days=?,ease=?,due_at=? WHERE review_cards.user_id=cf_user_id() AND id=?',
                   (reps, interval, ease, next_due, card_id))
        db.execute('INSERT INTO review_attempts(user_id,card_id,quality,reviewed_at) VALUES(cf_user_id(),?,?,?)',
                   (card_id, quality, instant.isoformat(timespec='seconds')))
        return {'id': card_id, 'repetitions': reps, 'interval_days': interval, 'ease': ease, 'due_at': next_due}


def list_notes(video_id: str, path: Path | None = None) -> list[dict]:
    with connect(path) as db:
        return [dict(r) for r in db.execute(
            'SELECT id,video_id,position,content,created_at FROM video_notes WHERE video_notes.user_id=cf_user_id() AND video_id=? ORDER BY created_at DESC,id DESC',
            (video_id,))]


def add_note(video_id: str, position: float, content: str, path: Path | None = None) -> dict:
    if not content.strip() or not 0 <= position < 1e9:
        raise ValueError('Invalid note')
    row = {'id': str(uuid4()), 'video_id': video_id, 'position': position,
           'content': content.strip()[:3000], 'created_at': utcnow()}
    with connect(path) as db:
        if not db.execute('SELECT 1 FROM videos WHERE id=?', (video_id,)).fetchone():
            raise KeyError(video_id)
        db.execute('''INSERT INTO video_notes(user_id,id,video_id,position,content,created_at)
                      VALUES(cf_user_id(),:id,:video_id,:position,:content,:created_at)''', row)
    return row


def delete_note(note_id: str, path: Path | None = None) -> None:
    with connect(path) as db:
        cursor = db.execute('DELETE FROM video_notes WHERE video_notes.user_id=cf_user_id() AND id=?', (note_id,))
        if not cursor.rowcount:
            raise KeyError(note_id)
