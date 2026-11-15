#!/usr/bin/env python3
"""
Integrate:
1. Advanced Ansible Tower - DO447 by Vimal Daga Sir (17 videos, 7 modules, 13 companion docs)
2. Complete remaining Azure Data Bricks by Sameer Sir Durgasoft (Sessions 41 to 70, 3 modules)

Updates:
- new_5_curricula.json
- PostgreSQL (courses, lessons)
- SQLite courseforge.sqlite3 (course_metadata, videos)
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

import psycopg2

ROOT_DIR = Path("/home/ubuntu/CourseForge")
CURRICULA_PATH = ROOT_DIR / "new_5_curricula.json"
SQLITE_PATH = ROOT_DIR / "data/courseforge.sqlite3"
PG_DSN = "postgresql://courseforge:local_rewrite_only@127.0.0.1:15439/courseforge_rewrite"

def sanitize_filename(s: str) -> str:
    s = re.sub(r'[\\/:*?"<>|\r\n]+', " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s[:130]

def make_slug(s: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")
    return re.sub(r"-+", "-", s)

def main():
    print("🚀 Starting Integration of DO447 and ADB Sessions 41-70...")
    
    # -------------------------------------------------------------
    # 1. Load Raw Telegram Dumps
    # -------------------------------------------------------------
    with open("/tmp/ansible_do447_raw.json") as f:
        ansible_raw = json.load(f)
        
    with open("/tmp/adb_sessions_41_70_raw.json") as f:
        adb_remaining_raw = json.load(f)
        
    with open(CURRICULA_PATH) as f:
        curricula = json.load(f)
        
    # -------------------------------------------------------------
    # 2. Build DO447 Course Structure
    # -------------------------------------------------------------
    do447_vids_raw = [m for m in ansible_raw if m.get("is_video")]
    print(f"DO447 raw videos: {len(do447_vids_raw)}")
    
    # Define exact DO447 syllabus and titles
    do447_definitions = [
        # Prerequisites (Module 01)
        (1, 1, "Module 01", "Cloud & Linux Foundations for Automation", 
         "AWS Account Creation & Security Setup", "1. AWS Account Creation.mp4", 836),
        (2, 1, "Module 01", "Cloud & Linux Foundations for Automation", 
         "AWS RedHat Enterprise Linux Instance Launch & Security Groups", "2. AWS RedHat Linux Instance Launch.mp4", 837),
        (3, 1, "Module 01", "Cloud & Linux Foundations for Automation", 
         "AWS SSH Key Management & PuTTY Connect Workflow", "3. AWS - Putty Connect Setup.mp4", 838),
        (4, 1, "Module 01", "Cloud & Linux Foundations for Automation", 
         "Linux System Administration & Shell Command Essentials", "4. Linux Basic Commands.mp4", 839),
        
        # Module 02
        (5, 2, "Module 02", "Core Ansible & Controller Architecture", 
         "Basics of Ansible Core & Ansible Controller Node Architecture", "Session_1_18th_Dec_Basic_of_Ansible_Core_Ansible_controller.mp4", 841),
        
        # Module 03
        (6, 3, "Module 03", "Ansible Tower Fundamentals, RBAC & Execution", 
         "Role-Based Access Control (RBAC), Ansible Tower Service & Ad-Hoc Commands", "Session_2_25th_Dec_'RBAC_Ansible_tower_service_command_.mp4", 843),
        (7, 3, "Module 03", "Ansible Tower Fundamentals, RBAC & Execution", 
         "Privilege Escalation, Machine Credentials & Job Template Execution", "Session 3 - 8th Jan - 'Previlage escalation - Job.mp4", 845),
        (8, 3, "Module 03", "Ansible Tower Fundamentals, RBAC & Execution", 
         "Workflow Job Templates, Inventory Management & Notification Schemes", "Session_4_15th_Jan_'_Workflow_Template_Creating_inventory_&.mp4", 847),
        
        # Module 04
        (9, 4, "Module 04", "Dynamic Inventories & Cloud Provisioning", 
         "Smart Dynamic Inventory, AWS IAM Roles & Cloud EC2 Automation", "Session 5 - 28th Jan - Smart Inventory - Creating IAM user -.mp4", 850),
        (10, 4, "Module 04", "Dynamic Inventories & Cloud Provisioning", 
         "Provisioning Managed Target Nodes & Multi-Tier Controller Setup", "Session_6_26th_Feb_setup_ansible_controller_node_and_target_node.mp4", 852),
        
        # Module 05
        (11, 5, "Module 05", "Modular Playbooks, Roles & Inventory Plugins", 
         "Modular Ansible Roles, Galaxy Management & Reusable Automation", "Session_7_4th_March_Ansible_role_manages_Ansible_installs_roles.mp4", 853),
        (12, 5, "Module 05", "Modular Playbooks, Roles & Inventory Plugins", 
         "Custom & Dynamic Inventory Plugins, Static vs Dynamic Grouping", "Session_8_5th_March_Ansible_inventory_Types_of_inventory_Static.mp4", 855),
        
        # Module 06
        (13, 6, "Module 06", "Advanced Templating, Filters & Jinja2 Lookup Plugins", 
         "Jinja2 Advanced Transformations, Filters & Multi-Tier Templates", "Session_9_18th_March_filter_variables_playbook_or_template_Jinja2.mp4", 857),
        (14, 6, "Module 06", "Advanced Templating, Filters & Jinja2 Lookup Plugins", 
         "Lookup Plugins, External Data Queries & Jinja2 Expressions", "Session 10 - 19th March-lookup plugind-jinja2-query - #13.mp4", 859),
        
        # Module 07
        (15, 7, "Module 07", "Supplementary Automation Tooling & Hands-On Practice", 
         "Git Version Control for Playbook CI/CD Pipelines", "Git - #13.mp4", 864),
        (16, 7, "Module 07", "Supplementary Automation Tooling & Hands-On Practice", 
         "Regular Expressions (Regex) in Text Parsing & Automation", "Regex - #13.mp4", 865),
        (17, 7, "Module 07", "Supplementary Automation Tooling & Hands-On Practice", 
         "Comprehensive DO447 Hands-On Practice & Lab Troubleshooting", "Practice Session 19th May - #13.mp4", 867),
    ]
    
    do447_items = []
    course_key_do447 = "Advanced Ansible Tower - DO447 by Vimal Daga Sir"
    claim_prefix_do447 = "vimal-ansible-do447-2026"
    
    # Map raw sizes
    raw_size_map = {m["id"]: m.get("file_size", 0) for m in do447_vids_raw}
    raw_dur_map = {m["id"]: m.get("duration", 0.0) for m in do447_vids_raw}
    
    for idx, mod_num, mod_tag, mod_title, lesson_name, orig_fn, msg_id in do447_definitions:
        full_title = f"[{idx:03d}] {mod_tag}: {lesson_name}"
        clean_fn = sanitize_filename(f"[{idx:03d}] {mod_tag} - {lesson_name}.mp4")
        v_id = f"v_{hashlib.sha1(f'{course_key_do447}:{idx}:{msg_id}'.encode()).hexdigest()[:12]}"
        cl_name = f"{claim_prefix_do447}-{idx:03d}-{make_slug(lesson_name)[:42]}"
        sz = raw_size_map.get(msg_id, 0)
        dur = raw_dur_map.get(msg_id, 0.0)
        
        do447_items.append({
            "idx": idx,
            "msg_id": msg_id,
            "kind": "video",
            "module_num": mod_num,
            "module_tag": mod_tag,
            "module_title": mod_title,
            "title": full_title,
            "clean_filename": clean_fn,
            "orig_filename": orig_fn,
            "needs_remux": False,
            "size": sz,
            "duration": dur,
            "video_id": v_id,
            "claim_name": cl_name,
            "claim_id": None,
            "video_url": None,
            "stream_url": None
        })
        
    do447_modules = [
        {"num": 1, "tag": "Module 01", "title": "Cloud & Linux Foundations for Automation", "objectives": ["Provision AWS cloud infrastructure, configure secure SSH keys, and master Linux administrative essentials."]},
        {"num": 2, "tag": "Module 02", "title": "Core Ansible & Controller Architecture", "objectives": ["Understand Ansible engine mechanics, controller node configuration, and declarative YAML execution models."]},
        {"num": 3, "tag": "Module 03", "title": "Ansible Tower Fundamentals, RBAC & Execution", "objectives": ["Deploy Ansible Tower, implement enterprise Role-Based Access Control (RBAC), and launch scheduled job templates."]},
        {"num": 4, "tag": "Module 04", "title": "Dynamic Inventories & Cloud Provisioning", "objectives": ["Automate AWS EC2 fleet discovery with smart dynamic inventories, IAM role delegations, and security policies."]},
        {"num": 5, "tag": "Module 05", "title": "Modular Playbooks, Roles & Inventory Plugins", "objectives": ["Design reusable Ansible roles, manage Ansible Galaxy collections, and develop custom dynamic inventory plugins."]},
        {"num": 6, "tag": "Module 06", "title": "Advanced Templating, Filters & Jinja2 Lookup Plugins", "objectives": ["Master Jinja2 templating, external data lookups, environment queries, and complex list/dictionary filtering."]},
        {"num": 7, "tag": "Module 07", "title": "Supplementary Automation Tooling & Hands-On Practice", "objectives": ["Integrate Git CI/CD pipelines, parse configuration files with regular expressions, and complete full DO447 certification labs."]}
    ]
    
    do447_course_entry = {
        "course_key": course_key_do447,
        "course_title": "Advanced Ansible Tower — DO447 Automation Masterclass by Vimal Daga Sir",
        "instructor": "Vimal Daga Sir (LinuxWorld)",
        "category": "DevOps, Cloud Automation & Infrastructure as Code",
        "tags": ["Ansible", "Ansible Tower", "DO447", "Red Hat", "Vimal Daga", "LinuxWorld", "DevOps", "Automation", "RBAC", "CI/CD"],
        "description": "Complete Red Hat Advanced Automation (DO447) and Ansible Tower Masterclass by industry veteran Vimal Daga Sir (LinuxWorld). Covers enterprise Ansible automation, AWX / Ansible Tower architecture, dynamic cloud inventories (AWS EC2 / IAM), privilege escalation, workflow job templates, modular Ansible roles & Galaxy, Jinja2 filters & lookup plugins, Git version-controlled playbooks, regex data parsing, and full DO447 certification practice labs.",
        "channel_id": -1002434190660,
        "topic_id": 219,
        "claim_prefix": claim_prefix_do447,
        "learning_path_id": "lp_vimal_ansible_do447_2026",
        "learning_path_goal": "Master Red Hat Advanced Automation (DO447), Ansible Tower Architecture, RBAC, Dynamic Inventories, and Production Playbook Workflows with Vimal Daga Sir",
        "cover_colors": [[15, 23, 42], [185, 28, 28], "ANSIBLE TOWER DO447 • VIMAL DAGA", "Complete Enterprise Automation • Red Hat DO447 Masterclass"],
        "modules": do447_modules,
        "items": do447_items
    }
    
    # -------------------------------------------------------------
    # 3. Build Remaining ADB Items (Sessions 41 to 70)
    # -------------------------------------------------------------
    adb_remaining_definitions = [
        # Module 06: Advanced Delta Lake Operations & PySpark Analytics (Sessions 41-50)
        (41, 6, "Module 06", "Advanced Delta Lake Operations, ACID Deep Dive & Time Travel",
         "Delta Lake Internal Metadata, Version Log (_delta_log) & Schema Evolution", 3218),
        (42, 6, "Module 06", "Advanced Delta Lake Operations, ACID Deep Dive & Time Travel",
         "Time Travel Queries, Version Rollback & Snapshot Restoration", 3219),
        (43, 6, "Module 06", "Advanced Delta Lake Operations, ACID Deep Dive & Time Travel",
         "Advanced Delta Table Optimization — Compaction, OPTIMIZE & Z-ORDER Partitioning", 3220),
        (44, 6, "Module 06", "Advanced Delta Lake Operations, ACID Deep Dive & Time Travel",
         "Delta Vacuuming, Retention Policies & Dry Run Operations", 3221),
        (45, 6, "Module 06", "Advanced Delta Lake Operations, ACID Deep Dive & Time Travel",
         "Delta Merge & Upsert Scenarios with Dynamic Partition Pruning", 3222),
        (46, 6, "Module 06", "Advanced Delta Lake Operations, ACID Deep Dive & Time Travel",
         "Change Data Feed (CDF) & Table CDC Ingestion Patterns", 3223),
        (47, 6, "Module 06", "Advanced Delta Lake Operations, ACID Deep Dive & Time Travel",
         "PySpark Advanced Transformations & Window Ranking Functions", 3224),
        (48, 6, "Module 06", "Advanced Delta Lake Operations, ACID Deep Dive & Time Travel",
         "PySpark Complex Data Types — Structs, Arrays, Maps & Explode", 3225),
        (49, 6, "Module 06", "Advanced Delta Lake Operations, ACID Deep Dive & Time Travel",
         "Custom User Defined Functions (UDFs) & Vectorized Pandas UDFs", 3226),
        (50, 6, "Module 06", "Advanced Delta Lake Operations, ACID Deep Dive & Time Travel",
         "Spark Catalyst Optimizer, Physical Query Plans & Join Strategies", 3227),

        # Module 07: Enterprise Databricks Workflows, Auto Loader & Streaming Pipelines (Sessions 51-60)
        (51, 7, "Module 07", "Enterprise Databricks Workflows, Auto Loader & Streaming Pipelines",
         "Databricks Workflows & Multi-Task Job Orchestration", 3228),
        (52, 7, "Module 07", "Enterprise Databricks Workflows, Auto Loader & Streaming Pipelines",
         "Job Clusters vs All-Purpose Compute Lifecycle & Cost Optimization", 3229),
        (53, 7, "Module 07", "Enterprise Databricks Workflows, Auto Loader & Streaming Pipelines",
         "Incremental Ingestion with Databricks Auto Loader (cloudFiles)", 3230),
        (54, 7, "Module 07", "Enterprise Databricks Workflows, Auto Loader & Streaming Pipelines",
         "Schema Inference & Schema Evolution in Auto Loader", 3231),
        (55, 7, "Module 07", "Enterprise Databricks Workflows, Auto Loader & Streaming Pipelines",
         "Event Hub & Kafka Real-Time Stream Integration with Spark Structured Streaming", 3232),
        (56, 7, "Module 07", "Enterprise Databricks Workflows, Auto Loader & Streaming Pipelines",
         "Stateful Streaming, Watermarking & Handling Late Arriving Data", 3233),
        (57, 7, "Module 07", "Enterprise Databricks Workflows, Auto Loader & Streaming Pipelines",
         "Delta Live Tables (DLT) Declarative Pipeline Architecture", 3234),
        (58, 7, "Module 07", "Enterprise Databricks Workflows, Auto Loader & Streaming Pipelines",
         "DLT Expectations, Data Quality Constraints & Failure Policies", 3235),
        (59, 7, "Module 07", "Enterprise Databricks Workflows, Auto Loader & Streaming Pipelines",
         "Unity Catalog Architecture — 3-Level Namespace, Metastores & Catalogs", 3236),
        (60, 7, "Module 07", "Enterprise Databricks Workflows, Auto Loader & Streaming Pipelines",
         "Unity Catalog Data Governance, Access Control Lists (ACLs) & Object Grants", 3237),

        # Module 08: End-to-End Enterprise Lakehouse Capstone & Performance Mastery (Sessions 61-70)
        (61, 8, "Module 08", "End-to-End Enterprise Lakehouse Capstone & Performance Mastery",
         "Dynamic Views, Column Masking & Row-Level Filtering with Unity Catalog", 3238),
        (62, 8, "Module 08", "End-to-End Enterprise Lakehouse Capstone & Performance Mastery",
         "Databricks Repos, Git Integration & Enterprise CI/CD Pipelines", 3239),
        (63, 8, "Module 08", "End-to-End Enterprise Lakehouse Capstone & Performance Mastery",
         "Azure Key Vault Integration & Databricks Secrets Management", 3240),
        (64, 8, "Module 08", "End-to-End Enterprise Lakehouse Capstone & Performance Mastery",
         "Medallion Architecture Implementation — Bronze Layer Raw Ingestion", 3241),
        (65, 8, "Module 08", "End-to-End Enterprise Lakehouse Capstone & Performance Mastery",
         "Medallion Architecture Implementation — Silver Layer Cleaning & Normalization", 3242),
        (66, 8, "Module 08", "End-to-End Enterprise Lakehouse Capstone & Performance Mastery",
         "Medallion Architecture Implementation — Gold Layer Business Aggregations & Star Schema", 3243),
        (67, 8, "Module 08", "End-to-End Enterprise Lakehouse Capstone & Performance Mastery",
         "Delta Lake Performance Diagnostics, Skew Handling & Salting Techniques", 3244),
        (68, 8, "Module 08", "End-to-End Enterprise Lakehouse Capstone & Performance Mastery",
         "Databricks SQL Warehouses, Dashboards & BI Tool Connectivity (Power BI)", 3245),
        (69, 8, "Module 08", "End-to-End Enterprise Lakehouse Capstone & Performance Mastery",
         "Real-World Industry Project Review, Architecture Patterns & Best Practices", 3246),
        (70, 8, "Module 08", "End-to-End Enterprise Lakehouse Capstone & Performance Mastery",
         "Interview Preparation, Scenario Questions & Enterprise Databricks Certification Wrap-up", 3247),
    ]

    adb_raw_map = {m["id"]: m for m in adb_remaining_raw}
    course_key_adb = "Azure Data Bricks by Sameer Sir Durgasoft"
    claim_prefix_adb = "sameer-azure-databricks"
    
    adb_new_items = []
    for idx, mod_num, mod_tag, mod_title, lesson_name, msg_id in adb_remaining_definitions:
        full_title = f"[{idx:02d}] {mod_tag} - {lesson_name}"
        clean_fn = sanitize_filename(f"[{idx:02d}] {mod_tag} - {lesson_name}.mp4")
        v_id = f"v_{hashlib.sha1(f'{course_key_adb}:{idx}:{msg_id}'.encode()).hexdigest()[:12]}"
        cl_name = f"{claim_prefix_adb}-{idx:02d}-{make_slug(lesson_name)[:42]}"
        raw_info = adb_raw_map.get(msg_id, {})
        sz = raw_info.get("size", 0)
        dur = raw_info.get("duration", 0.0)
        orig_fn = raw_info.get("file_name", f"Session - {idx} .mp4")
        
        adb_new_items.append({
            "idx": idx,
            "msg_id": msg_id,
            "kind": "video",
            "module_num": mod_num,
            "module_tag": mod_tag,
            "module_title": mod_title,
            "title": full_title,
            "clean_filename": clean_fn,
            "orig_filename": orig_fn,
            "needs_remux": False,
            "size": sz,
            "duration": dur,
            "video_id": v_id,
            "claim_name": cl_name,
            "claim_id": None,
            "video_url": None,
            "stream_url": None
        })

    adb_new_modules = [
        {"num": 6, "tag": "Module 06", "title": "Advanced Delta Lake Operations, ACID Deep Dive & Time Travel", "objectives": ["Master Delta Lake transaction logs, time travel rollbacks, OPTIMIZE/Z-ORDER, and advanced PySpark UDFs."]},
        {"num": 7, "tag": "Module 07", "title": "Enterprise Databricks Workflows, Auto Loader & Streaming Pipelines", "objectives": ["Implement Databricks Workflows, Auto Loader incremental ingestion, Delta Live Tables (DLT), and Unity Catalog governance."]},
        {"num": 8, "tag": "Module 08", "title": "End-to-End Enterprise Lakehouse Capstone & Performance Mastery", "objectives": ["Build end-to-end Medallion pipelines (Bronze, Silver, Gold), tune query performance, and connect Databricks SQL to Power BI."]}
    ]

    # -------------------------------------------------------------
    # 4. Update new_5_curricula.json
    # -------------------------------------------------------------
    # Find ADB course in curricula
    adb_idx = None
    for i, c in enumerate(curricula):
        if c.get("course_key") == course_key_adb:
            adb_idx = i
            break
            
    if adb_idx is not None:
        adb_course = curricula[adb_idx]
        adb_course["cover_colors"] = [[15, 23, 42], [14, 116, 144], "AZURE DATABRICKS • SAMEER SIR", "70 Complete Sessions • Apache Spark, ADLS Gen2 & Delta Lake"]
        adb_course["description"] = "Master Azure Databricks (ADB) end-to-end with Sameer Sir from DurgaSoft. Complete 70-session hands-on masterclass covering distributed cluster architectures, worker autoscaling, Spark DataFrames, DBUtils widgets, cloud storage connectors (ADLS Gen2, Azure Blob, SQL DB, Synapse Analytics), Azure Key Vault secrets, multi-format schema enforcement (Parquet, ORC, JSON, CSV, XML, Excel), Spark Structured Streaming, deep Delta Lake internals (ACID transactions, time travel, Z-Ordering, OPTIMIZE, VACUUM), Auto Loader, Delta Live Tables (DLT), Unity Catalog governance, and production Medallion lakehouse projects."
        
        # Add new modules if not present
        existing_mod_nums = {m["num"] for m in adb_course.get("modules", [])}
        for nm in adb_new_modules:
            if nm["num"] not in existing_mod_nums:
                adb_course["modules"].append(nm)
                
        # Append sessions 41-70 to items
        existing_item_indices = {it["idx"] for it in adb_course.get("items", [])}
        for it in adb_new_items:
            if it["idx"] not in existing_item_indices:
                adb_course["items"].append(it)
                
        print(f"✅ Updated ADB in curricula: now has {len(adb_course['modules'])} modules and {len(adb_course['items'])} items.")
    else:
        print("❌ Could not find ADB course in curricula!")

    # Check if DO447 is already in curricula
    do447_exists = any(c.get("course_key") == course_key_do447 for c in curricula)
    if not do447_exists:
        # Insert near Vimal Daga Courses 2025 (or at index 15)
        insert_pos = 15
        for i, c in enumerate(curricula):
            if c.get("course_key") == "Vimal Daga Courses 2025":
                insert_pos = i + 1
                break
        curricula.insert(insert_pos, do447_course_entry)
        print(f"✅ Inserted DO447 into curricula at position {insert_pos} with {len(do447_items)} items.")
    else:
        print("ℹ️ DO447 already in curricula.")

    # Save updated curricula
    with open(CURRICULA_PATH, "w") as f:
        json.dump(curricula, f, indent=2)
    print("💾 Saved updated new_5_curricula.json")

    # -------------------------------------------------------------
    # 5. Sync to PostgreSQL
    # -------------------------------------------------------------
    pg_conn = psycopg2.connect(PG_DSN)
    pg_cur = pg_conn.cursor()
    
    # Register DO447 in courses
    pg_cur.execute("""
        INSERT INTO courses (id, title)
        VALUES (%s, %s)
        ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title;
    """, (course_key_do447, do447_course_entry["course_title"]))
    print(f"✅ Registered '{course_key_do447}' in PostgreSQL courses table.")

    # Insert DO447 lessons
    now_utc = datetime.now(timezone.utc)
    for it in do447_items:
        pg_cur.execute("""
            INSERT INTO lessons (id, course_id, title, sort_order, duration_seconds, status, section_title, created_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (id) DO UPDATE SET
                title = EXCLUDED.title,
                sort_order = EXCLUDED.sort_order,
                section_title = EXCLUDED.section_title;
        """, (it["video_id"], course_key_do447, it["title"], it["idx"], float(it["duration"] or 0), 'queued', it["module_title"], now_utc))
    print(f"✅ Registered {len(do447_items)} lessons for DO447 in PostgreSQL.")

    # Insert ADB Sessions 41-70 lessons
    for it in adb_new_items:
        pg_cur.execute("""
            INSERT INTO lessons (id, course_id, title, sort_order, duration_seconds, status, section_title, created_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (id) DO UPDATE SET
                title = EXCLUDED.title,
                sort_order = EXCLUDED.sort_order,
                section_title = EXCLUDED.section_title;
        """, (it["video_id"], course_key_adb, it["title"], it["idx"], float(it["duration"] or 0), 'queued', it["module_title"], now_utc))
    print(f"✅ Registered {len(adb_new_items)} remaining lessons for ADB in PostgreSQL.")

    pg_conn.commit()
    pg_cur.close()
    pg_conn.close()

    # -------------------------------------------------------------
    # 6. Sync to SQLite courseforge.sqlite3
    # -------------------------------------------------------------
    sq_conn = sqlite3.connect(SQLITE_PATH)
    sq_cur = sq_conn.cursor()

    # DO447 course_metadata
    sq_cur.execute("""
        INSERT INTO course_metadata (course, title, instructor, category, tags_json, cover_kind, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (course) DO UPDATE SET
            title = excluded.title,
            instructor = excluded.instructor,
            category = excluded.category,
            tags_json = excluded.tags_json,
            updated_at = excluded.updated_at;
    """, (
        course_key_do447,
        do447_course_entry["course_title"],
        do447_course_entry["instructor"],
        do447_course_entry["category"],
        json.dumps(do447_course_entry["tags"]),
        "red",
        now_utc.isoformat()
    ))

    # ADB course_metadata update
    sq_cur.execute("""
        UPDATE course_metadata 
        SET updated_at = ? 
        WHERE course = ?;
    """, (now_utc.isoformat(), course_key_adb))

    # DO447 videos in SQLite
    for it in do447_items:
        rel_path = f"courses/{course_key_do447}/{it['clean_filename']}"
        sq_cur.execute("""
            INSERT INTO videos (id, path, course, title, bytes, mtime_ns, status, duration, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (id) DO UPDATE SET
                path = excluded.path,
                title = excluded.title,
                bytes = excluded.bytes;
        """, (it["video_id"], rel_path, course_key_do447, it["title"], it["size"], 0, 'queued', float(it["duration"] or 0), now_utc.isoformat()))
    print(f"✅ Synchronized {len(do447_items)} DO447 videos into SQLite.")

    # ADB Sessions 41-70 videos in SQLite
    for it in adb_new_items:
        rel_path = f"courses/{course_key_adb}/{it['clean_filename']}"
        sq_cur.execute("""
            INSERT INTO videos (id, path, course, title, bytes, mtime_ns, status, duration, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (id) DO UPDATE SET
                path = excluded.path,
                title = excluded.title,
                bytes = excluded.bytes;
        """, (it["video_id"], rel_path, course_key_adb, it["title"], it["size"], 0, 'queued', float(it["duration"] or 0), now_utc.isoformat()))
    print(f"✅ Synchronized {len(adb_new_items)} ADB videos into SQLite.")

    sq_conn.commit()
    sq_conn.close()
    
    print("\n🎉 SUCCESS: DO447 and ADB Sessions 41-70 fully integrated into curricula, PostgreSQL, and SQLite!")

if __name__ == "__main__":
    main()
