"""Discover local videos without ever importing outside the configured folder."""
import os
from pathlib import Path
from .chunking import video_id_for_path
from .db import connect, utcnow
from .config import settings

VIDEO_EXTENSIONS = {'.mp4', '.mkv', '.mov', '.webm', '.m4v', '.avi'}


def scan_courses(courses_dir: Path | None = None, db_path: Path | None = None) -> dict:
    root = (courses_dir or settings.courses_dir).resolve()
    root.mkdir(parents=True, exist_ok=True)
    imported = changed = unchanged = 0
    found_paths: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(root, followlinks=True):
        dirnames[:] = [d for d in dirnames if not d.startswith('.') and (Path(dirpath)/d).resolve().is_relative_to(root)]
        for fname in filenames:
            if fname.startswith('.'):
                continue
            p = Path(dirpath) / fname
            if p.suffix.lower() in VIDEO_EXTENSIONS and p.is_file() and p.resolve().is_relative_to(root):
                found_paths.append(p)
    files = sorted(found_paths)
    with connect(db_path) as conn:
        for entry in files:
            path = entry.resolve()
            stat = path.stat()
            rel = entry.relative_to(root)
            course = rel.parts[0] if len(rel.parts) > 1 else 'Unsorted'
            name = path.stem.replace('_', ' ').replace('-', ' ')
            key = video_id_for_path(str(path))
            previous = conn.execute('SELECT * FROM videos WHERE id=?', (key,)).fetchone()
            if previous and previous['bytes'] == stat.st_size and previous['mtime_ns'] == stat.st_mtime_ns:
                unchanged += 1
                continue
            if previous:
                active = conn.execute("SELECT 1 FROM jobs WHERE video_id=? AND status IN ('queued','processing')", (key,)).fetchone()
                if active:
                    continue  # A subsequent scan will pick up in-flight edits.
                conn.execute('''UPDATE videos SET course=?,title=?,bytes=?,mtime_ns=?,status='queued',error=NULL
                                WHERE id=?''', (course, name, stat.st_size, stat.st_mtime_ns, key))
                changed += 1
            else:
                conn.execute('''INSERT INTO videos(id,path,course,title,bytes,mtime_ns,status,created_at)
                                VALUES (?,?,?,?,?,?,?,?)''',
                             (key, str(path), course, name, stat.st_size, stat.st_mtime_ns, 'queued', utcnow()))
                imported += 1
            now = utcnow()
            conn.execute('INSERT INTO jobs(video_id,status,stage,created_at,updated_at) VALUES (?, ?, ?, ?, ?)',
                         (key, 'queued', 'Queued', now, now))
    return {'found': len(files), 'imported': imported, 'changed': changed, 'unchanged': unchanged}
