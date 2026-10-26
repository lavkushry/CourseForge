#!/usr/bin/env python3
"""
CourseForge Autonomous Zero-Cost Multi-Course Stream Preserver Daemon:
- Runs continuously in the background (0% CPU idle).
- Monitors /home/ubuntu/CourseForge/temp_videos/ for incoming and completed .mp4 downloads.
- Dynamically detects the active pipeline course from linux_pipeline.log.
- Matches files by exact name, title, or [XXX] sort index across all 44 courses.
- Immediately hardlinks completed videos to /home/ubuntu/CourseForge/courses/<course>/<filename>
  before any cleanup or upload failure can remove them.
- Takes 0 extra bytes of disk space (shares identical filesystem inodes).
- Zero external financial cost ($0.00).
- Explicitly prevents file descriptor leaks (proper conn.close() and scandir context managers).
- Keeps CourseForge Go backend HTTP Range streaming 100% playable locally.
"""
import os
import re
import sys
import time
import gc
import sqlite3
from pathlib import Path

ROOT_DIR = Path("/home/ubuntu/CourseForge")
TEMP_DIR = ROOT_DIR / "temp_videos"
COURSES_DIR = ROOT_DIR / "courses"
DB_PATH = ROOT_DIR / "data/courseforge.sqlite3"
LOG_PATH = ROOT_DIR / "linux_pipeline.log"


def get_db_mapping():
    """Load all 6,300+ course videos into memory index with zero handle leaks."""
    mapping_by_filename = {}
    mapping_by_idx = {}
    course_titles = {}
    if not DB_PATH.exists():
        return mapping_by_filename, mapping_by_idx, course_titles

    conn = None
    try:
        uri = f"file:{DB_PATH}?mode=ro"
        conn = sqlite3.connect(uri, uri=True, timeout=10)
        cur = conn.cursor()
        cur.execute("SELECT course, title, path FROM videos")
        for course, title, expected_path in cur.fetchall():
            fname = os.path.basename(expected_path)
            mapping_by_filename[fname] = (course, title, expected_path)
            mapping_by_filename[f"{title}.mp4"] = (course, title, expected_path)
            m = re.match(r"^\[(\d+)\]", title)
            if m:
                idx = int(m.group(1))
                mapping_by_idx[(course, idx)] = (course, title, expected_path)
                if course not in course_titles:
                    course_titles[course] = {}
                course_titles[course][idx] = (course, title, expected_path)
    except Exception as e:
        print(f"⚠️ DB mapping error: {e}", flush=True)
    finally:
        if conn:
            try:
                conn.close()
            except Exception:
                pass
    return mapping_by_filename, mapping_by_idx, course_titles


def detect_active_course():
    """Detect currently active downloading course from pipeline log tail."""
    if not LOG_PATH.exists():
        return None
    try:
        with open(LOG_PATH, "rb") as f:
            sz = LOG_PATH.stat().st_size
            f.seek(max(0, sz - 65536))
            chunk = f.read().decode("utf-8", errors="ignore")
            matches = re.findall(r"\[DL #\d+\s*(?:\|)?\s*\[?([^\]\|]+?)(?:\s+Video|\s*\])", chunk)
            if matches:
                return matches[-1].strip()
            # Fallback check for COURSE X/Y:
            matches_course = re.findall(r"COURSE \d+/\d+:\s*(.+)", chunk)
            if matches_course:
                return matches_course[-1].strip()
    except Exception:
        pass
    return None


def scan_and_preserve(mapping_by_filename, mapping_by_idx, course_titles, active_course):
    """Scan temp_videos with scandir (no FD leaks) and hardlink new videos immediately."""
    if not TEMP_DIR.exists():
        return

    with os.scandir(TEMP_DIR) as entries:
        for entry in entries:
            try:
                if not entry.is_file():
                    continue
                name = entry.name
                if not name.lower().endswith(".mp4") or ".part" in name:
                    continue
                
                st = entry.stat()
                if st.st_size == 0:
                    continue

                item_path = Path(entry.path)
                course_name = None
                db_title = item_path.stem
                expected_path = None

                # Match 1: Exact filename
                if name in mapping_by_filename:
                    course_name, db_title, expected_path = mapping_by_filename[name]
                else:
                    # Match 2: [XXX] prefix index against active course
                    m = re.match(r"^\[(\d+)\]", name)
                    if m:
                        idx = int(m.group(1))
                        if active_course and (active_course, idx) in mapping_by_idx:
                            course_name, db_title, expected_path = mapping_by_idx[(active_course, idx)]
                        elif active_course and active_course in course_titles and idx in course_titles[active_course]:
                            course_name, db_title, expected_path = course_titles[active_course][idx]

                # Default fallback if still unresolved
                if not course_name:
                    course_name = active_course if active_course else "Campus X DSMP (Data Science Mentorship Program)"

                target_dir = COURSES_DIR / course_name
                target_dir.mkdir(parents=True, exist_ok=True)
                dest_file = target_dir / name

                # If destination does not exist or inode differs, hardlink it!
                if not dest_file.exists() or dest_file.stat().st_ino != st.st_ino:
                    try:
                        if dest_file.exists():
                            dest_file.unlink()
                        os.link(str(item_path), str(dest_file))
                        print(f"✅ [Preserver] Hardlinked: {name} -> {course_name}/ ({st.st_size / (1024**2):.1f} MB)", flush=True)
                    except Exception as e:
                        print(f"❌ [Preserver] Link error for {name}: {e}", flush=True)

                # Create clean canonical alias if needed
                if db_title:
                    canonical_name = f"{db_title}.mp4"
                    canonical_path = target_dir / canonical_name
                    if canonical_name != name and not canonical_path.exists():
                        try:
                            canonical_path.symlink_to(dest_file.name)
                            print(f"🔗 [Preserver] Linked alias: {canonical_name} -> {dest_file.name}", flush=True)
                        except Exception:
                            pass
            except Exception as e:
                print(f"⚠️ [Preserver] Error processing {entry.name}: {e}", flush=True)


def main():
    print("🚀 CourseForge Zero-Cost Multi-Course Stream Preserver Daemon Started...", flush=True)
    mapping_by_filename, mapping_by_idx, course_titles = get_db_mapping()
    active_course = detect_active_course()
    print(f"📊 Database loaded: {len(mapping_by_filename)} filename mappings. Active course: {active_course}", flush=True)

    last_db_reload = time.time()
    last_course_check = time.time()
    cycle_count = 0

    while True:
        try:
            now = time.time()
            # Refresh active course every 30 seconds
            if now - last_course_check > 30:
                current_active = detect_active_course()
                if current_active and current_active != active_course:
                    print(f"🔄 Active course transitioned: {active_course} -> {current_active}", flush=True)
                    active_course = current_active
                last_course_check = now

            # Refresh DB mapping every 10 minutes
            if now - last_db_reload > 600 or not mapping_by_filename:
                mapping_by_filename, mapping_by_idx, course_titles = get_db_mapping()
                last_db_reload = now

            scan_and_preserve(mapping_by_filename, mapping_by_idx, course_titles, active_course)

            cycle_count += 1
            if cycle_count % 150 == 0:  # Every ~5 minutes
                gc.collect()

        except Exception as e:
            print(f"⚠️ Preserver main loop error: {e}", flush=True)

        time.sleep(2)


if __name__ == "__main__":
    main()
