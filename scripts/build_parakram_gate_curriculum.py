import asyncio
import hashlib
import json
import os
import re
from pathlib import Path
from telethon import TelegramClient

API_ID = 2040
API_HASH = "b18441a1ff607e10a989891a5462e627"
SESSION_PATH = "/tmp/tg_inspect"
CHANNEL_ID = -1003071862435
COURSE_KEY = "Parakram 2.0 GATE 2026 Batch F (Hinglish) - Computer Science"
COURSE_TITLE = "Parakram 2.0 GATE 2026 Batch F (Hinglish) — Computer Science & Engineering (Complete Masterclass)"
INSTRUCTOR = "Physics Wallah (PW) GATE CS Faculty (Pankaj Sharma, Khaleel Khan, Satish Yadav, Chandan Jha, Vijay Agarwal)"
CATEGORY = "GATE & PSU Computer Science"
CLAIM_PREFIX = "pw-parakram-gate-cs-2026"
LEARNING_PATH_ID = "lp_parakram_gate_cs_2026"
LEARNING_PATH_GOAL = "Master Complete GATE & PSU Computer Science: Algorithms, Discrete Maths, TOC, OS, DBMS, CN, Compiler, Digital Logic & Engineering Maths"

MODULE_MAPPING = [
    (1, "Module 01", "Course Orientation, Starter Kit & Basics of Computer Systems", ["starter kit", "basics of computer system", "study page", "important update"]),
    (2, "Module 02", "Fundamentals of C Language & Procedural Programming", ["fundamental of c", "c programming"]),
    (3, "Module 03", "Data Structures & Core Programming Concepts", ["data structure"]),
    (4, "Module 04", "Design & Analysis of Algorithms", ["algorithm"]),
    (5, "Module 05", "Theory of Computation (TOC & Automata Theory)", ["theory of computation", "toc"]),
    (6, "Module 06", "Compiler Design & Code Optimization", ["compiler"]),
    (7, "Module 07", "Digital Logic & Number Systems", ["digital logic"]),
    (8, "Module 08", "Operating Systems, Process Synchronization & Virtual Memory", ["operating system"]),
    (9, "Module 09", "Database Management Systems (DBMS & SQL)", ["database management", "dbms"]),
    (10, "Module 10", "Computer Networks & Protocol Architectures", ["computer network"]),
    (11, "Module 11", "Discrete Mathematics, Set Theory & Graph Theory", ["discrete math"]),
    (12, "Module 12", "Engineering Mathematics: Linear Algebra & Matrices", ["linear algebra"]),
    (13, "Module 13", "Engineering Mathematics: Calculus & Optimization", ["calculus and optimization"]),
    (14, "Module 14", "Engineering Mathematics: Probability & Statistics", ["probability and statistics"]),
    (15, "Module 15", "General Aptitude, Numerical & Verbal Ability", ["general aptitude"]),
    (16, "Module 16", "Comprehensive DPP Discussions & GATE Problem Solving", ["dpp", "notices", "practice"]),
]

def map_to_module(topic_str, title_str, fn_str):
    combined = f"{topic_str} {title_str} {fn_str}".lower()
    if "dpp" in combined or "discussion" in combined:
        return MODULE_MAPPING[15]
    for m in MODULE_MAPPING[:-1]:
        for kw in m[3]:
            if kw in combined:
                return m
    return MODULE_MAPPING[15]

def clean_video_title(fn, txt):
    fn = fn or ""
    txt = txt or ""
    top_m = re.search(r"(?i)\*\*Topic:\*\*\s*(.+)", txt)
    topic = top_m.group(1).strip() if top_m else ""
    title_m = re.search(r"(?i)\*\*Title:\*\*\s*(.+)", txt)
    raw_title = title_m.group(1).strip() if title_m else ""
    raw_title = re.sub(r"(?i)ImTgArtist(\.mp4|\.pdf)?", "", raw_title).strip()
    raw_title = re.sub(r"(?i)\.mp4$", "", raw_title).strip()
    clean_fn = re.sub(r"(?i)ImTgArtist(\.mp4|\.pdf)?", "", fn).strip()
    clean_fn = re.sub(r"(?i)\.mp4$", "", clean_fn).strip()
    clean_fn = clean_fn.replace("_", " ").strip()
    if raw_title and len(raw_title) > 3:
        best_title = raw_title
    elif clean_fn and len(clean_fn) > 3:
        best_title = clean_fn
    else:
        best_title = f"{topic} Lecture" if topic else "GATE CS Lecture"
    best_title = re.sub(r"\s+", " ", best_title).strip()
    return topic, best_title

async def build_curriculum():
    client = TelegramClient(SESSION_PATH, API_ID, API_HASH)
    await client.connect()
    ent = await client.get_entity(CHANNEL_ID)
    print("Fetching all media messages from Parakram 2.0...")
    raw_items = []
    study_items = []
    async for m in client.iter_messages(ent, limit=None):
        if m.video or (m.document and m.file and m.file.name and m.file.name.endswith((".mp4", ".mkv", ".avi"))):
            fn = getattr(m.file, "name", "") or ""
            txt = m.text or ""
            sz = m.file.size if m.file else 0
            raw_items.append((m.id, fn, txt, sz, "video"))
        elif m.document and m.file and m.file.name and m.file.name.endswith(".pdf"):
            fn = getattr(m.file, "name", "") or ""
            txt = m.text or ""
            sz = m.file.size if m.file else 0
            study_items.append((m.id, fn, txt, sz, "study"))

    raw_items.reverse()
    study_items.reverse()
    print(f"Total video lectures: {len(raw_items)} | Total PDF study docs: {len(study_items)}")

    curriculum_modules = []
    for m in MODULE_MAPPING:
        curriculum_modules.append({
            "num": m[0],
            "tag": m[1],
            "title": m[2],
            "objectives": [
                f"Master core concepts, problem solving techniques, and rigorous proofs for {m[2]}",
                f"Analyze previous GATE questions, edge cases, and time/space complexity invariants in {m[2]}"
            ]
        })

    items = []
    for idx, (msg_id, fn, txt, sz, kind) in enumerate(raw_items, 1):
        topic, title = clean_video_title(fn, txt)
        mod = map_to_module(topic, title, fn)
        safe_slug = re.sub(r"[^a-z0-9]+", "-", f"{mod[1]}-{title}".lower()).strip("-")[:45]
        v_id = f"v_{hashlib.md5(f"{COURSE_KEY}_{idx}_{msg_id}".encode()).hexdigest()[:12]}"
        claim_name = f"{CLAIM_PREFIX}-{idx:03d}-{safe_slug}"
        clean_fn = f"[{idx:03d}] {mod[1]} - {title}.mp4"
        items.append({
            "idx": idx,
            "msg_id": msg_id,
            "kind": "video",
            "module_num": mod[0],
            "module_tag": mod[1],
            "module_title": mod[2],
            "title": f"[{idx:03d}] {mod[1]} - {title}",
            "clean_filename": clean_fn,
            "orig_filename": fn if fn else f"gate_lecture_{idx}.mp4",
            "needs_remux": False,
            "size": sz,
            "duration": 0.0,
            "video_id": v_id,
            "claim_name": claim_name,
        })

    course_obj = {
        "course_key": COURSE_KEY,
        "course_title": COURSE_TITLE,
        "instructor": INSTRUCTOR,
        "category": CATEGORY,
        "tags": [
            "GATE CS 2026", "Algorithms", "Data Structures", "Theory of Computation",
            "Operating Systems", "DBMS", "Computer Networks", "Compiler Design",
            "Digital Logic", "Discrete Mathematics", "Engineering Mathematics",
            "General Aptitude", "Physics Wallah"
        ],
        "description": "Comprehensive GATE 2026 Computer Science & Engineering masterclass covering Algorithms, Discrete Mathematics, TOC, OS, DBMS, Computer Networks, Compiler Design, Digital Logic, Engineering Mathematics (Linear Algebra, Calculus, Probability), and General Aptitude with complete Daily Practice Problem (DPP) video discussions.",
        "channel_id": CHANNEL_ID,
        "topic_id": None,
        "claim_prefix": CLAIM_PREFIX,
        "learning_path_id": LEARNING_PATH_ID,
        "learning_path_goal": LEARNING_PATH_GOAL,
        "cover_colors": [[26, 35, 126], [255, 179, 0], "PARAKRAM 2.0 • GATE 2026 CS", "Algorithms • Discrete Maths • TOC • OS • DBMS • CN • Engg Maths"],
        "modules": curriculum_modules,
        "items": items
    }

    out_path = Path("/home/ubuntu/CourseForge/data/parakram_gate_cs_2026_curriculum.json")
    with open(out_path, "w") as f:
        json.dump(course_obj, f, indent=2)
    print(f"✅ Successfully wrote curriculum JSON to {out_path} ({len(items)} lectures)!")

    await client.disconnect()

if __name__ == "__main__":
    asyncio.run(build_curriculum())
