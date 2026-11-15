#!/usr/bin/env python3
"""
Sync all 33 courses into new_5_curricula.json:
- Retains existing 30 courses
- Adds Harkirat Singh Super 30 Courses (105 videos, channel -1003258779632)
- Adds Coder Gyan Courses (370 videos, channel -1003499167072)
- Adds Bitten Tech Courses (1284 videos, channel -1003716632867)
All with kind="video", msg_id, clean_filename, claim_name.
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path

ROOT_DIR = Path("/home/ubuntu/CourseForge")
CURRICULA_PATH = ROOT_DIR / "new_5_curricula.json"
BACKUP_PATH = ROOT_DIR / "data/curricula_33_backup.json"

def sanitize_filename(s: str) -> str:
    s = re.sub(r'[\\/:*?"<>|\r\n]+', " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s[:130]

def make_slug(s: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")
    return re.sub(r"-+", "-", s)

def clean_lesson_title(name: str) -> str:
    for ext in ['.mp4', '.mkv', '.avi', '.m4v']:
        if name.lower().endswith(ext):
            name = name[:-len(ext)]
            break
    name = re.sub(r'[_\.]+', ' ', name).strip()
    return name

def build_harkirat_course():
    raw_path = ROOT_DIR / "harkirat_super30_raw.json"
    if not raw_path.exists():
        print("Warning: harkirat_super30_raw.json not found")
        return None
    with open(raw_path) as f:
        videos = json.load(f)
    course_key = "Harkirat Singh Super 30 Courses"
    claim_prefix = "harkirat-super30-2026"
    items = []
    for idx, v in enumerate(videos, 1):
        raw_name = (v.get("filename") or v.get("caption") or f"Lesson {idx}").strip()
        cl_title = clean_lesson_title(raw_name)
        fn = sanitize_filename(f"[{idx:03d}] {cl_title}.mp4")
        msg_id = v.get("msg_id") or v.get("id")
        v_id = f"v_{hashlib.sha1(f'{course_key}:{idx}:{msg_id}'.encode()).hexdigest()[:12]}"
        cl_name = f"{claim_prefix}-{idx:03d}-{make_slug(cl_title)[:42]}"
        items.append({
            "idx": idx,
            "msg_id": msg_id,
            "kind": "video",
            "module_num": 1,
            "module_tag": "Module 01",
            "module_title": "Super 30 Masterclass",
            "title": cl_title,
            "clean_filename": fn,
            "orig_filename": fn,
            "needs_remux": False,
            "size": v.get("size") or 100000000,
            "duration": v.get("duration") or 3600,
            "video_id": v_id,
            "claim_name": cl_name,
        })
    return {
        "course_key": course_key,
        "course_title": "Harkirat Singh — 100xDevs Super 30 (Season 1.0 & Season 2.0)",
        "instructor": "Harkirat Singh (100xDevs)",
        "category": "Full-Stack, Distributed Systems & Financial Engineering",
        "tags": ["Super 30", "Harkirat Singh", "Golang", "Kubernetes", "Trading Engine", "Orderbook", "Solana", "Anchor", "React Native", "Distributed Systems"],
        "description": "The elite Harkirat Singh 100xDevs Super 30 curriculum combining Season 1.0 and Season 2.0.",
        "channel_id": -1003258779632,
        "topic_id": None,
        "claim_prefix": claim_prefix,
        "learning_path_id": "lp_harkirat_super30_2026",
        "learning_path_goal": "Achieve Elite Principal Engineering Mastery: Architect High-Frequency Financial Engines, Scalable Kubernetes Microservices, Decentralized Web3 Systems, and Cross-Platform Native Mobile Applications.",
        "cover_colors": ((15, 23, 42), (147, 51, 234), "HARKIRAT • 100xDEVS SUPER 30", "105 Masterclass Lectures + 24 Verified Study Guides"),
        "modules": [{"num": 1, "tag": "Module 01", "title": "Super 30 Masterclass", "objectives": ["Master Golang concurrency & systems architecture"]}],
        "items": items,
    }

def build_codergyan_course():
    raw_path = ROOT_DIR / "codergyan_raw.json"
    if not raw_path.exists():
        print("Warning: codergyan_raw.json not found")
        return None
    with open(raw_path) as f:
        msgs = json.load(f)
    videos = [m for m in msgs if m.get("media_type") == "MessageMediaDocument"]
    course_key = "Coder Gyan Courses"
    claim_prefix = "codergyan-courses-2026"
    items = []
    for idx, v in enumerate(videos, 1):
        raw_name = (v.get("text") or v.get("filename") or f"Lesson {idx}").strip()
        cl_title = clean_lesson_title(raw_name)
        fn = sanitize_filename(f"[{idx:03d}] {cl_title}.mp4")
        msg_id = v.get("id")
        v_id = f"v_{hashlib.sha1(f'{course_key}:{idx}:{msg_id}'.encode()).hexdigest()[:12]}"
        cl_name = f"{claim_prefix}-{idx:03d}-{make_slug(cl_title)[:42]}"
        items.append({
            "idx": idx,
            "msg_id": msg_id,
            "kind": "video",
            "module_num": 1,
            "module_tag": "Module 01",
            "module_title": "Fullstack Microservices & Systems",
            "title": cl_title,
            "clean_filename": fn,
            "orig_filename": fn,
            "needs_remux": False,
            "size": v.get("size") or 50000000,
            "duration": v.get("duration") or 1800,
            "video_id": v_id,
            "claim_name": cl_name,
        })
    return {
        "course_key": course_key,
        "course_title": "Coder Gyan — Fullstack Microservices & Backend Foundation",
        "instructor": "Coders Gyan",
        "category": "Full-Stack Microservices, Systems Architecture & Cloud Infrastructure",
        "tags": ["Coder Gyan", "Microservices", "Node.js", "TypeScript", "Express", "Apache Kafka", "React 19", "Docker", "Kubernetes", "Linux", "Networking"],
        "description": "The complete Coders Gyan Masterclass combining Fullstack Engineer In 14 Weeks and Master Backend Foundation.",
        "channel_id": -1003499167072,
        "topic_id": None,
        "claim_prefix": claim_prefix,
        "learning_path_id": "lp_codergyan_courses_2026",
        "learning_path_goal": "Achieve Fullstack Microservices Mastery: Architect Event-Driven Distributed Systems with Kafka, Build Multi-Tenant Cloud Services, and Administer Enterprise Linux Infrastructure.",
        "cover_colors": ((15, 23, 42), (2, 132, 199), "CODER GYAN • FULLSTACK & SYSTEMS", "370 Masterclass Lectures + 24 Verified Study Guides"),
        "modules": [{"num": 1, "tag": "Module 01", "title": "Fullstack Microservices & Systems", "objectives": ["Architect event-driven distributed systems"]}],
        "items": items,
    }

def build_bittentech_course():
    raw_path = ROOT_DIR / "bittentech_raw.json"
    if not raw_path.exists():
        print("Warning: bittentech_raw.json not found")
        return None
    with open(raw_path) as f:
        msgs = json.load(f)
    videos = [m for m in msgs if m.get("type") == "video"]
    course_key = "Bitten Tech Courses"
    claim_prefix = "bittentech-cybersec-2026"
    items = []
    for idx, v in enumerate(videos, 1):
        raw_name = (v.get("file_name") or v.get("text") or f"Lesson {idx}").strip()
        cl_title = clean_lesson_title(raw_name)
        fn = sanitize_filename(f"{idx:04d} - {cl_title}.mp4")
        msg_id = v.get("id")
        v_id = f"v_{hashlib.sha1(f'{course_key}:{idx}:{msg_id}'.encode()).hexdigest()[:12]}"
        cl_name = f"{claim_prefix}-{idx:04d}-{make_slug(cl_title)[:42]}"
        items.append({
            "idx": idx,
            "msg_id": v["id"],
            "kind": "video",
            "module_num": 1,
            "module_tag": "Module 01",
            "module_title": "Ethical Hacking & Pentesting",
            "title": f"{idx:04d} - {cl_title}",
            "clean_filename": fn,
            "orig_filename": fn,
            "needs_remux": False,
            "size": v.get("size") or 10000000,
            "duration": v.get("duration") or 600,
            "video_id": v_id,
            "claim_name": cl_name,
        })
    return {
        "course_key": course_key,
        "course_title": "Bitten Tech — Masterclass Cybersecurity & Offensive Penetration Testing",
        "instructor": "Ansh Bhawnani (Bitten Tech)",
        "category": "Cybersecurity, Ethical Hacking & Offensive Pentesting",
        "tags": ["Cybersecurity", "Ethical Hacking", "Bitten Tech", "Penetration Testing", "Active Directory", "Bug Bounty", "Kali Linux", "Metasploit", "Network Security", "Reverse Shells"],
        "description": "The comprehensive Masterclass Ethical Hacking and Offensive Penetration Testing curriculum by Bitten Tech (Ansh Bhawnani).",
        "channel_id": -1003716632867,
        "topic_id": None,
        "claim_prefix": claim_prefix,
        "learning_path_id": "lp_bittentech_cybersec_2026",
        "learning_path_goal": "Master Offensive Cybersecurity: Conduct Full-Scope Penetration Tests, Exploit Enterprise Networks, Dominate Active Directory Domains, and Author Professional Audit Reports.",
        "cover_colors": ((10, 15, 29), (5, 150, 105), "BITTEN TECH • CYBERSECURITY & OFFENSIVE PENTESTING", "1,284 Masterclass Lectures + 24 Verified Study Guides"),
        "modules": [{"num": 1, "tag": "Module 01", "title": "Ethical Hacking & Pentesting", "objectives": ["Master offensive penetration testing"]}],
        "items": items,
    }

def main():
    if not CURRICULA_PATH.exists():
        print("Curricula path not found")
        sys.exit(1)
    with open(CURRICULA_PATH) as f:
        curricula = json.load(f)

    print(f"Loaded existing curricula: {len(curricula)} courses")

    # Map existing courses by key
    courses_by_key = {c["course_key"]: c for c in curricula}

    # Add or update Harkirat
    harkirat = build_harkirat_course()
    if harkirat:
        courses_by_key[harkirat["course_key"]] = harkirat
        print(f"  Added/Updated: {harkirat['course_key']} ({len(harkirat['items'])} videos)")

    # Add or update Coder Gyan
    codergyan = build_codergyan_course()
    if codergyan:
        courses_by_key[codergyan["course_key"]] = codergyan
        print(f"  Added/Updated: {codergyan['course_key']} ({len(codergyan['items'])} videos)")

    # Add or update Bitten Tech
    bittentech = build_bittentech_course()
    if bittentech:
        courses_by_key[bittentech["course_key"]] = bittentech
        print(f"  Added/Updated: {bittentech['course_key']} ({len(bittentech['items'])} videos)")

    final_list = list(courses_by_key.values())
    print(f"\nFinal curricula total courses: {len(final_list)}")

    with open(CURRICULA_PATH, "w") as f:
        json.dump(final_list, f, indent=2)
    print(f"Saved to {CURRICULA_PATH}")

    BACKUP_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(BACKUP_PATH, "w") as f:
        json.dump(final_list, f, indent=2)
    print(f"Saved backup to {BACKUP_PATH}")

if __name__ == "__main__":
    main()
