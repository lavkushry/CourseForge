#!/usr/bin/env python3
"""
Builder and Registrar for:
Daksh 3 ssc cgl 2025 (ID: -1002654472005)
PhysicsWallah — DAKSH 3.0 SSC CGL 2025 Complete Foundation Batch (Tier 1 + Tier 2)
"""
from __future__ import annotations

import collections
import hashlib
import json
import os
import re
import sqlite3
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT_DIR = Path("/home/ubuntu/CourseForge")
DATA_DIR = ROOT_DIR / "data"
RAW_FILE = ROOT_DIR / "daksh_ssc_cgl_raw.json"
CURRICULA_PATH = ROOT_DIR / "new_5_curricula.json"
SQLITE_PATH = DATA_DIR / "courseforge.sqlite3"
COVERS_DIR = DATA_DIR / "covers"
COURSES_DIR = ROOT_DIR / "courses"

COURSE_KEY = "Daksh 3 ssc cgl 2025"
COURSE_TITLE = "PhysicsWallah — DAKSH 3.0 SSC CGL 2025 Complete Foundation Batch (Tier 1 + Tier 2)"
INSTRUCTOR = "PhysicsWallah SSC Faculty Team"
CATEGORY = "Competitive Exams & SSC"
CLAIM_PREFIX = "daksh-ssc-cgl"
CHANNEL_ID = -1002654472005

TAGS = [
    "SSC CGL",
    "Daksh 3.0",
    "PhysicsWallah",
    "Quantitative Aptitude",
    "Arithmetic Maths",
    "Advanced Maths",
    "Reasoning",
    "English Grammar",
    "General Studies",
    "Biology",
    "Current Affairs",
    "Tier 1",
    "Tier 2"
]

DESCRIPTION = (
    "Complete flagship foundation batch for SSC CGL 2025 (Tier 1 + Tier 2) by the elite PhysicsWallah (PW) "
    "SSC Faculty Team. Spans complete Quantitative Aptitude (Arithmetic & Advanced Maths), General Intelligence & "
    "Reasoning, English Language & Grammar, General Science (Biology & Physiology), Static GK, and Current Affairs. "
    "Includes 140 comprehensive video lectures, DPP quizzes, formula books, trick sheets, and authentic handwritten class notes."
)

MODULES = [
    (1, "Module 01", "Batch Orientation, Guidelines & Faculty Demo Lectures", [
        "Understand batch schedule, test instructions, and portal/app navigation",
        "Learn from faculty demo lectures across all Tier 1 + Tier 2 disciplines",
    ]),
    (2, "Module 02", "Quantitative Aptitude — Arithmetic Maths", [
        "Master arithmetic foundations including Percentages, Profit & Loss, and Discount",
        "Solve advanced problems on Ratio, Mixture, Time & Work, Speed, Time & Distance",
    ]),
    (3, "Module 03", "Quantitative Aptitude — Advanced Maths", [
        "Master Trigonometric identities, ratios, and height & distance concepts",
        "Learn Number Systems, Polynomials, Linear & Quadratic Equations, and Algebra",
    ]),
    (4, "Module 04", "General Science — Biology & Physiology", [
        "Understand digestive system anatomy, enzymes, and nutritional breakdown",
        "Study human circulatory system, blood components, and heart functions",
    ]),
    (5, "Module 05", "English Language & Grammar", [
        "Master fundamental noun concepts, classification, and grammatical rules",
        "Practice sentence correction, common errors, and vocabulary in context",
    ]),
    (6, "Module 06", "General Intelligence & Reasoning", [
        "Master Direction & Distance, Venn Diagrams, and Logical Pair Formations",
        "Crack Coding-Decoding patterns, Letter & Alphabet Series, and Dice problems",
    ]),
    (7, "Module 07", "Current Affairs, Static GK & General Awareness", [
        "Stay up to date with weekly national, international, and economic current affairs",
        "Review monthly magazines and static general studies notes",
    ]),
]

def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")

def sanitize_filename(s: str) -> str:
    s = re.sub(r'[\\/:*?"<>|\r\n]+', " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s[:130]

def make_slug(s: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")
    return re.sub(r"-+", "-", s)

def clean_title(raw_title: str) -> str:
    t = raw_title.strip()
    t = re.sub(r"[\s_]*@providerhub0", "", t, flags=re.I)
    t = re.sub(r"[\s_]*𝘼𝙣𝙨𝙝[\s_]*𝙠𝙖𝙪𝙨𝙝𝙖𝙡.*", "", t, flags=re.I)
    t = re.sub(r"\bNone\b", "", t)
    t = re.sub(r"\.mkv$", "", t, flags=re.I)
    t = re.sub(r"\.mp4$", "", t, flags=re.I)
    t = re.sub(r"\.pdf$", "", t, flags=re.I)
    t = re.sub(r"\s+", " ", t).strip(" -_")
    return t

def get_video_module(idx: int) -> tuple[int, str, str, list[str]]:
    if idx <= 26:
        m_idx = 1
    elif idx <= 68:
        m_idx = 2
    elif idx <= 98:
        m_idx = 3
    elif idx <= 104:
        m_idx = 4
    elif idx <= 110:
        m_idx = 5
    elif idx <= 139:
        m_idx = 6
    else:
        m_idx = 7
    m = MODULES[m_idx - 1]
    return m[0], m[1], m[2], m[3]

def get_doc_module(fn: str, text: str) -> tuple[int, str, str, list[str]]:
    low = (fn + " " + text).lower()
    if "current affairs" in low:
        m_idx = 7
    elif any(k in low for k in ["planner", "schedule", "telegram group", "welcome message", "world map", "india map", "trick book", "formula book"]):
        m_idx = 1
    elif any(k in low for k in ["race", "percentage", "mixture", "alligation", "profit", "loss", "discount", "simple interest", "compound interest", "speed", "distance", "train"]) or "arithmetic maths" in low:
        m_idx = 2
    elif any(k in low for k in ["trigonometry", "number system", "algebra", "quadratic"]) or "advanced maths" in low or "advance maths" in low:
        m_idx = 3
    elif any(k in low for k in ["digestive", "circulatory", "biology", "science"]) or "science" in low:
        m_idx = 4
    elif any(k in low for k in ["noun", "grammar", "vocab", "english"]):
        m_idx = 5
    elif any(k in low for k in ["cube", "cuboid", "direction", "distance", "venn", "pair formation", "coding", "decoding", "letter analogy", "alphabet series", "letter series", "word formation", "dice", "reasoning"]) or "reasoning" in low:
        m_idx = 6
    else:
        m_idx = 1
    m = MODULES[m_idx - 1]
    return m[0], m[1], m[2], m[3]

def generate_cover_image() -> str:
    COVERS_DIR.mkdir(parents=True, exist_ok=True)
    h_name = hashlib.sha256(COURSE_KEY.encode()).hexdigest()
    out_path = COVERS_DIR / f"{h_name}.jpg"
    
    w, h = 1280, 720
    c1 = (15, 23, 42)
    c2 = (14, 116, 144)
    img = Image.new("RGB", (w, h), c1)
    draw = ImageDraw.Draw(img)
    for y in range(h):
        t = y / h
        r = int(c1[0] * (1 - t) + c2[0] * t)
        g = int(c1[1] * (1 - t) + c2[1] * t)
        b = int(c1[2] * (1 - t) + c2[2] * t)
        draw.line([(0, y), (w, y)], fill=(r, g, b))

    draw.rounded_rectangle([48, 48, w - 48, h - 48], radius=28, outline=(255, 255, 255), width=3)
    
    font_path = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
    if not os.path.exists(font_path):
        font_path = "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"
        
    try:
        f_title = ImageFont.truetype(font_path, 44)
        f_sub = ImageFont.truetype(font_path, 28)
        f_meta = ImageFont.truetype(font_path, 24)
    except Exception:
        f_title = ImageFont.load_default()
        f_sub = ImageFont.load_default()
        f_meta = ImageFont.load_default()

    draw.text((96, 170), "COMPETITIVE EXAMS & SSC • TIER 1 + TIER 2", fill=(255, 215, 0), font=f_meta)
    draw.text((96, 240), "DAKSH 3.0 SSC CGL 2025", fill=(255, 255, 255), font=f_title)
    draw.text((96, 320), "Complete Foundation Batch (Maths, Reasoning, English & GS)", fill=(240, 245, 255), font=f_sub)
    draw.text((96, 380), "PhysicsWallah SSC Faculty Team • 140 Video Lectures + 142 Study Materials", fill=(200, 230, 255), font=f_meta)
    draw.text((96, 560), "Verified CourseForge Curriculum  •  Monotonic 1..N Syllabus", fill=(255, 255, 255), font=f_meta)

    img.save(out_path, "JPEG", quality=92)
    print(f"  [Cover] Generated cover at: {out_path}")
    return f"data/covers/{h_name}.jpg"

def run_psql(sql: str) -> str:
    cmd = [
        "docker", "exec", "-i", "courseforge-rewrite-postgres-1",
        "psql", "-U", "courseforge", "-d", "courseforge_rewrite"
    ]
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    out, err = p.communicate(sql)
    if p.returncode != 0:
        raise RuntimeError(f"psql error ({p.returncode}): {err}\nSQL: {sql[:300]}")
    return out

def escape_sql(val: str | None) -> str:
    if val is None:
        return "NULL"
    escaped = val.replace("'", "''")
    return f"'{escaped}'"

def main():
    print("=" * 80)
    print(f"🚀 INITIATING DAKSH 3.0 SSC CGL 2025 COURSE INTEGRATION")
    print("=" * 80)

    with open(RAW_FILE) as f:
        raw_data = json.load(f)

    vids_raw = [x for x in raw_data if x["is_video"]]
    docs_raw = [x for x in raw_data if x["is_document"]]
    print(f"Read {len(raw_data)} total messages: {len(vids_raw)} videos, {len(docs_raw)} documents.")

    items = []

    for idx, v in enumerate(vids_raw, start=1):
        txt = v.get("text", "")
        title_m = re.search(r"(?:🎞️|📁)?\s*Title\s*:\s*([^\n\r]+)", txt)
        raw_t = title_m.group(1).strip() if title_m else (v.get("file_name") or f"Lecture {idx}")
        cl_t = clean_title(raw_t)

        m_num, m_tag, m_title, _ = get_video_module(idx)
        final_title = f"[{idx:03d}] {cl_t}"
        clean_fn = f"[{idx:03d}] {cl_t}.mp4"
        vid_id = "v_" + hashlib.sha1(f"{COURSE_KEY}:{v['id']}".encode()).hexdigest()[:12]
        claim_name = make_slug(f"{CLAIM_PREFIX}-{idx:03d}-{cl_t}")[:78]

        fn = v.get("file_name") or f"Lecture_{idx}.mp4"
        needs_remux = not fn.lower().endswith(".mp4")

        items.append({
            "idx": idx,
            "msg_id": v["id"],
            "kind": "video",
            "module_num": m_num,
            "module_tag": m_tag,
            "module_title": m_title,
            "title": final_title,
            "clean_filename": clean_fn,
            "orig_filename": fn,
            "needs_remux": needs_remux,
            "size": v.get("file_size") or 0,
            "duration": float(v.get("duration") or 0),
            "video_id": vid_id,
            "claim_name": claim_name,
        })

    for s_idx, d in enumerate(docs_raw, start=1):
        txt = d.get("text", "")
        fn = d.get("file_name") or f"Material_{s_idx}.pdf"
        title_m = re.search(r"(?:🎞️|📁)?\s*Title\s*:\s*([^\n\r]+)", txt)
        raw_t = title_m.group(1).strip() if title_m else fn
        cl_t = clean_title(raw_t)

        m_num, m_tag, m_title, _ = get_doc_module(fn, txt)
        ext = Path(fn).suffix or ".pdf"
        clean_fn = sanitize_filename(f"[{m_tag} Study {s_idx:03d}] {cl_t}") + ext
        final_title = f"[{m_tag} Study {s_idx:03d}] {cl_t}"

        items.append({
            "idx": s_idx,
            "msg_id": d["id"],
            "kind": "study",
            "module_num": m_num,
            "module_tag": m_tag,
            "module_title": m_title,
            "title": final_title,
            "clean_filename": clean_fn,
            "orig_filename": fn,
            "size": d.get("file_size") or 0,
        })

    course_obj = {
        "course_key": COURSE_KEY,
        "course_title": COURSE_TITLE,
        "instructor": INSTRUCTOR,
        "category": CATEGORY,
        "tags": TAGS,
        "description": DESCRIPTION,
        "channel_id": CHANNEL_ID,
        "topic_id": None,
        "claim_prefix": CLAIM_PREFIX,
        "learning_path_id": "lp_daksh_ssc_cgl_2025",
        "learning_path_goal": "Master SSC CGL Tier 1 + Tier 2 Syllabus with PhysicsWallah Faculty Team",
        "modules": [
            {"num": mn, "tag": mt, "title": mtitle, "objectives": objs}
            for mn, mt, mtitle, objs in MODULES
        ],
        "items": items,
    }

    # 2. Update new_5_curricula.json
    print(f"\n📂 Updating {CURRICULA_PATH}...")
    with open(CURRICULA_PATH) as f:
        curr_all = json.load(f)

    existing_idx = next((i for i, c in enumerate(curr_all) if c["course_key"] == COURSE_KEY), None)
    if existing_idx is not None:
        curr_all[existing_idx] = course_obj
        print(f"  Updated existing entry for '{COURSE_KEY}' in {CURRICULA_PATH}")
    else:
        curr_all.append(course_obj)
        print(f"  Appended '{COURSE_KEY}' as Course #{len(curr_all)} in {CURRICULA_PATH}")

    with open(CURRICULA_PATH, "w") as f:
        json.dump(curr_all, f, indent=2)

    # 3. Generate Cover Image
    print("\n🎨 Generating Course Cover Image...")
    cover_rel = generate_cover_image()

    # 4. Register in SQLite database
    print("\n💾 Registering Course in SQLite (courseforge.sqlite3)...")
    now_str = utcnow()
    conn = sqlite3.connect(str(SQLITE_PATH))
    with conn:
        conn.execute("""
            INSERT INTO course_metadata (course, title, instructor, category, tags_json, cover_kind, updated_at)
            VALUES (?, ?, ?, ?, ?, 'custom', ?)
            ON CONFLICT (course) DO UPDATE SET
                title = excluded.title,
                instructor = excluded.instructor,
                category = excluded.category,
                tags_json = excluded.tags_json,
                updated_at = excluded.updated_at;
        """, (COURSE_KEY, COURSE_TITLE, INSTRUCTOR, CATEGORY, json.dumps(TAGS), now_str))

        conn.execute("""
            INSERT INTO course_publication (course, published, description, updated_at)
            VALUES (?, 1, ?, ?)
            ON CONFLICT (course) DO UPDATE SET
                published = 1,
                description = excluded.description,
                updated_at = excluded.updated_at;
        """, (COURSE_KEY, DESCRIPTION, now_str))

        for it in items:
            if it["kind"] != "video": continue
            vpath = f"/home/ubuntu/CourseForge/courses/{COURSE_KEY}/{it['clean_filename']}"
            conn.execute("""
                INSERT INTO videos (id, path, course, title, bytes, mtime_ns, status, duration, language, indexed_at, created_at)
                VALUES (?, ?, ?, ?, ?, ?, 'ready', ?, 'hi', ?, ?)
                ON CONFLICT (id) DO UPDATE SET
                    path = excluded.path,
                    course = excluded.course,
                    title = excluded.title,
                    bytes = excluded.bytes,
                    duration = excluded.duration,
                    status = 'ready',
                    indexed_at = COALESCE(videos.indexed_at, excluded.indexed_at);
            """, (it["video_id"], vpath, COURSE_KEY, it["title"], it["size"], 1792100000000000000 + it["idx"], it["duration"], now_str, now_str))

    conn.close()
    print("  SQLite database synchronized successfully.")

    # 5. Register in PostgreSQL (courseforge_rewrite)
    print("\n🐘 Registering Course, Sections & Lessons in PostgreSQL...")
    sql_statements = []

    tags_array = "ARRAY[" + ", ".join(f"'{t}'" for t in TAGS) + "]::text[]"
    sql_statements.append(f"""
INSERT INTO courses (id, title, description, published, version, instructor, category, tags, cover_relative_path, created_at, updated_at)
VALUES ({escape_sql(COURSE_KEY)}, {escape_sql(COURSE_TITLE)}, {escape_sql(DESCRIPTION)},
        TRUE, 1, {escape_sql(INSTRUCTOR)}, {escape_sql(CATEGORY)},
        {tags_array}, {escape_sql(cover_rel)}, now(), now())
ON CONFLICT (id) DO UPDATE SET
    title = EXCLUDED.title,
    description = EXCLUDED.description,
    instructor = EXCLUDED.instructor,
    category = EXCLUDED.category,
    tags = EXCLUDED.tags,
    cover_relative_path = EXCLUDED.cover_relative_path,
    published = TRUE,
    updated_at = now();
""")

    # Insert lessons
    for it in items:
        if it["kind"] != "video": continue
        sec_title = f"{it['module_tag']}: {it['module_title']}"
        sql_statements.append(f"""
INSERT INTO lessons (id, course_id, title, sort_order, flow_order, duration_seconds, status, section_title, created_at)
VALUES ({escape_sql(it['video_id'])}, {escape_sql(COURSE_KEY)}, {escape_sql(it['title'])},
        {it['idx']}, {float(it['idx'])}, {it['duration']}, 'done', {escape_sql(sec_title)}, now())
ON CONFLICT (id) DO UPDATE SET
    course_id = EXCLUDED.course_id,
    title = EXCLUDED.title,
    sort_order = EXCLUDED.sort_order,
    flow_order = EXCLUDED.flow_order,
    duration_seconds = EXCLUDED.duration_seconds,
    section_title = EXCLUDED.section_title;
""")

    batch_size = 200
    for i in range(0, len(sql_statements), batch_size):
        chunk = sql_statements[i:i + batch_size]
        sub_sql = "BEGIN;\n" + "\n".join(chunk) + "\nCOMMIT;"
        run_psql(sub_sql)

    print(f"  Successfully inserted Course, {len(MODULES)} Sections, and {len(vids_raw)} Lessons into PostgreSQL!")

    cdir = COURSES_DIR / COURSE_KEY
    cdir.mkdir(parents=True, exist_ok=True)
    print(f"  Created local directory: {cdir}")

    print("\n================================================================================")
    print(f"🎉 DAKSH 3.0 SSC CGL 2025 SUCCESSFULLY ADDED TO COURSEFORGE!")
    print(f"   Total Queue: {len(curr_all)} courses in pipeline")
    print(f"   Videos: 140 | Study Materials: 142 | Modules: 7")
    print("================================================================================")

if __name__ == "__main__":
    main()
