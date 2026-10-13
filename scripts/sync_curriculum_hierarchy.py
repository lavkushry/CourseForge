#!/usr/bin/env python3
"""
Synchronizes curriculum hierarchy, module sections, course metadata, and Odysee
lecture providers from new_5_curricula.json, paid_curriculum.json, and SQLite
into the PostgreSQL courseforge_rewrite database.
"""
import json
import re
import sqlite3
import subprocess
import sys

SQLITE_PATH = "data/courseforge.sqlite3"
NEW_CURRICULA_PATH = "new_5_curricula.json"
PAID_CURRICULUM_PATH = "paid_curriculum.json"

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

def escape_sql(val):
    if val is None:
        return "NULL"
    return "'" + str(val).replace("'", "''") + "'"

def main():
    print("Loading curriculum sources...")
    con = sqlite3.connect(SQLITE_PATH)
    cur = con.cursor()

    # 1. Map course metadata from new_5_curricula.json
    course_meta = {}
    video_to_section = {}
    video_to_order = {}

    with open(NEW_CURRICULA_PATH) as f:
        new_curr = json.load(f)

    for c in new_curr:
        ckey = c.get("course_key")
        if ckey:
            course_meta[ckey] = {
                "title": c.get("course_title"),
                "instructor": c.get("instructor"),
                "category": c.get("category"),
                "tags": c.get("tags") or [],
                "description": c.get("description"),
            }
        for item in c.get("items", []):
            vid = item.get("video_id")
            sec = item.get("module_title") or item.get("module_tag")
            if vid and sec:
                video_to_section[vid] = sec.strip()
                if "idx" in item:
                    video_to_order[vid] = item["idx"]

    print(f"Loaded {len(course_meta)} courses and {len(video_to_section)} sections from {NEW_CURRICULA_PATH}")

    # 2. Map TrendyTech from paid_curriculum.json
    with open(PAID_CURRICULUM_PATH) as f:
        paid = json.load(f)

    trendy_count = 0
    for item in paid:
        vid = item.get("video_id")
        sec = item.get("module_title")
        if vid and sec:
            if vid not in video_to_section:
                video_to_section[vid] = sec.strip()
                trendy_count += 1
            if "idx" in item:
                video_to_order[vid] = item["idx"]

    print(f"Loaded {trendy_count} sections for TrendyTech from {PAID_CURRICULUM_PATH}")

    # 3. Load SQLite syllabi for extra mappings
    cur.execute("SELECT course, content_json FROM syllabi")
    for row in cur.fetchall():
        try:
            data = json.loads(row[1])
            for mod in data.get("modules", []):
                mtitle = mod.get("title")
                for src in mod.get("sources", []):
                    vid = src.get("video_id")
                    if vid and mtitle and vid not in video_to_section:
                        video_to_section[vid] = mtitle.strip()
        except Exception:
            pass

    # 4. Fallback for remaining videos (Deepak, Prudhvi Sir Agentic AI, etc.)
    sys.path.insert(0, ".")
    from app.course_metadata import infer_section_title
    cur.execute("SELECT id, course, title, path FROM videos ORDER BY course, path")
    all_videos = cur.fetchall()
    fallback_count = 0
    for idx, (vid, course, title, path) in enumerate(all_videos, 1):
        if vid not in video_to_section:
            c_low = (course or '').lower()
            if 'deepak' in c_low or 'azure data' in c_low:
                m_sess = re.search(r'Session\s*(\d+)', title, re.I)
                s_idx = int(m_sess.group(1)) if m_sess else idx
                sec = infer_section_title(course, title, s_idx)
            elif 'agentic ai' in c_low:
                m_num = re.search(r'\[(\d+)\]', title)
                num = int(m_num.group(1)) if m_num else idx
                sec = infer_section_title(course, title, num)
            else:
                m = re.search(r'Module \d+ \(([^)]+)\)', title) or re.search(r'Session (\d+)(?: \[Live\])?\s+([A-Za-z0-9 &_-]+?)(?:\s+Part\s+\d+|\s+Q&A|$)', title)
                if m:
                    sec = m.group(0).strip()
                else:
                    m_sess = re.search(r'(?:Session|Module|Week)\s*0*(\d+)', title, re.I)
                    num = int(m_sess.group(1)) if m_sess else idx
                    sec = infer_section_title(course, title, num)
            video_to_section[vid] = sec.strip()
            fallback_count += 1

    print(f"Assigned fallback sections for {fallback_count} videos.")
    print(f"Total mapped videos: {len(video_to_section)} / {len(all_videos)}")

    # 5. Build SQL updates for courses and lessons
    sql_statements = []

    # Update course metadata in PG
    for ckey, meta in course_meta.items():
        tags_arr = "ARRAY[" + ", ".join(escape_sql(t) for t in meta["tags"]) + "]::text[]" if meta["tags"] else "'{}'::text[]"
        sql_statements.append(f"""
UPDATE courses
SET description = COALESCE(NULLIF({escape_sql(meta['description'])}, ''), description),
    instructor = COALESCE(NULLIF({escape_sql(meta['instructor'])}, ''), instructor),
    category = COALESCE(NULLIF({escape_sql(meta['category'])}, ''), category),
    tags = CASE WHEN array_length({tags_arr}, 1) > 0 THEN {tags_arr} ELSE tags END,
    published = TRUE
WHERE id = {escape_sql(ckey)};
""")

    # Ensure TrendyTech, Deepak, Prudhvi Sir have rich descriptions and categories
    sql_statements.append(f"""
UPDATE courses
SET description = 'Comprehensive Masterclass on Cloud Data Engineering, Apache Spark, Databricks, Hadoop, Kafka, and Production Distributed Pipelines.',
    category = 'Data Engineering',
    instructor = 'Sumit Mittal (TrendyTech)',
    tags = ARRAY['Spark', 'Databricks', 'Big Data', 'Kafka', 'Hadoop', 'AWS', 'Python', 'SQL']::text[],
    published = TRUE
WHERE id = 'TrendyTech Ultimate Big Data Masters Program';

UPDATE courses
SET description = 'Production Azure Data Engineering masterclass covering ADLS Gen2, Azure Data Factory (ADF), Databricks, Synapse Analytics, PySpark, and Delta Lake.',
    category = 'Cloud Data Engineering',
    instructor = 'Deepak Goyal',
    tags = ARRAY['Azure', 'ADF', 'ADLS', 'Databricks', 'PySpark', 'Delta Lake', 'SQL']::text[],
    published = TRUE
WHERE id = 'Deepak Data Engg';

UPDATE courses
SET description = 'Masterclass in Agentic AI architectures, LLM internals, LangChain, LangGraph, CrewAI, AutoGen, Multi-Agent Collaboration, and Vector Search.',
    category = 'AI & Agents',
    instructor = 'Prudhvi Sir (NareshIT)',
    tags = ARRAY['Agentic AI', 'LLMs', 'LangGraph', 'CrewAI', 'Python', 'RAG', 'Vector DB', 'Ollama']::text[],
    published = TRUE
WHERE id = 'Advanced Agentic AI And Gen AI By Prudhvi Sir Nareshit 2026';
""")

    # Update lessons section_title in PG
    print("Preparing lesson section updates...")
    update_count = 0
    for vid, sec in video_to_section.items():
        ord_val = video_to_order.get(vid)
        order_clause = f", sort_order = {ord_val}, flow_order = {float(ord_val)}" if ord_val else ""
        sql_statements.append(f"""
UPDATE lessons
SET section_title = {escape_sql(sec)}{order_clause}
WHERE id = {escape_sql(vid)};
""")
        update_count += 1

    # 6. Synchronize all Odysee providers from SQLite lecture_providers
    print("Checking Odysee providers in SQLite...")
    cur.execute("SELECT video_id, claim_name, claim_id, updated_at FROM lecture_providers")
    providers = cur.fetchall()
    
    # Query existing lesson IDs in PostgreSQL to guarantee foreign key integrity
    pg_lessons_raw = run_psql("SELECT id FROM lessons;")
    existing_pg_lessons = set(line.strip() for line in pg_lessons_raw.strip().split('\n') if line.strip())
    print(f"Found {len(providers)} providers in SQLite and {len(existing_pg_lessons)} lessons in Postgres.")
    
    provider_count = 0
    for vid, cname, cid, uat in providers:
        if vid and cid and vid in existing_pg_lessons:
            sql_statements.append(f"""
INSERT INTO lesson_providers (lesson_id, claim_name, claim_id, updated_at)
VALUES ({escape_sql(vid)}, {escape_sql(cname)}, {escape_sql(cid)}, {escape_sql(uat or 'now()')})
ON CONFLICT (lesson_id) DO UPDATE SET
    claim_name = EXCLUDED.claim_name,
    claim_id = EXCLUDED.claim_id,
    updated_at = EXCLUDED.updated_at;
""")
            provider_count += 1
    print(f"Adding {provider_count} valid providers to Postgres...")


    print(f"Executing {len(sql_statements)} statements via psql...")
    
    # Run in batches so we can track errors and progress
    batch_size = 200
    for i in range(0, len(sql_statements), batch_size):
        chunk = sql_statements[i:i + batch_size]
        sub_sql = "BEGIN;\n" + "\n".join(chunk) + "\nCOMMIT;"
        try:
            run_psql(sub_sql)
        except Exception as e:
            print(f"Error executing batch {i}..{i+batch_size}: {e}")
            for stmt in chunk:
                try:
                    run_psql("BEGIN;\n" + stmt + "\nCOMMIT;")
                except Exception as inner_e:
                    print(f"FAILED STATEMENT: {stmt[:150]}... Error: {inner_e}")
            raise

    print("Successfully synchronized curriculum hierarchy, sections, and Odysee providers!")

if __name__ == "__main__":
    main()
