#!/usr/bin/env python3
"""
Builder and Registrar for:
Grow Data Skills Complete Data Engineering With Azure (Channel ID: -1003203876731)
Grow Data Skills — Complete Data Engineering with Azure, PySpark, Databricks & Snowflake
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
RAW_FILE = ROOT_DIR / "grow_data_skills_raw.json"
CURRICULA_PATH = ROOT_DIR / "new_5_curricula.json"
SQLITE_PATH = DATA_DIR / "courseforge.sqlite3"
COVERS_DIR = DATA_DIR / "covers"
COURSES_DIR = ROOT_DIR / "courses"

COURSE_KEY = "Grow Data Skills Complete Data Engineering With Azure"
COURSE_TITLE = "Grow Data Skills — Complete Data Engineering with Azure, PySpark, Databricks & Snowflake"
INSTRUCTOR = "Grow Data Skills (GDS Faculty Team)"
CATEGORY = "Data Engineering & Cloud Analytics"
CLAIM_PREFIX = "grow-data-skills-azure"
CHANNEL_ID = -1003203876731

TAGS = [
    "Data Engineering",
    "Azure",
    "PySpark",
    "Apache Spark",
    "Databricks",
    "Delta Lake",
    "Snowflake",
    "Airflow",
    "Kafka",
    "Hadoop",
    "Hive",
    "SQL",
    "NoSQL",
    "GCP BigQuery",
    "Grow Data Skills",
    "Azure Data Factory"
]

DESCRIPTION = (
    "Comprehensive 77-lecture enterprise masterclass in modern Data Engineering and Cloud Analytics by Grow Data Skills. "
    "Covers production SQL, Hadoop ecosystem, Apache Hive, Apache Kafka real-time streaming, MongoDB and Cassandra NoSQL, "
    "Apache Spark and PySpark data processing, Azure Databricks lakehouse architecture, Apache Airflow orchestration, "
    "Snowflake data warehousing, GCP BigQuery, full Azure Cloud Stack (ADLS Gen2, Azure Data Factory, Synapse Analytics), "
    "real-world industrial capstone projects, and comprehensive resume and interview strategies."
)

MODULES = [
    (1, "Module 01", "Data Engineering Foundations & Production SQL", [
        "Master relational database concepts, schema architecture, and SQL query fundamentals",
        "Write complex filtering, analytical window functions, subqueries, CTEs, and query optimization",
    ]),
    (2, "Module 02", "Big Data Distributed Systems & Ecosystem (Hadoop, Hive, Kafka & NoSQL)", [
        "Learn distributed storage concepts with Hadoop HDFS and data warehousing with Apache Hive",
        "Implement real-time event streaming with Apache Kafka and distributed NoSQL with MongoDB and Cassandra",
    ]),
    (3, "Module 03", "Apache Spark & PySpark Large-Scale Data Processing", [
        "Understand Spark core architecture, RDDs, transformations, and memory execution engine",
        "Master PySpark DataFrames, structured transformations, partitioning, and performance tuning",
    ]),
    (4, "Module 04", "Modern Lakehouse Architecture, Databricks & Workflow Orchestration", [
        "Build modern lakehouse architectures using Azure Databricks, Delta Lake, and ACID transactions",
        "Orchestrate complex multi-stage data pipelines using Apache Airflow DAGs and scheduling",
    ]),
    (5, "Module 05", "Enterprise Cloud Data Warehousing (Snowflake & GCP BigQuery)", [
        "Design dimensional schemas, star/snowflake architectures, and modern cloud data warehouses",
        "Deep dive into Snowflake micro-partitions, Time Travel, zero-copy cloning, and GCP BigQuery",
    ]),
    (6, "Module 06", "Azure Cloud Data Engineering Stack (ADLS, ADF & Synapse Analytics)", [
        "Architect enterprise cloud data platforms on Microsoft Azure using ADLS Gen2",
        "Develop scalable ETL pipelines with Azure Data Factory (ADF) and analyze big data with Synapse",
    ]),
    (7, "Module 07", "Industrial End-to-End Capstone Projects & Career Acceleration", [
        "Implement production-grade end-to-end data engineering projects from ingestion to consumption",
        "Prepare high-impact resumes, optimize LinkedIn profiles, and master technical interview strategies",
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
    t = re.sub(r"[\s_]*@hmaracollege.*", "", t, flags=re.I)
    t = re.sub(r"[\s_]*@thebatmanreborn.*", "", t, flags=re.I)
    t = re.sub(r"^\d+\.\s*", "", t)  # strip leading number like "0. " or "1. "
    t = re.sub(r"\.mp4$", "", t, flags=re.I)
    t = re.sub(r"\.mkv$", "", t, flags=re.I)
    t = re.sub(r"\.pdf$", "", t, flags=re.I)
    t = re.sub(r"\s+", " ", t).strip(" -_")
    return t

def get_video_module(idx: int) -> tuple[int, str, str, list[str]]:
    if idx <= 10:
        m_idx = 1
    elif idx <= 28:
        m_idx = 2
    elif idx <= 46:
        m_idx = 3
    elif idx <= 55:
        m_idx = 4
    elif idx <= 63:
        m_idx = 5
    elif idx <= 71:
        m_idx = 6
    else:
        m_idx = 7
    m = MODULES[m_idx - 1]
    return m[0], m[1], m[2], m[3]

def get_doc_module(fn: str) -> tuple[int, str, str, list[str]]:
    low = fn.lower()
    if "spark" in low:
        m_idx = 3
    elif "dataset" in low or "material" in low:
        m_idx = 2
    elif "assignment" in low or "notes" in low:
        m_idx = 3
    else:
        m_idx = 1
    m = MODULES[m_idx - 1]
    return m[0], m[1], m[2], m[3]

def generate_cover_image() -> str:
    COVERS_DIR.mkdir(parents=True, exist_ok=True)
    h_name = hashlib.sha256(COURSE_KEY.encode()).hexdigest()
    out_path = COVERS_DIR / f"{h_name}.jpg"
    
    w, h = 1280, 720
    # Gradient: Midnight Slate (15, 23, 42) -> Deep Cyan/Azure (3, 105, 161)
    c1 = (15, 23, 42)
    c2 = (3, 105, 161)
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
        f_title = ImageFont.truetype(font_path, 40)
        f_sub = ImageFont.truetype(font_path, 26)
        f_meta = ImageFont.truetype(font_path, 22)
    except Exception:
        f_title = ImageFont.load_default()
        f_sub = ImageFont.load_default()
        f_meta = ImageFont.load_default()

    draw.text((96, 170), "DATA ENGINEERING & CLOUD ANALYTICS MASTERCLASS", fill=(56, 189, 248), font=f_meta)
    draw.text((96, 235), "GROW DATA SKILLS — COMPLETE DATA ENGINEERING", fill=(255, 255, 255), font=f_title)
    draw.text((96, 310), "Azure • PySpark • Apache Spark • Databricks • Snowflake • Kafka • Airflow", fill=(240, 245, 255), font=f_sub)
    draw.text((96, 370), "Grow Data Skills Faculty Team • 77 Video Lectures + 11 Industrial Datasets & Solutions", fill=(200, 230, 255), font=f_meta)
    draw.text((96, 560), "Verified CourseForge Curriculum  •  Strictly Monotonic 1..N Syllabus", fill=(255, 255, 255), font=f_meta)

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
    print(f"🚀 INITIATING GROW DATA SKILLS DATA ENGINEERING COURSE INTEGRATION")
    print("=" * 80)

    with open(RAW_FILE) as f:
        raw_data = json.load(f)

    vids_raw = [x for x in raw_data if x["is_video"]]
    docs_raw = [x for x in raw_data if x["is_document"]]
    print(f"Read {len(raw_data)} total messages: {len(vids_raw)} videos, {len(docs_raw)} documents.")

    items = []

    for idx, v in enumerate(vids_raw, start=1):
        txt = v.get("text", "").strip().split("\n")[0]
        fn = v.get("file_name") or f"Lecture_{idx}.mp4"
        raw_t = txt if txt else fn
        cl_t = clean_title(raw_t)

        m_num, m_tag, m_title, _ = get_video_module(idx)
        final_title = f"[{idx:03d}] {cl_t}"
        clean_fn = f"[{idx:03d}] {cl_t}.mp4"
        vid_id = "v_" + hashlib.sha1(f"{COURSE_KEY}:{v['id']}".encode()).hexdigest()[:12]
        claim_name = make_slug(f"{CLAIM_PREFIX}-{idx:03d}-{cl_t}")[:78]

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
        fn = d.get("file_name") or f"Material_{s_idx}.zip"
        cl_t = clean_title(fn)

        m_num, m_tag, m_title, _ = get_doc_module(fn)
        ext = Path(fn).suffix or ".zip"
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
        "learning_path_id": "lp_grow_data_skills_azure_2026",
        "learning_path_goal": "Master Modern Cloud Data Engineering with Azure, PySpark, Databricks, Snowflake & Kafka",
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
                VALUES (?, ?, ?, ?, ?, ?, 'ready', ?, 'en', ?, ?)
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
    print("\n🐘 Registering Course & Lessons in PostgreSQL...")
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

    print(f"  Successfully inserted Course, {len(MODULES)} Modules, and {len(vids_raw)} Lessons into PostgreSQL!")

    cdir = COURSES_DIR / COURSE_KEY
    cdir.mkdir(parents=True, exist_ok=True)
    print(f"  Created local directory: {cdir}")

    print("\n================================================================================")
    print(f"🎉 GROW DATA SKILLS COURSE SUCCESSFULLY ADDED TO COURSEFORGE!")
    print(f"   Total Queue: {len(curr_all)} courses in pipeline")
    print(f"   Videos: 77 | Study Materials: 11 | Modules: 7")
    print("================================================================================")

if __name__ == "__main__":
    main()
