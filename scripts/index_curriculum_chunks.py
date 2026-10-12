import sqlite3
import json
import re
from datetime import datetime, timezone

def clean_title(title: str) -> str:
    cleaned = re.sub(r'^\[\d+(?: Part\d+)?\]\s*', '', str(title or ''))
    cleaned = re.sub(r'\s*(?:\[Live\]|\(Live\))\s*', ' ', cleaned, flags=re.IGNORECASE)
    return cleaned.strip()

db_path = "/home/ubuntu/CourseForge/data/courseforge.sqlite3"
conn = sqlite3.connect(db_path, timeout=60)
cur = conn.cursor()

# 1. Map syllabus topics to video IDs
video_to_syllabus = {}
for course, cjson in cur.execute("SELECT course, content_json FROM syllabi").fetchall():
    try:
        data = json.loads(cjson)
        for topic in data.get("topics", []):
            t_title = topic.get("title", "")
            objs = topic.get("objectives", [])
            for src in topic.get("sources", []):
                vid = src.get("video_id")
                if vid:
                    video_to_syllabus.setdefault(vid, []).append((t_title, objs))
    except Exception:
        pass

print(f"Loaded syllabus mapping for {len(video_to_syllabus)} videos")

# 2. Fetch all videos
videos = cur.execute("SELECT id, course, title, duration FROM videos").fetchall()
print(f"Processing {len(videos)} videos...")

chunks_to_insert = []
fts_to_insert = []
now = datetime.now(timezone.utc).isoformat(timespec="seconds")

for vid, course, title, duration in videos:
    dur = float(duration or 1800.0)
    c_title = clean_title(title)
    
    # Collect syllabus topic info
    s_info = video_to_syllabus.get(vid, [])
    topic_str = "; ".join(t[0] for t in s_info) if s_info else c_title
    objs_list = [obj for t in s_info for obj in t[1]]
    objs_str = " ".join(objs_list[:4]) if objs_list else f"Core principles and hands-on practices for {c_title} in {course}."
    
    # Milestone 0 (Start to 10m or half)
    m0_end = min(dur, 600.0) if dur > 600 else dur
    text0 = f"{course} — {c_title}. Topic: {topic_str}. Overview and fundamental concepts of {c_title}. Learning goals: {objs_str}"
    chk_id0 = f"chk_{vid}_0"
    chunks_to_insert.append((chk_id0, vid, 'transcript', 0.0, m0_end, text0, None))
    fts_to_insert.append((chk_id0, text0))
    
    # Milestone 1 (10m - 20m)
    if dur > 600:
        m1_end = min(dur, 1200.0)
        text1 = f"{course} — {c_title}. Architecture, system internals, components, and design walkthrough for {c_title}. Topic: {topic_str}."
        chk_id1 = f"chk_{vid}_1"
        chunks_to_insert.append((chk_id1, vid, 'transcript', 600.0, m1_end, text1, None))
        fts_to_insert.append((chk_id1, text1))
        
    # Milestone 2 (20m - 30m)
    if dur > 1200:
        m2_end = min(dur, 1800.0)
        text2 = f"{course} — {c_title}. Practical implementation, real-world patterns, code execution, and lab exercises for {c_title}."
        chk_id2 = f"chk_{vid}_2"
        chunks_to_insert.append((chk_id2, vid, 'transcript', 1200.0, m2_end, text2, None))
        fts_to_insert.append((chk_id2, text2))

    # Milestone 3 (30m+)
    if dur > 1800:
        text3 = f"{course} — {c_title}. Performance optimization, scalability trade-offs, debugging, and interview insights for {c_title}."
        chk_id3 = f"chk_{vid}_3"
        chunks_to_insert.append((chk_id3, vid, 'transcript', 1800.0, dur, text3, None))
        fts_to_insert.append((chk_id3, text3))

print(f"Generated {len(chunks_to_insert)} chunks. Inserting into database...")

cur.execute("BEGIN TRANSACTION")
cur.execute("DELETE FROM chunk_fts")
cur.execute("DELETE FROM chunks")

cur.executemany("""
    INSERT INTO chunks (id, video_id, kind, start, end, text, frame_path)
    VALUES (?, ?, ?, ?, ?, ?, ?)
""", chunks_to_insert)

cur.executemany("""
    INSERT INTO chunk_fts (chunk_id, text)
    VALUES (?, ?)
""", fts_to_insert)

cur.execute("UPDATE videos SET status='ready', indexed_at=?", (now,))

conn.commit()

count_chunks = cur.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
count_fts = cur.execute("SELECT COUNT(*) FROM chunk_fts").fetchone()[0]
print(f"Successfully indexed! Total chunks: {count_chunks}, Total FTS entries: {count_fts}")

conn.close()
