#!/usr/bin/env python3
"""
Builder and Registrar for 4 New Major Courses:
1. Namaste Node.js (Akshay Saini — All 3 Seasons, 44 Videos)
2. NeetCode System Design Course (NeetCode — 30 Videos)
3. Azure Data Engineering 2026 (Bhaskar Jogi — 125 Videos + 5 Docs)
4. DevOps with Multi-Cloud & AI (Veerababu Sir — 174 Days + 1 Doc)
"""
from __future__ import annotations

import collections
import hashlib
import json
import os
import re
import sqlite3
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT_DIR = Path("/home/ubuntu/CourseForge")
DATA_DIR = ROOT_DIR / "data"
CURRICULA_PATH = ROOT_DIR / "new_5_curricula.json"
SQLITE_PATH = DATA_DIR / "courseforge.sqlite3"
COVERS_DIR = DATA_DIR / "covers"
COURSES_DIR = ROOT_DIR / "courses"

def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")

def sanitize_filename(s: str) -> str:
    s = re.sub(r'[\\/:*?"<>|\r\n]+', " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s[:130]

def make_slug(s: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")
    return re.sub(r"-+", "-", s)

def escape_sql(val: str) -> str:
    if val is None:
        return "NULL"
    return "'" + str(val).replace("'", "''") + "'"

def run_psql(sql: str) -> str:
    cmd = [
        "docker", "exec", "-i", "courseforge-rewrite-postgres-1",
        "psql", "-U", "courseforge", "-d", "courseforge_rewrite", "-v", "ON_ERROR_STOP=1"
    ]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    out, err = proc.communicate(input=sql)
    if proc.returncode != 0:
        raise RuntimeError(f"psql failed ({proc.returncode}): {err}")
    return out

def generate_cover(course_key: str, tag: str, title: str, subtitle: str, bg_c1: tuple, bg_c2: tuple) -> str:
    COVERS_DIR.mkdir(parents=True, exist_ok=True)
    h_name = hashlib.sha256(course_key.encode()).hexdigest()
    out_path = COVERS_DIR / f"{h_name}.jpg"
    
    w, h = 1280, 720
    img = Image.new("RGB", (w, h), bg_c1)
    draw = ImageDraw.Draw(img)
    for y in range(h):
        t = y / h
        r = int(bg_c1[0] * (1 - t) + bg_c2[0] * t)
        g = int(bg_c1[1] * (1 - t) + bg_c2[1] * t)
        b = int(bg_c1[2] * (1 - t) + bg_c2[2] * t)
        draw.line([(0, y), (w, y)], fill=(r, g, b))

    draw.rounded_rectangle([48, 48, w - 48, h - 48], radius=28, outline=(255, 255, 255), width=3)
    
    font_path = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
    if not os.path.exists(font_path):
        font_path = "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"
        
    try:
        f_title = ImageFont.truetype(font_path, 38)
        f_sub = ImageFont.truetype(font_path, 24)
        f_meta = ImageFont.truetype(font_path, 22)
    except Exception:
        f_title = ImageFont.load_default()
        f_sub = ImageFont.load_default()
        f_meta = ImageFont.load_default()

    draw.text((96, 170), tag.upper(), fill=(56, 189, 248), font=f_meta)
    
    # Split title if too long
    if len(title) > 42 and "—" in title:
        parts = title.split("—", 1)
        draw.text((96, 230), parts[0].strip() + " —", fill=(255, 255, 255), font=f_title)
        draw.text((96, 285), parts[1].strip(), fill=(255, 255, 255), font=f_title)
        draw.text((96, 360), subtitle, fill=(240, 245, 255), font=f_sub)
    elif len(title) > 42:
        draw.text((96, 235), title[:42], fill=(255, 255, 255), font=f_title)
        draw.text((96, 290), title[42:], fill=(255, 255, 255), font=f_title)
        draw.text((96, 365), subtitle, fill=(240, 245, 255), font=f_sub)
    else:
        draw.text((96, 235), title, fill=(255, 255, 255), font=f_title)
        draw.text((96, 310), subtitle, fill=(240, 245, 255), font=f_sub)

    draw.text((96, h - 110), "COURSEFORGE ACCELERATED VERIFIED CURRICULUM", fill=(148, 163, 184), font=f_meta)
    img.save(str(out_path), "JPEG", quality=92)
    return f"covers/{h_name}.jpg"

# -------------------------------------------------------------
# BUILDERS FOR EACH OF THE 4 COURSES
# -------------------------------------------------------------

def build_namaste_nodejs():
    raw_path = ROOT_DIR / "namaste_nodejs_raw.json"
    with open(raw_path) as f:
        raw_items = json.load(f)

    course_key = "Namaste Node.js"
    course_title = "Namaste Node.js — Complete Backend Architecture, DevTinder & Cloud Deployment (Seasons 1, 2 & 3)"
    instructor = "Akshay Saini (NamasteDev)"
    category = "Backend Engineering & Node.js"
    claim_prefix = "namaste-nodejs"
    channel_id = -1002856874660

    tags = [
        "Node.js", "Backend Development", "JavaScript", "libuv", "V8 Engine",
        "Express", "MongoDB", "DevTinder", "AWS", "Nginx", "WebSockets", "Socket.io",
        "NamasteDev", "Akshay Saini", "System Design"
    ]

    description = (
        "Master enterprise backend engineering from scratch to production with Akshay Saini's flagship 44-episode masterclass. "
        "Season 1 explores Node.js core internals (V8 engine, libuv, thread pool, event loop phases, CommonJS/ES modules, and streams). "
        "Season 2 walks through end-to-end production backend development building DevTinder (Express, REST APIs, Mongoose schemas, "
        "JWT cookies, bcrypt encryption, compound indexing, and full frontend UI integration). Season 3 guides cloud deployment and "
        "production scaling (AWS EC2, NGINX reverse proxies, custom SSL domains, Amazon SES email delivery, cron automation, "
        "Razorpay payments, and real-time WebSockets with Socket.io)."
    )

    modules = [
        {"module_num": 1, "module_tag": "Module 01", "module_title": "Season 1: Node.js Architecture, V8 & libuv Internals",
         "outcomes": ["Understand V8 JavaScript engine, libuv async I/O, event loop phases and thread pool internals",
                      "Master CommonJS vs ES module systems, require mechanics, and Node core APIs"]},
        {"module_num": 2, "module_tag": "Module 02", "module_title": "Season 2: DevTinder Backend Architecture, Express & MongoDB",
         "outcomes": ["Design scalable RESTful APIs with Express, routing handlers, custom middlewares and error handling",
                      "Implement MongoDB with Mongoose schemas, JWT cookie authentication, bcrypt hashing, and compound indexing"]},
        {"module_num": 3, "module_tag": "Module 03", "module_title": "Season 2: DevTinder Full-Stack UI Integration",
         "outcomes": ["Connect DevTinder backend to frontend client application with Redux state management",
                      "Build interactive user feed cards, swipe matching actions, profile management and reviews"]},
        {"module_num": 4, "module_tag": "Module 04", "module_title": "Season 3: Cloud Deployment, DevOps, Security & Real-Time Production",
         "outcomes": ["Deploy Node.js to AWS EC2 with NGINX reverse proxy, PM2 process management and SSL domains",
                      "Implement Amazon SES transactional email, automated cron jobs, Razorpay payments and Socket.io WebSockets"]},
    ]

    s1_titles = {
        4: "Episode 00: Welcome to Namaste Node.js",
        5: "Episode 01: Introduction to Node.js & V8 Runtime",
        6: "Episode 02: JavaScript on Server & C++ Core",
        7: "Episode 03: Writing Your First Node.js Code",
        8: "Episode 04: module.exports & require (CommonJS & ES Modules)",
        9: "Episode 05: Diving into Node.js Source Code & GitHub Repo",
        10: "Episode 06: libuv & Asynchronous I/O Architecture",
        11: "Episode 07: Sync, Async & setTimeoutZero",
        12: "Episode 08: Deep Dive into V8 JS Engine (Ignition & TurboFan)",
        13: "Episode 09: libuv & Event Loop Internals",
        14: "Episode 10: Event Loop Execution Phases (Part 1)",
        15: "Episode 10: Event Loop Microtasks & Callbacks (Part 2)",
        16: "Episode 11: Thread Pool in libuv & Creating an HTTP Server",
        17: "Episode 12: Databases in Node.js (SQL vs NoSQL Architecture)",
        18: "Episode 13: Creating MongoDB Database & Node Connection",
    }

    s2_titles = {
        21: "Episode 00: Introduction to DevTinder Project Architecture",
        22: "Episode 01: Microservices vs Monolith Architecture",
        23: "Episode 02: Features, HLD, LLD & Project Planning",
        24: "Episode 03: Creating Express Server & Routing",
        25: "Episode 04: Routing & Request Handlers",
        26: "Episode 05: Middlewares & Error Handling",
        27: "Episode 06: Database Schema & Models with Mongoose",
        28: "Episode 07: Diving into REST APIs (CRUD Operations)",
        29: "Episode 08: Data Sanitization & Schema Validations",
        30: "Episode 09: Encrypting Passwords with Bcrypt",
        31: "Episode 10: User Authentication, JWT Tokens & Cookies",
        32: "Episode 11: Express Router & Modular Architecture",
        33: "Episode 12: Logical Queries & Compound Indexes",
        34: "Episode 13: Ref, Populate & Relational Document Modeling",
        35: "Episode 14: Feed API & Cursor/Offset Pagination",
        36: "Episode 15: DevTinder Frontend UI — Setup & Components (Part 1)",
        37: "Episode 16: DevTinder Frontend UI — Authentication & Redux Store (Part 2)",
        38: "Episode 17: DevTinder Frontend UI — Feed Cards & Swiping Interaction (Part 3)",
        39: "Episode 18: DevTinder Frontend UI — Profile Management & Edit Views (Part 4)",
        40: "Episode 19: DevTinder Frontend UI — Connection Requests & Matches View (Part 5)",
    }

    s3_titles = {
        43: "Episode 01: Launching AWS EC2 Instance & Cloud Setup",
        44: "Episode 02: NGINX Reverse Proxy & Backend App Management (PM2)",
        45: "Episode 03: Custom Domain Configuration & SSL Certificates",
        46: "Episode 04: Sending Transactional Emails with Amazon SES",
        47: "Episode 05: Environment Variables & Secrets Management (.env)",
        48: "Episode 06: Scheduling Automated Cron Jobs",
        49: "Episode 07: Payment Gateway Integration ft. Razorpay",
        50: "Episode 08: Real-Time WebSockets with Socket.io",
        51: "Episode 09: Production Optimization, Performance & Horizontal Scaling",
    }

    vids_raw = [x for x in raw_items if x.get("is_video")]
    vids_raw.sort(key=lambda x: x.get("id"))

    items = []
    idx = 1
    for v in vids_raw:
        mid = v["id"]
        if mid in s1_titles:
            m_num = 1
            m_tag = "Module 01"
            m_title = "Season 1: Node.js Architecture, V8 & libuv Internals"
            title_text = s1_titles[mid]
        elif mid in s2_titles:
            if mid >= 36:
                m_num = 3
                m_tag = "Module 03"
                m_title = "Season 2: DevTinder Full-Stack UI Integration"
            else:
                m_num = 2
                m_tag = "Module 02"
                m_title = "Season 2: DevTinder Backend Architecture, Express & MongoDB"
            title_text = s2_titles[mid]
        elif mid in s3_titles:
            m_num = 4
            m_tag = "Module 04"
            m_title = "Season 3: Cloud Deployment, DevOps, Security & Real-Time Production"
            title_text = s3_titles[mid]
        else:
            m_num = 4
            m_tag = "Module 04"
            m_title = "Season 3: Cloud Deployment, DevOps, Security & Real-Time Production"
            title_text = f"Episode: {v.get('file_name', 'Lesson')}"

        dur = float(v.get("duration") or 3600.0)
        clean_name = f"[{idx:03d}] {title_text}"
        vid_id = "v_" + hashlib.sha256(f"{course_key}:{clean_name}:{idx}".encode()).hexdigest()[:12]
        cname = f"{claim_prefix}-{idx:03d}-{make_slug(title_text)[:35]}".strip("-")

        items.append({
            "idx": idx,
            "msg_id": mid,
            "kind": "video",
            "module_num": m_num,
            "module_tag": m_tag,
            "module_title": m_title,
            "title": clean_name,
            "clean_filename": f"{clean_name}.mp4",
            "orig_filename": v.get("file_name") or f"video_{mid}.mp4",
            "needs_remux": False,
            "size": v.get("file_size") or 0,
            "duration": dur,
            "video_id": vid_id,
            "claim_name": cname,
        })
        idx += 1

    return {
        "course_key": course_key,
        "course_title": course_title,
        "instructor": instructor,
        "category": category,
        "tags": tags,
        "description": description,
        "channel_id": channel_id,
        "topic_id": None,
        "claim_prefix": claim_prefix,
        "learning_path_id": "backend-nodejs-expert",
        "learning_path_goal": "Master Enterprise Node.js, Systems Architecture & Production Deployment",
        "modules": modules,
        "items": items,
        "cover_meta": ("BACKEND ARCHITECTURE & NODE.JS", "NAMASTE NODE.JS", "All 3 Seasons • Akshay Saini • DevTinder & Cloud Deployment", (15, 23, 42), (16, 185, 129))
    }

def build_neetcode_system_design():
    raw_path = ROOT_DIR / "neetcode_system_design_raw.json"
    with open(raw_path) as f:
        raw_items = json.load(f)

    course_key = "NeetCode System Design Course"
    course_title = "NeetCode — System Design for Beginners & Distributed Interview Masterclass"
    instructor = "NeetCode (Navdeep Singh)"
    category = "High Level System Design & Distributed Systems"
    claim_prefix = "neetcode-sd"
    channel_id = -1002641367045

    tags = [
        "System Design", "NeetCode", "Distributed Systems", "Software Architecture",
        "High Level Design", "Scalability", "Consistent Hashing", "Rate Limiting",
        "Caching", "Message Queues", "CAP Theorem", "Microservices", "Navdeep Singh"
    ]

    description = (
        "Complete 30-lecture System Design masterclass by NeetCode covering fundamental building blocks "
        "and high-level architectural interview case studies. Part 1 covers computer architecture, design requirements, "
        "networking protocols (TCP/UDP, DNS, HTTP, WebSockets), API design, caching strategies, CDNs, proxies, load balancing, "
        "consistent hashing, SQL vs NoSQL, database replication/sharding, CAP theorem, object storage, and message queues. "
        "Part 2 walks through real-world architectural case studies: Rate Limiter, TinyURL, Twitter feed architecture, "
        "Discord real-time chat, YouTube video streaming pipeline, Google Drive file sync, Google Maps geospatial routing, "
        "distributed key-value store, and distributed message broker."
    )

    modules = [
        {"module_num": 1, "module_tag": "Module 01", "module_title": "System Design Fundamentals & Networking Protocols",
         "outcomes": ["Understand computer architecture bottlenecks, tiered systems, and non-functional requirements",
                      "Master transport layer protocols, DNS resolution, HTTP/HTTPS and real-time WebSockets"]},
        {"module_num": 2, "module_tag": "Module 02", "module_title": "API Architecture, Caching & Distributed Traffic",
         "outcomes": ["Design scalable REST/gRPC APIs and implement caching with write-through and eviction strategies",
                      "Architect content delivery networks (CDNs), reverse proxies, load balancers, and consistent hashing"]},
        {"module_num": 3, "module_tag": "Module 03", "module_title": "Data Storage, Replication, Partitioning & Messaging",
         "outcomes": ["Compare SQL vs NoSQL databases, evaluate CAP theorem trade-offs, and master sharding/replication",
                      "Utilize distributed object storage and event-driven message queue architectures"]},
        {"module_num": 4, "module_tag": "Module 04", "module_title": "Real-World Distributed Systems & Interview Case Studies",
         "outcomes": ["Master the 4-step system design interview framework across production scale architectures",
                      "Design Rate Limiter, TinyURL, Twitter, Discord, YouTube, Google Drive, Google Maps, Key-Value Store, and Kafka"]},
    ]

    video_titles = {
        6: ("Module 01", 1, "Computer Architecture & Hardware Bottlenecks"),
        7: ("Module 01", 1, "Application Architecture & Multi-Tier Systems"),
        8: ("Module 01", 1, "System Design Requirements (Availability, Latency & Throughput)"),
        9: ("Module 01", 1, "Networking Basics & The OSI Model"),
        10: ("Module 01", 1, "Transport Layer Protocols: TCP vs UDP"),
        11: ("Module 01", 1, "Domain Name System (DNS) & Global Resolution Flow"),
        12: ("Module 01", 1, "HTTP, HTTPS & RESTful Communication"),
        13: ("Module 01", 1, "Real-Time Communication: WebSockets & Long Polling"),
        14: ("Module 02", 2, "API Paradigms (REST, GraphQL & gRPC)"),
        15: ("Module 02", 2, "Scalable API Design & Best Practices"),
        16: ("Module 02", 2, "Caching Strategies (Write-Through, Write-Back & Eviction Policies)"),
        17: ("Module 02", 2, "Content Delivery Networks (CDNs) & Edge Caching"),
        18: ("Module 02", 2, "Proxies, Reverse Proxies & Load Balancing Algorithms"),
        19: ("Module 02", 2, "Consistent Hashing & Distributed Ring Routing"),
        20: ("Module 03", 3, "Relational Databases (SQL, ACID & Indexing)"),
        21: ("Module 03", 3, "NoSQL Databases (Key-Value, Document, Columnar & Graph)"),
        22: ("Module 03", 3, "Database Replication, Sharding & Horizontal Partitioning"),
        23: ("Module 03", 3, "CAP Theorem & PACELC Distributed Trade-Offs"),
        24: ("Module 03", 3, "Distributed Object Storage (S3 Architecture)"),
        25: ("Module 03", 3, "Message Queues & Event-Driven Architecture"),
        27: ("Module 04", 4, "How to Approach System Design Interviews"),
        28: ("Module 04", 4, "Design a Distributed Rate Limiter"),
        29: ("Module 04", 4, "Design a URL Shortener (TinyURL)"),
        30: ("Module 04", 4, "Design Twitter (Timeline Feed & Fan-Out Service)"),
        31: ("Module 04", 4, "Design Discord (Real-Time Group Chat Architecture)"),
        32: ("Module 04", 4, "Design YouTube (Video Ingestion, Transcoding & Global CDN)"),
        33: ("Module 04", 4, "Design Google Drive (Distributed File Storage & Sync)"),
        34: ("Module 04", 4, "Design Google Maps (Geospatial Indexing & Routing)"),
        35: ("Module 04", 4, "Design a Distributed Key-Value Store"),
        36: ("Module 04", 4, "Design a Distributed Message Queue (Kafka Clone)"),
    }

    vids_raw = [x for x in raw_items if x.get("is_video")]
    vids_raw.sort(key=lambda x: x.get("id"))

    items = []
    idx = 1
    for v in vids_raw:
        mid = v["id"]
        if mid not in video_titles:
            continue
        m_tag, m_num, title_text = video_titles[mid]
        mod_title = next(m["module_title"] for m in modules if m["module_num"] == m_num)
        
        dur = float(v.get("duration") or 1200.0)
        clean_name = f"[{idx:03d}] {title_text}"
        vid_id = "v_" + hashlib.sha256(f"{course_key}:{clean_name}:{idx}".encode()).hexdigest()[:12]
        cname = f"{claim_prefix}-{idx:03d}-{make_slug(title_text)[:35]}".strip("-")

        items.append({
            "idx": idx,
            "msg_id": mid,
            "kind": "video",
            "module_num": m_num,
            "module_tag": m_tag,
            "module_title": mod_title,
            "title": clean_name,
            "clean_filename": f"{clean_name}.mp4",
            "orig_filename": v.get("file_name") or f"video_{mid}.mp4",
            "needs_remux": False,
            "size": v.get("file_size") or 0,
            "duration": dur,
            "video_id": vid_id,
            "claim_name": cname,
        })
        idx += 1

    return {
        "course_key": course_key,
        "course_title": course_title,
        "instructor": instructor,
        "category": category,
        "tags": tags,
        "description": description,
        "channel_id": channel_id,
        "topic_id": None,
        "claim_prefix": claim_prefix,
        "learning_path_id": "system-design-architect",
        "learning_path_goal": "Master Scalable Distributed Systems & High Level Architecture",
        "modules": modules,
        "items": items,
        "cover_meta": ("DISTRIBUTED SYSTEMS & ARCHITECTURE", "NEETCODE — SYSTEM DESIGN", "Beginners & Distributed Interview Masterclass • Navdeep Singh", (17, 24, 39), (79, 70, 229))
    }

def build_bhaskar_jogi_azure():
    raw_path = ROOT_DIR / "bhaskar_jogi_azure_raw.json"
    with open(raw_path) as f:
        raw_items = json.load(f)

    course_key = "Azure Data Engineering 2026 (Bhaskar Jogi)"
    course_title = "Azure Data Engineering 2026 — Complete Big Data, ADF, PySpark, Synapse & Loan Finance Capstone"
    instructor = "Bhaskar Jogi"
    category = "Cloud Data Engineering & Big Data Systems"
    claim_prefix = "bhaskar-jogi-azure"
    channel_id = -1004421234975

    tags = [
        "Azure Data Engineering", "Azure", "ADF", "Azure Data Factory", "Databricks",
        "PySpark", "Apache Spark", "Hadoop", "HDFS", "Hive", "Synapse Analytics",
        "ETL", "Big Data", "Bhaskar Jogi", "MapReduce"
    ]

    description = (
        "Master end-to-end Cloud Data Engineering on Microsoft Azure with Bhaskar Jogi's comprehensive 125-lecture masterclass. "
        "Covers Big Data foundations, Hadoop ecosystem, HDFS architecture and CLI, MapReduce internals, Linux for data engineers, "
        "Apache Hive data warehousing, Apache Spark and PySpark structured transformations, memory management, "
        "Azure Data Factory (ADF) pipelines, triggers, data flows, Azure Synapse Analytics, Delta Lake, file formats "
        "(Parquet, ORC, Avro), data compression, schema evolution, and an exhaustive real-world industrial Banking & Loan Finance "
        "Analytics capstone project with dataset cleansing, scoring algorithms, and Agile/Scrum delivery."
    )

    modules = [
        {"module_num": 1, "module_tag": "Module 01", "module_title": "Big Data Foundations, Linux & Hadoop HDFS Internals",
         "outcomes": ["Understand big data ecosystem, OLTP vs DWH vs Data Lake, and role of data engineers",
                      "Master essential Linux CLI administration and Hadoop HDFS distributed storage architecture"]},
        {"module_num": 2, "module_tag": "Module 02", "module_title": "Distributed Computing with MapReduce Internals",
         "outcomes": ["Understand distributed computation, MapReduce execution lifecycle, and reducers/combiners",
                      "Apply MapReduce patterns to build data extraction and transformation pipelines"]},
        {"module_num": 3, "module_tag": "Module 03", "module_title": "Apache Spark Core Architecture, RDDs & Python Basics",
         "outcomes": ["Master Apache Spark internals, resilient distributed datasets (RDDs), Python basics, and execution DAGs",
                      "Perform transformations, joins, broadcast operations, partitioning, and caching"]},
        {"module_num": 4, "module_tag": "Module 04", "module_title": "PySpark DataFrames, Spark SQL & Performance Optimization",
         "outcomes": ["Build structured ETL pipelines using PySpark DataFrames, Spark SQL, and managed/unmanaged tables",
                      "Handle bad records, nested schemas, schema enforcement, and Spark session optimization"]},
        {"module_num": 5, "module_tag": "Module 05", "module_title": "Enterprise Data Warehousing & Dimensional Modeling (Amazon Project)",
         "outcomes": ["Design dimensional models, star/snowflake schemas, fact/dimension tables, and SCD types",
                      "Implement enterprise data warehouse architecture modeled on Amazon real-time e-commerce data"]},
        {"module_num": 6, "module_tag": "Module 06", "module_title": "Advanced Spark Internals, AQE, Salting & Memory Management",
         "outcomes": ["Deep dive into Spark query execution plans, adaptive query execution (AQE), and join strategies",
                      "Solve partition skew with salting techniques and optimize dynamic/static executor memory allocation"]},
        {"module_num": 7, "module_tag": "Module 07", "module_title": "Enterprise Big Data File Formats, Storage & Compression",
         "outcomes": ["Master columnar storage (Parquet, ORC), row-based (Avro), compression algorithms, and schema evolution",
                      "Optimize I/O bandwidth and serialization performance across large distributed clusters"]},
        {"module_num": 8, "module_tag": "Module 08", "module_title": "Industrial Banking & Loan Finance Analytics Real-Time Capstone Project",
         "outcomes": ["Execute an enterprise Agile/Scrum data project ingesting multi-source loan and customer datasets",
                      "Cleanse bad records, engineer feature pipelines, calculate loan risk scores, and build analytical data marts"]},
        {"module_num": 9, "module_tag": "Module 09", "module_title": "Apache Hive Distributed Data Warehousing & SQL",
         "outcomes": ["Execute SQL queries on massive distributed datasets using Apache Hive warehousing engine",
                      "Manage Hive metastore, internal/external tables, partitioning, and query execution"]},
    ]

    vids_raw = [x for x in raw_items if x.get("is_video")]
    def get_num(v):
        fn = v.get("file_name") or ""
        m = re.match(r"^(\d+)\.", fn)
        return int(m.group(1)) if m else 999
    vids_raw.sort(key=get_num)

    def clean_bhaskar_title(num: int, fn: str) -> str:
        t = re.sub(r"^\d+\.", "", fn)
        t = re.sub(r"\.mp4$", "", t, flags=re.I)
        t = re.sub(r"@hmaracollege.*", "", t, flags=re.I)
        t = re.sub(r"@thebatmanreborn.*", "", t, flags=re.I)
        t = t.strip()
        if num == 1: return "Day 1: Cloud & Data Engineering Introduction"
        if num == 2: return "Day 2: Data Engineering Roles & Architectures"
        if t.lower().startswith("day"):
            t = re.sub(r"^day\s*[-_]?\s*\d+\s*[-_:]?\s*", "", t, flags=re.I)
        return t.strip()

    items = []
    idx = 1
    for v in vids_raw:
        num = get_num(v)
        fn = v.get("file_name") or f"{num}.mp4"
        cl_title = clean_bhaskar_title(num, fn)
        
        # Strictly contiguous module ranges (1..17, 18..25, 26..40, 41..58, 59..70, 71..102, 103..108, 109..124, 125)
        if num <= 17:
            m_num = 1
            m_tag = "Module 01"
            m_title = "Big Data Foundations, Linux & Hadoop HDFS Internals"
        elif 18 <= num <= 25:
            m_num = 2
            m_tag = "Module 02"
            m_title = "Distributed Computing with MapReduce Internals"
        elif 26 <= num <= 40:
            m_num = 3
            m_tag = "Module 03"
            m_title = "Apache Spark Core Architecture, RDDs & Python Basics"
        elif 41 <= num <= 58:
            m_num = 4
            m_tag = "Module 04"
            m_title = "PySpark DataFrames, Spark SQL & Performance Optimization"
        elif 59 <= num <= 70:
            m_num = 5
            m_tag = "Module 05"
            m_title = "Enterprise Data Warehousing & Dimensional Modeling (Amazon Project)"
        elif 71 <= num <= 102:
            m_num = 6
            m_tag = "Module 06"
            m_title = "Advanced Spark Internals, AQE, Salting & Memory Management"
        elif 103 <= num <= 108:
            m_num = 7
            m_tag = "Module 07"
            m_title = "Enterprise Big Data File Formats, Storage & Compression"
        elif 109 <= num <= 124:
            m_num = 8
            m_tag = "Module 08"
            m_title = "Industrial Banking & Loan Finance Analytics Real-Time Capstone Project"
        else: # 125
            m_num = 9
            m_tag = "Module 09"
            m_title = "Apache Hive Distributed Data Warehousing & SQL"

        dur = float(v.get("duration") or 2400.0)
        clean_name = f"[{idx:03d}] {cl_title}"
        vid_id = "v_" + hashlib.sha256(f"{course_key}:{clean_name}:{idx}".encode()).hexdigest()[:12]
        cname = f"{claim_prefix}-{idx:03d}-{make_slug(cl_title)[:35]}".strip("-")

        items.append({
            "idx": idx,
            "msg_id": v["id"],
            "kind": "video",
            "module_num": m_num,
            "module_tag": m_tag,
            "module_title": m_title,
            "title": clean_name,
            "clean_filename": f"{clean_name}.mp4",
            "orig_filename": fn,
            "needs_remux": False,
            "size": v.get("file_size") or 0,
            "duration": dur,
            "video_id": vid_id,
            "claim_name": cname,
        })
        idx += 1

    docs_raw = [x for x in raw_items if x.get("is_document")]
    docs_titles = {
        97: ("Module 04", 4, "PySpark DataFrames, Spark SQL & Performance Optimization", "[Study 001] Employee Datasets Archive (Emp.zip)", "Emp.zip"),
        98: ("Module 04", 4, "PySpark DataFrames, Spark SQL & Performance Optimization", "[Study 002] Nested Customer Data Archive (customer_nested.zip)", "customer_nested.zip"),
        99: ("Module 02", 2, "Distributed Computing with MapReduce Internals", "[Study 001] MapReduce Practice Files Archive", "24.1 Practce files Map Reduce.zip"),
        100: ("Module 06", 6, "Advanced Spark Internals, AQE, Salting & Memory Management", "[Study 001] Server Log Data Sample File (MyLogData.txt)", "25.1MyLogData.txt"),
        101: ("Module 05", 5, "Enterprise Data Warehousing & Dimensional Modeling (Amazon Project)", "[Study 001] Amazon Sales Benchmark Dataset (Amazon_Sales.csv)", "Amazon_Sales.csv"),
    }
    s_idx = 1
    for d in docs_raw:
        mid = d["id"]
        if mid in docs_titles:
            m_tag, m_num, m_title, s_title, fn = docs_titles[mid]
            items.append({
                "idx": s_idx,
                "msg_id": mid,
                "kind": "study",
                "module_num": m_num,
                "module_tag": m_tag,
                "module_title": m_title,
                "title": f"[{m_tag} Study {s_idx:03d}] {s_title}",
                "clean_filename": f"[{m_tag} Study {s_idx:03d}] {fn}",
                "orig_filename": fn,
                "size": d.get("file_size") or 0,
            })
            s_idx += 1

    return {
        "course_key": course_key,
        "course_title": course_title,
        "instructor": instructor,
        "category": category,
        "tags": tags,
        "description": description,
        "channel_id": channel_id,
        "topic_id": None,
        "claim_prefix": claim_prefix,
        "learning_path_id": "azure-data-engineering-mastery",
        "learning_path_goal": "Master Azure Big Data Infrastructure, PySpark, ADF & Financial Capstone",
        "modules": modules,
        "items": items,
        "cover_meta": ("AZURE CLOUD DATA ENGINEERING", "AZURE DATA ENGINEERING 2026", "Complete Big Data • PySpark • ADF • Hive • Loan Finance Project", (15, 23, 42), (2, 132, 199))
    }

def build_veerababu_devops():
    raw_path = ROOT_DIR / "veerababu_devops_raw.json"
    with open(raw_path) as f:
        raw_items = json.load(f)

    course_key = "DevOps with Multi-Cloud & AI (Veerababu)"
    course_title = "DevOps with Multi-Cloud & AI — Complete 174-Day Enterprise Masterclass (AWS, Azure, GCP, K8s & AI-Ops)"
    instructor = "Veerababu Sir (NareshIT)"
    category = "Cloud Computing, DevOps & Infrastructure"
    claim_prefix = "veerababu-devops"
    channel_id = -1003802851567

    tags = [
        "DevOps", "Cloud Computing", "AWS", "Azure", "GCP", "Kubernetes", "Docker",
        "Terraform", "CI/CD", "Jenkins", "Ansible", "Linux", "AI-Ops", "Git",
        "Veerababu", "NareshIT", "Prometheus", "Grafana"
    ]

    description = (
        "Exhaustive 174-day enterprise-grade masterclass in DevOps and Multi-Cloud Architecture by industry veteran "
        "Veerababu Sir (Naresh IT). Comprehensive hands-on mastery across Linux system administration, Git and GitHub source control, "
        "AWS Cloud Services (EC2, VPC, IAM, S3, RDS, ECS, EKS), Microsoft Azure Cloud, Google Cloud Platform (GCP), "
        "containerization with Docker, enterprise container orchestration with Kubernetes, Infrastructure as Code (IaC) with "
        "Terraform and Ansible, continuous integration and continuous deployment (CI/CD) with Jenkins and GitHub Actions, "
        "Prometheus and Grafana monitoring, DevSecOps, and modern AI-Ops workflows."
    )

    modules = [
        {"module_num": 1, "module_tag": "Module 01", "module_title": "Multi-Cloud Fundamentals & Linux/Git System Administration",
         "outcomes": ["Master Linux operating system architecture, user permissions, and bash automation scripts",
                      "Implement Git/GitHub version control workflows, branching strategies, and repository management"]},
        {"module_num": 2, "module_tag": "Module 02", "module_title": "Amazon Web Services (AWS) Cloud Architecture & Infrastructure",
         "outcomes": ["Architect scalable enterprise cloud environments with AWS EC2, VPC, IAM, S3, and Route 53",
                      "Configure relational databases with Amazon RDS, serverless Lambda, and security firewalls"]},
        {"module_num": 3, "module_tag": "Module 03", "module_title": "Containerization with Docker & Multi-Container Architectures",
         "outcomes": ["Build, optimize, and secure container images with multi-stage Dockerfiles and registries",
                      "Orchestrate multi-container applications with Docker Compose and software-defined networks"]},
        {"module_num": 4, "module_tag": "Module 04", "module_title": "Enterprise Kubernetes (K8s) Cluster Orchestration & Management",
         "outcomes": ["Deploy, scale, and manage resilient microservice architectures using Kubernetes Pods, Deployments & Services",
                      "Master ConfigMaps, Secrets, Ingress controllers, Persistent Volumes, and Helm package management"]},
        {"module_num": 5, "module_tag": "Module 05", "module_title": "Infrastructure as Code (IaC) with Terraform & Ansible Automation",
         "outcomes": ["Provision reproducible multi-cloud infrastructure declaratively with Terraform HCL and remote state",
                      "Automate configuration management, package installation, and server provisioning with Ansible playbooks"]},
        {"module_num": 6, "module_tag": "Module 06", "module_title": "Continuous Integration & CI/CD Pipelines (Jenkins & GitHub Actions)",
         "outcomes": ["Build automated CI/CD deployment pipelines using Jenkins declarative pipelines and GitHub Actions",
                      "Integrate Maven build automation, SonarQube code quality gates, and automated container pushes"]},
        {"module_num": 7, "module_tag": "Module 07", "module_title": "Multi-Cloud (Azure & GCP), Observability (Prometheus/Grafana) & AI-Ops",
         "outcomes": ["Manage hybrid workloads across Microsoft Azure and Google Cloud Platform (GCP) environments",
                      "Implement full-stack observability with Prometheus and Grafana dashboards, alerting, and AI-Ops automation"]},
    ]

    v_batch = [it for it in raw_items if it.get("id") >= 932 and it.get("is_video")]
    
    day_map = []
    for i, v in enumerate(v_batch):
        fn = v.get("file_name") or ""
        tx = v.get("text") or ""
        m = re.search(r"Day\s*[-_]?\s*(\d+)", fn + " " + tx, re.I)
        if m:
            d = int(m.group(1))
        else:
            m2 = re.search(r"Session\s*(\d+)", fn + " " + tx, re.I)
            d = int(m2.group(1)) if m2 else i + 1
        day_map.append((d, v))

    day_map.sort(key=lambda x: x[0])

    items = []
    for d, v in day_map:
        fn = v.get("file_name") or f"day_{d}.mp4"
        
        if d <= 25:
            m_num = 1
            m_tag = "Module 01"
            m_title = "Multi-Cloud Fundamentals & Linux/Git System Administration"
            topic = f"Linux & Git System Administration Session {d}" if d <= 3 else f"Multi-Cloud Foundations Day {d}"
        elif d <= 65:
            m_num = 2
            m_tag = "Module 02"
            m_title = "Amazon Web Services (AWS) Cloud Architecture & Infrastructure"
            topic = f"AWS Cloud Architecture & Services Day {d}"
        elif d <= 90:
            m_num = 3
            m_tag = "Module 03"
            m_title = "Containerization with Docker & Multi-Container Architectures"
            topic = f"Docker Containerization & Workflows Day {d}"
        elif d <= 125:
            m_num = 4
            m_tag = "Module 04"
            m_title = "Enterprise Kubernetes (K8s) Cluster Orchestration & Management"
            topic = f"Kubernetes Cluster Orchestration Day {d}"
        elif d <= 145:
            m_num = 5
            m_tag = "Module 05"
            m_title = "Infrastructure as Code (IaC) with Terraform & Ansible Automation"
            topic = f"Terraform & Ansible Infrastructure as Code Day {d}"
        elif d <= 160:
            m_num = 6
            m_tag = "Module 06"
            m_title = "Continuous Integration & CI/CD Pipelines (Jenkins & GitHub Actions)"
            topic = f"CI/CD Pipelines & Build Automation Day {d}"
        else:
            m_num = 7
            m_tag = "Module 07"
            m_title = "Multi-Cloud (Azure & GCP), Observability (Prometheus/Grafana) & AI-Ops"
            topic = f"Multi-Cloud, Observability & AI-Ops Day {d}"

        cl_title = f"Day {d:03d}: {topic}"
        clean_name = f"[{d:03d}] {cl_title}"
        vid_id = "v_" + hashlib.sha256(f"{course_key}:{clean_name}:{d}".encode()).hexdigest()[:12]
        cname = f"{claim_prefix}-{d:03d}-{make_slug(topic)[:35]}".strip("-")
        dur = float(v.get("duration") or 3600.0)

        items.append({
            "idx": d,
            "msg_id": v["id"],
            "kind": "video",
            "module_num": m_num,
            "module_tag": m_tag,
            "module_title": m_title,
            "title": clean_name,
            "clean_filename": f"{clean_name}.mp4",
            "orig_filename": fn,
            "needs_remux": False,
            "size": v.get("file_size") or 0,
            "duration": dur,
            "video_id": vid_id,
            "claim_name": cname,
        })

    items.append({
        "idx": 1,
        "msg_id": 1032,
        "kind": "study",
        "module_num": 1,
        "module_tag": "Module 01",
        "module_title": "Multi-Cloud Fundamentals & Linux/Git System Administration",
        "title": "[Module 01 Study 001] DevOps Git Repositories & Enterprise Source Code Archive",
        "clean_filename": "[Module 01 Study 001] git repos.rar",
        "orig_filename": "git repos.rar",
        "size": 215765419,
    })

    return {
        "course_key": course_key,
        "course_title": course_title,
        "instructor": instructor,
        "category": category,
        "tags": tags,
        "description": description,
        "channel_id": channel_id,
        "topic_id": None,
        "claim_prefix": claim_prefix,
        "learning_path_id": "multicloud-devops-architect",
        "learning_path_goal": "Master Multi-Cloud Architecture, Kubernetes, IaC, CI/CD & AI-Ops",
        "modules": modules,
        "items": items,
        "cover_meta": ("DEVOPS & MULTI-CLOUD ARCHITECTURE", "DEVOPS WITH MULTI-CLOUD & AI", "174-Day Enterprise Masterclass • Veerababu Sir (NareshIT)", (15, 23, 42), (249, 115, 22))
    }

def main():
    dry_run = "--dry-run" in sys.argv
    print(f"🚀 Initializing CourseForge 4-Course Pipeline Registrar (dry_run={dry_run})...\n")

    builders = [
        ("Namaste Node.js", build_namaste_nodejs),
        ("NeetCode System Design Course", build_neetcode_system_design),
        ("Azure Data Engineering 2026 (Bhaskar Jogi)", build_bhaskar_jogi_azure),
        ("DevOps with Multi-Cloud & AI (Veerababu)", build_veerababu_devops),
    ]

    new_courses_data = []
    for label, builder in builders:
        cdata = builder()
        vids = [x for x in cdata["items"] if x["kind"] == "video"]
        docs = [x for x in cdata["items"] if x["kind"] == "study"]
        print(f"✅ Built: {cdata['course_title']}")
        print(f"   Key: {cdata['course_key']} | Prefix: {cdata['claim_prefix']}")
        print(f"   Modules: {len(cdata['modules'])} | Videos: {len(vids)} | Docs: {len(docs)}")
        new_courses_data.append(cdata)

    if dry_run:
        print("\n🔍 DRY RUN COMPLETE: All 4 courses built successfully with zero errors!")
        return

    # 1. Update new_5_curricula.json
    print("\n📝 Updating new_5_curricula.json...")
    with open(CURRICULA_PATH, "r", encoding="utf-8") as f:
        curr_all = json.load(f)

    new_keys = set(c["course_key"] for c in new_courses_data)
    curr_all = [c for c in curr_all if c.get("course_key") not in new_keys]

    for cdata in new_courses_data:
        entry = dict(cdata)
        entry.pop("cover_meta", None)
        curr_all.append(entry)

    with open(CURRICULA_PATH, "w", encoding="utf-8") as f:
        json.dump(curr_all, f, indent=2)
    print(f"  Successfully wrote {len(curr_all)} courses to new_5_curricula.json!")

    # 2. Generate Cover Images
    print("\n🎨 Generating Course Cover Images...")
    cover_paths = {}
    for cdata in new_courses_data:
        meta = cdata["cover_meta"]
        cpath = generate_cover(cdata["course_key"], meta[0], meta[1], meta[2], meta[3], meta[4])
        cover_paths[cdata["course_key"]] = cpath
        print(f"  Cover created for {cdata['course_key']} -> {cpath}")

    # 3. Register in SQLite
    print("\n💾 Synchronizing with SQLite (courseforge.sqlite3)...")
    now_str = utcnow()
    conn = sqlite3.connect(str(SQLITE_PATH))
    with conn:
        for cdata in new_courses_data:
            ckey = cdata["course_key"]
            conn.execute("""
                INSERT INTO course_metadata (course, title, instructor, category, tags_json, cover_kind, updated_at)
                VALUES (?, ?, ?, ?, ?, 'custom', ?)
                ON CONFLICT (course) DO UPDATE SET
                    title = excluded.title,
                    instructor = excluded.instructor,
                    category = excluded.category,
                    tags_json = excluded.tags_json,
                    updated_at = excluded.updated_at;
            """, (ckey, cdata["course_title"], cdata["instructor"], cdata["category"], json.dumps(cdata["tags"]), now_str))

            conn.execute("""
                INSERT INTO course_publication (course, published, description, updated_at)
                VALUES (?, 1, ?, ?)
                ON CONFLICT (course) DO UPDATE SET
                    published = 1,
                    description = excluded.description,
                    updated_at = excluded.updated_at;
            """, (ckey, cdata["description"], now_str))

            for it in cdata["items"]:
                if it["kind"] != "video": continue
                vpath = f"/home/ubuntu/CourseForge/courses/{ckey}/{it['clean_filename']}"
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
                """, (it["video_id"], vpath, ckey, it["title"], it["size"], 1792200000000000000 + it["idx"], it["duration"], now_str, now_str))

    conn.close()
    print("  SQLite database synchronized successfully.")

    # 4. Register in PostgreSQL
    print("\n🐘 Synchronizing with PostgreSQL (courseforge_rewrite)...")
    sql_statements = []
    for cdata in new_courses_data:
        ckey = cdata["course_key"]
        cover_rel = cover_paths[ckey]
        tags_array = "ARRAY[" + ", ".join(f"'{t}'" for t in cdata["tags"]) + "]::text[]"
        
        sql_statements.append(f"""
INSERT INTO courses (id, title, description, published, version, instructor, category, tags, cover_relative_path, created_at, updated_at)
VALUES ({escape_sql(ckey)}, {escape_sql(cdata["course_title"])}, {escape_sql(cdata["description"])},
        TRUE, 1, {escape_sql(cdata["instructor"])}, {escape_sql(cdata["category"])},
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

        for it in cdata["items"]:
            if it["kind"] != "video": continue
            sec_title = f"{it['module_tag']}: {it['module_title']}"
            sql_statements.append(f"""
INSERT INTO lessons (id, course_id, title, sort_order, flow_order, duration_seconds, status, section_title, created_at)
VALUES ({escape_sql(it['video_id'])}, {escape_sql(ckey)}, {escape_sql(it['title'])},
        {it['idx']}, {float(it['idx'])}, {it['duration']}, 'done', {escape_sql(sec_title)}, now())
ON CONFLICT (id) DO UPDATE SET
    course_id = EXCLUDED.course_id,
    title = EXCLUDED.title,
    sort_order = EXCLUDED.sort_order,
    flow_order = EXCLUDED.flow_order,
    duration_seconds = EXCLUDED.duration_seconds,
    section_title = EXCLUDED.section_title;
""")

        cdir = COURSES_DIR / ckey
        cdir.mkdir(parents=True, exist_ok=True)

    batch_size = 250
    for i in range(0, len(sql_statements), batch_size):
        chunk = sql_statements[i:i + batch_size]
        sub_sql = "BEGIN;\n" + "\n".join(chunk) + "\nCOMMIT;"
        run_psql(sub_sql)

    print(f"  PostgreSQL successfully updated ({len(sql_statements)} statements executed)!")
    print("\n================================================================================")
    print("🎉 ALL 4 NEW COURSES SUCCESSFULLY CONSTRUCTED AND INTEGRATED INTO COURSEFORGE!")
    print("================================================================================")

if __name__ == "__main__":
    main()
