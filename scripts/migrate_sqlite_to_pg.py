#!/usr/bin/env python3
"""
Migrate data from SQLite snapshot to PostgreSQL rewrite database.
Ensures typed mapping, constraint validation, foreign key integrity,
and non-destructive idempotence (ON CONFLICT).
"""
import argparse
import json
import sqlite3
import subprocess
import sys

def escape_sql_str(val):
    if val is None:
        return "NULL"
    return "'" + str(val).replace("'", "''") + "'"

def escape_sql_bool(val):
    return "TRUE" if bool(val) else "FALSE"

def run_psql(sql):
    cmd = [
        "docker", "exec", "-i", "courseforge-rewrite-postgres-1",
        "psql", "-U", "courseforge", "-d", "courseforge_rewrite", "-v", "ON_ERROR_STOP=1"
    ]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    out, err = proc.communicate(input=sql)
    if proc.returncode != 0:
        raise RuntimeError(f"psql failed with code {proc.returncode}:\n{err}\n{out}")
    return out

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--snapshot", required=True, help="Path to SQLite snapshot")
    args = parser.parse_args()

    conn = sqlite3.connect(args.snapshot)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    sql_parts = ["BEGIN;"]

    # 1. Users
    cur.execute("SELECT id, email, name, password_hash, role, verified, suspended, created_at FROM users")
    users = cur.fetchall()
    print(f"Migrating {len(users)} users...")
    for u in users:
        role = u["role"] if u["role"] in ("student", "admin") else "student"
        sql_parts.append(f"""
INSERT INTO users (id, email, name, password_hash, role, verified, suspended, created_at)
VALUES ({escape_sql_str(u['id'])}, {escape_sql_str(u['email'].lower())}, {escape_sql_str(u['name'])},
        {escape_sql_str(u['password_hash'])}, {escape_sql_str(role)}, {escape_sql_bool(u['verified'])},
        {escape_sql_bool(u['suspended'])}, {escape_sql_str(u['created_at'])})
ON CONFLICT (id) DO NOTHING;
""")

    # 2. Courses
    cur.execute("SELECT course, title, instructor, category, tags_json, updated_at FROM course_metadata")
    courses = cur.fetchall()
    print(f"Migrating {len(courses)} courses...")
    for c in courses:
        tags = []
        try:
            raw_tags = json.loads(c["tags_json"] or "[]")
            if isinstance(raw_tags, list):
                tags = [str(t).replace("'", "''") for t in raw_tags]
        except Exception:
            pass
        tags_array = "ARRAY[" + ", ".join(f"'{t}'" for t in tags) + "]::text[]" if tags else "'{}'::text[]"
        sql_parts.append(f"""
INSERT INTO courses (id, title, description, published, version, instructor, category, tags, cover_relative_path, created_at, updated_at)
VALUES ({escape_sql_str(c['course'])}, {escape_sql_str(c['title'])}, {escape_sql_str(c['title'])},
        TRUE, 1, {escape_sql_str(c['instructor'] or '')}, {escape_sql_str(c['category'] or '')},
        {tags_array}, '', {escape_sql_str(c['updated_at'])}, {escape_sql_str(c['updated_at'])})
ON CONFLICT (id) DO UPDATE SET
    title = EXCLUDED.title,
    instructor = EXCLUDED.instructor,
    category = EXCLUDED.category,
    tags = EXCLUDED.tags,
    published = TRUE;
""")

    # 3. Lessons
    cur.execute("SELECT id, course, title, duration, status, created_at FROM videos ORDER BY course, path")
    videos = cur.fetchall()
    print(f"Migrating {len(videos)} lessons...")
    course_order = {}
    for v in videos:
        cid = v["course"]
        course_order[cid] = course_order.get(cid, 0) + 1
        sort_order = course_order[cid]
        flow_order = float(sort_order)
        dur = max(0.0, float(v["duration"] or 0.0))
        status = "done" if v["status"] == "ready" else v["status"]
        if status not in ("queued", "processing", "done", "failed"):
            status = "done"
        sql_parts.append(f"""
INSERT INTO lessons (id, course_id, title, sort_order, flow_order, duration_seconds, status, section_title, created_at)
VALUES ({escape_sql_str(v['id'])}, {escape_sql_str(v['course'])}, {escape_sql_str(v['title'])},
        {sort_order}, {flow_order}, {dur}, {escape_sql_str(status)}, '', {escape_sql_str(v['created_at'])})
ON CONFLICT (id) DO UPDATE SET
    course_id = EXCLUDED.course_id,
    title = EXCLUDED.title,
    sort_order = EXCLUDED.sort_order,
    flow_order = EXCLUDED.flow_order,
    duration_seconds = EXCLUDED.duration_seconds,
    status = EXCLUDED.status;
""")

    # 4. Lesson Providers
    cur.execute("""
        SELECT lp.video_id, lp.claim_name, lp.claim_id, lp.updated_at
        FROM lecture_providers lp
        JOIN videos v ON v.id = lp.video_id
    """)
    providers = cur.fetchall()
    print(f"Migrating {len(providers)} lesson providers...")
    for p in providers:
        sql_parts.append(f"""
INSERT INTO lesson_providers (lesson_id, claim_name, claim_id, updated_at)
VALUES ({escape_sql_str(p['video_id'])}, {escape_sql_str(p['claim_name'])},
        {escape_sql_str(p['claim_id'])}, {escape_sql_str(p['updated_at'])})
ON CONFLICT (lesson_id) DO UPDATE SET
    claim_name = EXCLUDED.claim_name,
    claim_id = EXCLUDED.claim_id,
    updated_at = EXCLUDED.updated_at;
""")

    # 5. Enrollments
    cur.execute("""
        SELECT e.user_id, e.course, e.created_at
        FROM enrollments e
        JOIN users u ON u.id = e.user_id
        JOIN course_metadata cm ON cm.course = e.course
    """)
    enrollments = cur.fetchall()
    print(f"Migrating {len(enrollments)} enrollments...")
    for e in enrollments:
        sql_parts.append(f"""
INSERT INTO enrollments (user_id, course_id, created_at)
VALUES ({escape_sql_str(e['user_id'])}, {escape_sql_str(e['course'])}, {escape_sql_str(e['created_at'])})
ON CONFLICT (user_id, course_id) DO NOTHING;
""")

    # 6. Progress
    cur.execute("""
        SELECT vp.user_id, vp.video_id, vp.percent, vp.position, vp.completed, vp.updated_at
        FROM video_progress vp
        JOIN users u ON u.id = vp.user_id
        JOIN videos v ON v.id = vp.video_id
    """)
    progress_rows = cur.fetchall()
    print(f"Migrating {len(progress_rows)} progress records...")
    for pr in progress_rows:
        pct = max(0, min(100, int(pr["percent"] or 0)))
        pos = max(0.0, float(pr["position"] or 0.0))
        done = bool(pr["completed"])
        sql_parts.append(f"""
INSERT INTO progress (user_id, lesson_id, percent, position, completed, explicit_completed, revision, updated_at)
VALUES ({escape_sql_str(pr['user_id'])}, {escape_sql_str(pr['video_id'])}, {pct}, {pos},
        {escape_sql_bool(done)}, {escape_sql_bool(done)}, 1, {escape_sql_str(pr['updated_at'])})
ON CONFLICT (user_id, lesson_id) DO UPDATE SET
    percent = EXCLUDED.percent,
    position = EXCLUDED.position,
    completed = EXCLUDED.completed,
    updated_at = EXCLUDED.updated_at;
""")

    # 7. Lesson Quizzes & Quiz Versions
    cur.execute("""
        SELECT lq.id, lq.video_id, lq.course, lq.questions_json, lq.created_at
        FROM lesson_quizzes lq
        JOIN videos v ON v.id = lq.video_id
        JOIN course_metadata cm ON cm.course = lq.course
    """)
    quizzes = cur.fetchall()
    print(f"Migrating {len(quizzes)} lesson quizzes...")
    for q in quizzes:
        try:
            questions = json.loads(q["questions_json"])
            if not isinstance(questions, list) or len(questions) < 1 or len(questions) > 20:
                continue
        except Exception:
            continue
        q_json_escaped = escape_sql_str(json.dumps(questions))
        sql_parts.append(f"""
INSERT INTO lesson_quizzes (id, lesson_id, course_id, revision, status, created_at, updated_at)
VALUES ({escape_sql_str(q['id'])}, {escape_sql_str(q['video_id'])}, {escape_sql_str(q['course'])},
        1, 'approved', {escape_sql_str(q['created_at'])}, {escape_sql_str(q['created_at'])})
ON CONFLICT (id) DO NOTHING;

INSERT INTO quiz_versions (quiz_id, revision, questions, created_at)
VALUES ({escape_sql_str(q['id'])}, 1, {q_json_escaped}::jsonb, {escape_sql_str(q['created_at'])})
ON CONFLICT (quiz_id, revision) DO NOTHING;
""")

    # 8. Learning Paths
    cur.execute("""
        SELECT lp.id, lp.user_id, lp.goal, lp.courses_json, lp.content_json, lp.source_fingerprint, lp.updated_at
        FROM learning_paths lp
        JOIN users u ON u.id = lp.user_id
    """)
    paths = cur.fetchall()
    print(f"Migrating {len(paths)} learning paths...")
    for p in paths:
        try:
            c_list = json.loads(p["courses_json"])
            if not isinstance(c_list, list) or not c_list:
                continue
            c_list = [str(x).replace("'", "''") for x in c_list[:8]]
            content = json.loads(p["content_json"])
            if not isinstance(content, dict):
                continue
        except Exception:
            continue
        goal = (p["goal"] or "Learning Path").strip()
        if len(goal) < 3:
            goal = goal + "..."
        if len(goal) > 180:
            goal = goal[:180]
        c_array = "ARRAY[" + ", ".join(f"'{x}'" for x in c_list) + "]::text[]"
        content_escaped = escape_sql_str(json.dumps(content))
        sql_parts.append(f"""
INSERT INTO learning_paths (id, user_id, goal, course_ids, definition, provenance, source_fingerprint, revision, created_at, updated_at)
VALUES ({escape_sql_str(p['id'])}, {escape_sql_str(p['user_id'])}, {escape_sql_str(goal)},
        {c_array}, {content_escaped}::jsonb, 'legacy_import', {escape_sql_str(p['source_fingerprint'])},
        1, {escape_sql_str(p['updated_at'])}, {escape_sql_str(p['updated_at'])})
ON CONFLICT (id) DO NOTHING;
""")

    # 9. Transcript Chunks
    cur.execute("""
        SELECT c.id, c.video_id, c.start, c.end, c.text
        FROM chunks c
        JOIN videos v ON v.id = c.video_id
    """)
    chunks = cur.fetchall()
    print(f"Migrating {len(chunks)} transcript chunks...")
    for c in chunks:
        start_s = max(0.0, float(c["start"] or 0.0))
        end_s = max(start_s, float(c["end"] or start_s))
        txt = c["text"] or ""
        sql_parts.append(f"""
INSERT INTO transcript_chunks (id, lesson_id, kind, start_seconds, end_seconds, text)
VALUES ({escape_sql_str(c['id'])}, {escape_sql_str(c['video_id'])}, 'transcript', {start_s}, {end_s}, {escape_sql_str(txt)})
ON CONFLICT (id) DO NOTHING;
""")

    sql_parts.append("COMMIT;")

    full_sql = "\n".join(sql_parts)
    print(f"Executing SQL in PostgreSQL ({len(sql_parts)} statements)...")
    run_psql(full_sql)
    print("Migration completed successfully!")

if __name__ == "__main__":
    main()
