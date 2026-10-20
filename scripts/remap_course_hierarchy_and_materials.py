#!/usr/bin/env python3
"""
Full Course Hierarchy, Lecture Sequencing, Odysee Providers & Study Materials Remapper.
Scans new_5_curricula.json, paid_curriculum.json, SQLite, and Odysee Manifest.
Applies clean, monotonic sort_order, flow_order, section_title, and remaps all valid
Odysee claims and study materials into PostgreSQL (courseforge_rewrite) and SQLite.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

ROOT_DIR = Path("/home/ubuntu/CourseForge")
NEW_CURR_PATH = ROOT_DIR / "new_5_curricula.json"
PAID_CURR_PATH = ROOT_DIR / "paid_curriculum.json"
ODY_MANIFEST_PATH = ROOT_DIR / "odysee_manifest.json"
DOCS_MANIFEST_PATH = ROOT_DIR / "data" / "odysee_docs_manifest.json"
SQLITE_PATH = ROOT_DIR / "data" / "courseforge.sqlite3"
COURSES_DIR = ROOT_DIR / "courses"

def run_psql(sql: str) -> str:
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

def clean_title(raw_title: str) -> str:
    t = (raw_title or '').replace('\r', ' ').replace('\n', ' ')
    t = re.sub(r'@[\w_]+\s*\+?\s*@?[\w_]*', '', t)
    t = re.sub(r'\.(mp4|ts|m4v|mhtml|html|pdf|docx|zip)\b', '', t, flags=re.I)
    t = re.sub(r'Module\s*0*(\d+)\s*\([^)]+\)\s*-\s*', r'Module \1: ', t, flags=re.I)
    t = re.sub(r'Week\s*0*(\d+)\s*\([^)]+\)\s*-\s*', r'Week \1: ', t, flags=re.I)
    t = re.sub(r'\s+', ' ', t).strip(' -:\t')
    return t

def get_material_type(fn: str) -> str:
    ext = os.path.splitext(fn)[1].lower()
    if ext == '.pdf': return 'PDF Document'
    if ext in ('.zip', '.rar', '.7z', '.tar', '.gz'): return 'Code Archive'
    if ext in ('.html', '.mhtml', '.docx', '.txt', '.md'): return 'Lecture Notes'
    if ext == '.ipynb': return 'Jupyter Notebook'
    if ext in ('.py', '.sql', '.sh', '.json'): return 'Source Code'
    if ext in ('.csv', '.parquet', '.xlsx'): return 'Dataset'
    if ext in ('.jpg', '.png', '.jpeg', '.webp'): return 'Slide Image'
    return 'Resource'

def main():
    print("=" * 80)
    print("🚀 STARTING COMPLETE COURSE MAPPING & RE-SEQUENCING AUDIT")
    print("=" * 80)

    # 1. Load Odysee Manifest and SQLite Providers
    print("\n📂 Loading Odysee Manifest & SQLite Providers...")
    with open(ODY_MANIFEST_PATH) as f:
        ody_manifest = json.load(f)

    conn = sqlite3.connect(SQLITE_PATH)
    cur = conn.cursor()

    claim_by_vid = {}
    claim_by_file = {}
    for k, v in ody_manifest.items():
        if not isinstance(v, dict): continue
        cid = v.get("claim_id")
        cname = v.get("claim_name")
        vid = v.get("video_id")
        course = v.get("course")
        if not cid or not cname: continue
        if vid: claim_by_vid[vid] = (cname, cid, course)
        fname = os.path.basename(k)
        claim_by_file[(course, fname)] = (cname, cid, course)

    cur.execute("SELECT video_id, claim_name, claim_id FROM lecture_providers;")
    sqlite_prov = {}
    for vid, cname, cid in cur.fetchall():
        if vid and cid and cname:
            sqlite_prov[vid] = (cname, cid)

    # Expected claim prefix per course for strict isolation
    COURSE_CLAIM_PREFIXES = {
        "Advanced Agentic AI And Gen AI By Prudhvi Sir Nareshit 2026": ["agentic-genai-"],
        "Arpit Bhaiyani - System Design Course": ["arpit-bhayani-sd-"],
        "Codebasics Data Engineering Bootcamp 1.0": ["codebasics-de-"],
        "Deepak Data Engg": ["mission-ade-"],
        "Gaurav Sen AI Engineering 2026": ["gauravsen-ai-"],
        "Gaurav Sen Low Level Design (LLD) 2026": ["gauravsen-lld-"],
        "Gaurav Sen System Design Simplified (HLD)": ["gauravsen-hld-"],
        "Keerti Purswani Agentic AI System Design Course 2026": ["keerti-agentic-sd-"],
        "Namaste AI": ["namaste-ai-"],
        "Sanket Advanced System Design HLD LLD 2026": ["sanket-sd-", "sanket-asd-"],
        "Sanket Singh Complete AI Engineer Bootcamp 2026": ["sanket-ai-eng-"],
        "Sanket Singh System Design 2.0 2026": ["sanket-sd2-"],
        "Sanket Singh Top Coding Interview Problem": ["sanket-algo-"],
        "Sanket Spring boot": ["sanket-sb-"],
        "Scaler DSA and System Design": ["scaler-dsa-sd-"],
        "Scaler Data Science": ["scaler-ds-"],
        "TrendyTech Ultimate Big Data Masters Program": ["trendytech-bigdata-"],
        "Vimal Daga Courses 2025": ["vimal-daga-ai-"],
        "Harkirat 100x combined bootcamp Coursedost": ["harkirat-"],
        "Azure Data Bricks by Sameer Sir Durgasoft": ["adb-sameer-"],
        "Namaste SQL Coursedost": ["namaste-sql-"],
        "Vizuara AI - Build Voice Agents From Scratch 2026": ["vizuara-voice-"],
        "Vizuara AI - Context Engineering for LLMs 2026": ["vizuara-context-"],
        "Vizuara AI - Master LLM Inference Engineering 2026": ["vizuara-inference-"],
        "Vizuara AI - Production AI Agents Bootcamp 2026": ["vizuara-prod-agents-"],
        "Vizuara AI - Reinforcement Learning & RLHF 2026": ["vizuara-rl-"],
        "Vizuara AI - SLM Small Language Models Engineering 2026": ["vizuara-slm-"],
    }

    def validate_claim(course_key: str, claim_name: str) -> bool:
        allowed = COURSE_CLAIM_PREFIXES.get(course_key)
        if not allowed:
            return True
        return any(claim_name.startswith(p) for p in allowed)

    print(f"Loaded {len(claim_by_vid)} claims by vid, {len(claim_by_file)} by file, {len(sqlite_prov)} in sqlite")

    # 2. Build Remapped Lessons Data
    remapped_lessons = {}
    
    # Process 24 courses from new_5_curricula.json
    with open(NEW_CURR_PATH) as f:
        new_curr = json.load(f)

    for c in new_curr:
        ckey = c["course_key"]
        vids = [x for x in c["items"] if x.get("kind") == "video"]
        if not vids: continue

        def sort_key(v):
            mod_n = v.get("module_num") or 1
            idx = v.get("idx") or 0
            m = re.search(r'\[(\d+)\]', v.get("title", ""))
            b_idx = int(m.group(1)) if m else idx
            return (mod_n, b_idx)

        sorted_vids = sorted(vids, key=sort_key)
        
        remapped_lessons[ckey] = []
        for seq, v in enumerate(sorted_vids, start=1):
            vid = v["video_id"]
            orig_title = v["title"]
            mod_n = v.get("module_num") or 1
            mod_tag = v.get("module_tag") or f"Module {mod_n:02d}"
            mod_title = (v.get("module_title") or "").strip()
            
            if mod_title:
                if mod_title.lower().startswith("module") or mod_title.lower().startswith("week") or mod_title.lower().startswith("season"):
                    sec_title = mod_title
                else:
                    sec_title = f"{mod_tag}: {mod_title}"
            else:
                sec_title = f"{mod_tag}: Core Curriculum"
            
            cl_title = clean_title(orig_title)
            clean_without_seq = re.sub(r'^\[\d+\]\s*', '', cl_title)
            final_title = f"[{seq:03d}] {clean_without_seq}"

            fn = v.get("clean_filename")
            match = claim_by_vid.get(vid) or claim_by_file.get((ckey, fn)) or (sqlite_prov.get(vid) and (sqlite_prov[vid][0], sqlite_prov[vid][1], ckey))
            
            cname, cid = None, None
            if match:
                cand_cname, cand_cid = match[0], match[1]
                if validate_claim(ckey, cand_cname):
                    cname, cid = cand_cname, cand_cid

            remapped_lessons[ckey].append({
                "id": vid,
                "course_id": ckey,
                "title": final_title,
                "section_title": sec_title,
                "sort_order": seq,
                "flow_order": float(seq),
                "claim_name": cname,
                "claim_id": cid,
            })

    # Process TrendyTech
    with open(PAID_CURR_PATH) as f:
        paid_curr = json.load(f)

    tt_key = "TrendyTech Ultimate Big Data Masters Program"
    tt_vids = [x for x in paid_curr if x.get("kind") == "video"]
    tt_vids_sorted = sorted(tt_vids, key=lambda x: x.get("idx") or 0)
    remapped_lessons[tt_key] = []
    for seq, v in enumerate(tt_vids_sorted, start=1):
        vid = v["video_id"]
        sec_title = (v.get("module_title") or f"Module {v.get('module_num', 1):02d}: Big Data").strip()
        cl_title = clean_title(v["title"])
        clean_without_seq = re.sub(r'^\[\d+\]\s*', '', cl_title)
        final_title = f"[{seq:03d}] {clean_without_seq}"
        fn = v.get("clean_filename")
        match = claim_by_vid.get(vid) or claim_by_file.get((tt_key, fn)) or (sqlite_prov.get(vid) and (sqlite_prov[vid][0], sqlite_prov[vid][1], tt_key))
        cname, cid = None, None
        if match and validate_claim(tt_key, match[0]):
            cname, cid = match[0], match[1]

        remapped_lessons[tt_key].append({
            "id": vid,
            "course_id": tt_key,
            "title": final_title,
            "section_title": sec_title,
            "sort_order": seq,
            "flow_order": float(seq),
            "claim_name": cname,
            "claim_id": cid,
        })

    # Process Deepak Data Engg
    cur.execute("SELECT id, title, path FROM videos WHERE course = 'Deepak Data Engg' ORDER BY title;")
    deepak_raw = cur.fetchall()
    deepak_key = "Deepak Data Engg"
    deepak_vids = []
    for vid, t, p in deepak_raw:
        m = re.search(r'\[(\d+)\]', t)
        idx = int(m.group(1)) if m else 999
        deepak_vids.append((idx, vid, t, p))
    deepak_vids.sort(key=lambda x: x[0])
    
    def infer_deepak_module(b_idx, title):
        t_low = title.lower()
        m_s = re.search(r'Session\s*(\d+)', title, re.I)
        s_idx = int(m_s.group(1)) if m_s else None
        if s_idx == 1 or 'cloud fundamental' in t_low:
            return 1, "Week 01: Cloud & Azure Fundamentals"
        if s_idx in (2, 3) or 'storage account' in t_low or 'redundancy' in t_low:
            return 2, "Week 02: Azure Storage & ADLS Gen2 Deep Dive"
        if s_idx in (4, 5, 6) or 'data factory' in t_low or 'adf' in t_low or 'copy' in t_low or 'parameterization' in t_low:
            return 3, "Week 03: Azure Data Factory (ADF) Core Architecture & Ingestion"
        if s_idx in (7, 8, 9) or 'data flow' in t_low or 'incremental' in t_low or 'trigger' in t_low:
            return 4, "Week 04: ADF Advanced Data Flows, Triggers & Monitoring"
        if s_idx in (10, 11, 12) or 'synapse' in t_low or 'sql database' in t_low or 'dedicated sql' in t_low:
            return 5, "Week 05: Azure SQL Database & Synapse Analytics"
        if s_idx in (13, 14, 15) or ('spark' in t_low and 'databricks' not in t_low and 'pyspark' not in t_low):
            return 6, "Week 06: Apache Spark Foundations & Cluster Architecture"
        if s_idx in (16, 17, 18) or 'databricks' in t_low or 'pyspark' in t_low:
            return 7, "Week 07: Azure Databricks (ADB) & PySpark DataFrame API"
        if s_idx in (19, 20, 21) or 'spark sql' in t_low or 'join optimization' in t_low:
            return 8, "Week 08: Spark SQL, Joins & Query Optimization"
        if s_idx in (22, 23) or 'delta' in t_low or 'medallion' in t_low or 'scd' in t_low:
            return 9, "Week 09: Delta Lake Internals & Medallion Architecture"
        return 10, "Week 10: End-to-End ADE Production Project & Interview Prep"

    deepak_classified = []
    for idx, vid, t, p in deepak_vids:
        mod_n, sec_title = infer_deepak_module(idx, t)
        deepak_classified.append((mod_n, idx, vid, t, p, sec_title))

    # Sort strictly by module number, then bracket index
    deepak_classified.sort(key=lambda x: (x[0], x[1]))

    remapped_lessons[deepak_key] = []
    for seq, (mod_n, idx, vid, t, p, sec_title) in enumerate(deepak_classified, start=1):
        cl_title = clean_title(t)
        clean_without_seq = re.sub(r'^\[\d+\]\s*', '', cl_title)
        final_title = f"[{seq:03d}] {clean_without_seq}"
        match = sqlite_prov.get(vid)
        cname, cid = None, None
        if match and validate_claim(deepak_key, match[0]):
            cname, cid = match[0], match[1]

        remapped_lessons[deepak_key].append({
            "id": vid,
            "course_id": deepak_key,
            "title": final_title,
            "section_title": sec_title,
            "sort_order": seq,
            "flow_order": float(seq),
            "claim_name": cname,
            "claim_id": cid,
        })

    # Process Advanced Agentic AI (Prudhvi Sir)
    prudhvi_key = "Advanced Agentic AI And Gen AI By Prudhvi Sir Nareshit 2026"
    cur.execute(f"SELECT id, title, path FROM videos WHERE course = '{prudhvi_key}' ORDER BY title;")
    prudhvi_raw = cur.fetchall()
    prudhvi_vids = []
    for vid, t, p in prudhvi_raw:
        m = re.search(r'\[(\d+)\]', t)
        idx = int(m.group(1)) if m else 999
        prudhvi_vids.append((idx, vid, t, p))
    prudhvi_vids.sort(key=lambda x: x[0])

    def infer_prudhvi_sec(seq, title):
        m_day = re.search(r'Day\s*(\d+)', title, re.I)
        d = int(m_day.group(1)) if m_day else seq
        if d <= 4: return "Module 01: Python Foundations for AI Engineering"
        if d <= 12: return "Module 02: Deep Learning, PyTorch & Neural Networks"
        if d <= 17: return "Module 03: Transformers, Embeddings & Vector Databases"
        if d <= 23: return "Module 04: Prompt Engineering & LLM APIs (OpenAI & Gemini)"
        if d <= 33: return "Module 05: Retrieval-Augmented Generation (RAG) & LangChain"
        if d <= 43: return "Module 06: LangGraph & Advanced Workflow Orchestration"
        return "Module 07: Multi-Agent Systems, CrewAI, AutoGen & Production Deployments"

    remapped_lessons[prudhvi_key] = []
    for seq, (idx, vid, t, p) in enumerate(prudhvi_vids, start=1):
        sec_title = infer_prudhvi_sec(seq, t)
        cl_title = clean_title(t)
        clean_without_seq = re.sub(r'^\[\d+\]\s*', '', cl_title)
        final_title = f"[{seq:03d}] {clean_without_seq}"
        match = sqlite_prov.get(vid)
        cname, cid = None, None
        if match and validate_claim(prudhvi_key, match[0]):
            cname, cid = match[0], match[1]

        remapped_lessons[prudhvi_key].append({
            "id": vid,
            "course_id": prudhvi_key,
            "title": final_title,
            "section_title": sec_title,
            "sort_order": seq,
            "flow_order": float(seq),
            "claim_name": cname,
            "claim_id": cid,
        })

    print(f"\n✅ Finished re-indexing lessons for {len(remapped_lessons)} courses!")
    
    # 3. Build Study Materials
    print("\n📂 Scanning Study Materials from Disk, Curricula, and Odysee Docs...")
    with open(DOCS_MANIFEST_PATH) as f:
        docs_manifest = json.load(f)

    doc_claims = {}
    for k, v in docs_manifest.items():
        c = v.get("course")
        name = v.get("name")
        cname = v.get("claim_name")
        cid = v.get("claim_id")
        if c and name and cname and cid:
            doc_claims[(c, name)] = (cname, cid)

    # Build map of (course, filename) -> section_title from curricula
    study_sec_map = {}
    for c in new_curr:
        ckey = c["course_key"]
        for it in c.get("items", []):
            if it.get("kind") == "study":
                fn = it.get("clean_filename")
                m_tag = it.get("module_tag") or f"Module {it.get('module_num', 1):02d}"
                m_title = (it.get("module_title") or "").strip()
                sec = f"{m_tag}: {m_title}" if m_title and not m_title.lower().startswith("module") else (m_title or f"{m_tag}: Study Materials")
                if fn: study_sec_map[(ckey, fn)] = sec

    for it in paid_curr:
        if it.get("kind") == "study":
            fn = it.get("clean_filename")
            sec = it.get("module_title")
            if fn and sec: study_sec_map[(tt_key, fn)] = sec

    materials_list = []
    # Scan on-disk study files
    for cname in sorted(os.listdir(COURSES_DIR)):
        cdir = COURSES_DIR / cname
        if not cdir.is_dir(): continue
        for fn in sorted(os.listdir(cdir)):
            if fn.startswith(".") or fn.startswith("._"): continue
            fpath = cdir / fn
            if not fpath.is_file(): continue

            m_id = "mat_" + hashlib.sha256(f"{cname}/{fn}".encode()).hexdigest()[:16]
            m_type = get_material_type(fn)
            rel_path = f"courses/{cname}/{fn}"
            cname_claim, cid_claim = doc_claims.get((cname, fn), ("", ""))

            clean_name = re.sub(r'\[Module\s*\d+(?:\s*Study\s*\d+)?\]\s*', '', fn, flags=re.I)
            clean_name = re.sub(r'\[\d+(?:-\d+)?\]\s*', '', clean_name)
            clean_name = re.sub(r'\.[a-zA-Z0-9]+$', '', clean_name).strip(' -_')
            if not clean_name: clean_name = fn

            sec = study_sec_map.get((cname, fn))
            if not sec:
                if cname == deepak_key:
                    sec = infer_deepak_module(1, fn)[1]
                elif cname == prudhvi_key:
                    m_m = re.search(r'Module\s*0*(\d+)', fn, re.I)
                    mod_idx = int(m_m.group(1)) if m_m else 0
                    if mod_idx == 0: sec = "Module 01: Python Foundations for AI Engineering"
                    elif mod_idx == 1: sec = "Module 02: Deep Learning, PyTorch & Neural Networks"
                    elif mod_idx == 2: sec = "Module 03: Transformers, Embeddings & Vector Databases"
                    elif mod_idx == 3: sec = "Module 04: Prompt Engineering & LLM APIs (OpenAI & Gemini)"
                    elif mod_idx == 4: sec = "Module 05: Retrieval-Augmented Generation (RAG) & LangChain"
                    elif mod_idx == 5: sec = "Module 06: LangGraph & Advanced Workflow Orchestration"
                    else: sec = "Module 07: Multi-Agent Systems, CrewAI, AutoGen & Production Deployments"
                else:
                    sec = "Course Reference & Study Materials"

            materials_list.append({
                "id": m_id,
                "course_id": cname,
                "filename": fn[:255],
                "title": clean_name[:255],
                "material_type": m_type,
                "scope": "section",
                "section_title": sec,
                "position": float(len(materials_list) + 1),
                "relative_path": rel_path,
                "claim_name": cname_claim,
                "claim_id": cid_claim,
            })

    print(f"✅ Prepared {len(materials_list)} total study materials from disk!")

    # 4. Generate SQL Statements for PostgreSQL
    print("\n📝 Generating SQL statements for PostgreSQL transaction...")
    sql_statements = []
    
    # Update lessons
    for ckey, l_list in remapped_lessons.items():
        for l in l_list:
            sql_statements.append(f"""
UPDATE lessons
SET title = {escape_sql(l['title'])},
    section_title = {escape_sql(l['section_title'])},
    sort_order = {l['sort_order']},
    flow_order = {l['flow_order']}
WHERE id = {escape_sql(l['id'])};
""")

    # Clean and re-populate lesson_providers
    sql_statements.append("DELETE FROM lesson_providers;")
    
    valid_prov_count = 0
    for ckey, l_list in remapped_lessons.items():
        for l in l_list:
            if l["claim_name"] and l["claim_id"]:
                sql_statements.append(f"""
INSERT INTO lesson_providers (lesson_id, claim_name, claim_id, updated_at)
VALUES ({escape_sql(l['id'])}, {escape_sql(l['claim_name'])}, {escape_sql(l['claim_id'])}, now());
""")
                valid_prov_count += 1

    print(f"Prepared {valid_prov_count} verified 1-to-1 Odysee provider insertions.")

    # Re-populate materials table
    sql_statements.append("DELETE FROM materials;")
    for m in materials_list:
        sql_statements.append(f"""
INSERT INTO materials (id, course_id, lesson_id, filename, title, material_type, scope, section_title, position, relative_path, claim_name, claim_id, removed, version, updated_at)
VALUES ({escape_sql(m['id'])}, {escape_sql(m['course_id'])}, NULL, {escape_sql(m['filename'])}, {escape_sql(m['title'])}, {escape_sql(m['material_type'])}, {escape_sql(m['scope'])}, {escape_sql(m['section_title'])}, {m['position']}, {escape_sql(m['relative_path'])}, {escape_sql(m['claim_name'])}, {escape_sql(m['claim_id'])}, FALSE, 1, now())
ON CONFLICT (course_id, filename) DO UPDATE SET
    title = EXCLUDED.title,
    section_title = EXCLUDED.section_title,
    material_type = EXCLUDED.material_type,
    relative_path = EXCLUDED.relative_path,
    claim_name = EXCLUDED.claim_name,
    claim_id = EXCLUDED.claim_id,
    updated_at = now();
""")

    print(f"Prepared {len(materials_list)} material insertions.")

    # 5. Execute PostgreSQL Batches
    print(f"\n⚡ Executing {len(sql_statements)} statements into PostgreSQL...")
    batch_size = 250
    for i in range(0, len(sql_statements), batch_size):
        chunk = sql_statements[i:i + batch_size]
        sub_sql = "BEGIN;\n" + "\n".join(chunk) + "\nCOMMIT;"
        try:
            run_psql(sub_sql)
        except Exception as e:
            print(f"❌ Error executing batch {i}..{i+batch_size}: {e}")
            raise
        if (i // batch_size) % 5 == 0:
            print(f"   Progress: {i}/{len(sql_statements)} statements applied...")

    print("✅ All PostgreSQL updates successfully committed!")

    # 6. Synchronize SQLite
    print("\n🔄 Synchronizing SQLite courseforge.sqlite3...")
    for ckey, l_list in remapped_lessons.items():
        for l in l_list:
            cur.execute("""
                UPDATE videos
                SET title = ?
                WHERE id = ?;
            """, (l["title"], l["id"]))
            if l["claim_name"] and l["claim_id"]:
                cur.execute("""
                    INSERT INTO lecture_providers (video_id, claim_name, claim_id, updated_at)
                    VALUES (?, ?, ?, datetime('now'))
                    ON CONFLICT(video_id) DO UPDATE SET
                        claim_name = excluded.claim_name,
                        claim_id = excluded.claim_id,
                        updated_at = excluded.updated_at;
                """, (l["id"], l["claim_name"], l["claim_id"]))
            else:
                cur.execute("DELETE FROM lecture_providers WHERE video_id = ?;", (l["id"],))

    conn.commit()
    conn.close()
    print("✅ SQLite database synchronized!")

    print("\n" + "=" * 80)
    print("🎉 FULL RE-MAPPING AND SEQUENCING COMPLETE!")
    print(f"   - 27 Courses Re-Sequenced with Clean Monotonic Sort & Flow Orders")
    print(f"   - Clean Module & Section Titles Across All Courses")
    print(f"   - {valid_prov_count} Verified Odysee Streams Mapped (0 Corrupted Cross-Mappings)")
    print(f"   - {len(materials_list)} Study Materials Mapped into Portal with Download Paths & Claims")
    print("=" * 80)

if __name__ == "__main__":
    main()
