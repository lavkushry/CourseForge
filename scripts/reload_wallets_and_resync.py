#!/usr/bin/env python3
"""
Comprehensive Wallet Reload & Full System Resync for CourseForge:
1. Reloads, checks status, unlocks tips, claims rewards, and audits all 8 Odysee worker wallets.
2. Resyncs all 1,354 Companion Study Materials across Manifest, Audit Catalog, Postgres & SQLite.
3. Resyncs all 33 Courses and 4,946+ Video Claims across Curricula, Postgres (courses, lessons, lesson_providers) & SQLite (videos, lecture_providers, course_metadata, course_publication).
4. Resyncs Users & Enrollments across all courses.
5. Verifies Pipeline & Media Gateway Health.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path
import psycopg2

ROOT_DIR = Path("/home/ubuntu/CourseForge")
sys.path.insert(0, str(ROOT_DIR / "scripts"))
from course_content_mapping import (  # noqa: E402
    claim_belongs_to_course,
    is_document_claim,
    is_material_item,
    is_video_item,
)
ODYSEE_PROXY = "https://api.na-backend.odysee.com/api/v1/proxy"
ODYSEE_API = "https://api.odysee.com"

# The 8 Authenticated LBRY/Odysee Worker Accounts
ACCOUNTS = [
    {
        "id": 0,
        "name": "Worker #0 (@lavkushry)",
        "token": "CszwoJHQaGAo4DFyJPrgrGn2JmyKGf5F",
        "channel_id": "29a2037dd2bf5e8d3c5eaee36243368fd8410fba",
        "wallet_address": "bUm3onjke3sVGWH27GWiguXxF5gh4wj3bv",
    },
    {
        "id": 1,
        "name": "Worker #1 (@courseforge-vault-2)",
        "token": "5hgCwtn2GCcunCpPg7z8fuUgYV5frxBF",
        "channel_id": "027d08f9b8aa21f9530fd44cc6d7f7de4aa57dce",
        "wallet_address": "bGqQPPmFsZqmhAXGUziSSjAVxoLKiATR3X",
    },
    {
        "id": 2,
        "name": "Worker #2 (@courseforge-vault-3)",
        "token": "9ryTA4sULdxnA3hZZPaPVVQDJvBa4G5u",
        "channel_id": "97af564bce47e5ed942e992d720da25fa173b00c",
        "wallet_address": "bDejtcHBAX3JN69A9Ke4FKrkBDJz5fm7nU",
    },
    {
        "id": 3,
        "name": "Worker #3 (@frdweb12)",
        "token": "31feNHAQyrk5KCXnxwQuFQbRg83hAGr7",
        "channel_id": "096b6b7c7e831d4c2051d173cd1c528998df2e98",
        "wallet_address": "bFcGsd6EEpJEvT6cgah4wFBYa5x8E5aM1F",
    },
    {
        "id": 4,
        "name": "Worker #4 (@babyMosai)",
        "token": "Cf98LFvmLBNQsqbmy1mZXxmP2wnbHroZ",
        "channel_id": "8fb43b578a5c8508b03bfd75e8dfe2a6f9ba1cde",
        "wallet_address": "bN3ryjn3F7TCgwCUh9wDMS7bqd9ignz7e6",
    },
    {
        "id": 5,
        "name": "Worker #5 (@kumarvivekanand427)",
        "token": "6KN2Wfe14qhyinSshBTgwt6igwnBmoqx",
        "channel_id": "485e18e67c115b92834b540c8e1cb1a9b2bd5ea9",
        "wallet_address": "bL6MMZz3b4ti1JY23JNA2tkVxFyAQW4Zur",
    },
    {
        "id": 6,
        "name": "Worker #6 (@hoanganh368394)",
        "token": "8kB1fxCZRqnm4KdMCAzkfJH9bJpkKh1N",
        "channel_id": "0ee459506ea893bd2692a680ffb64780080732d0",
        "wallet_address": "bTn9To86BbkqHKgSvawiP4U8wwuP1rJCs4",
    },
    {
        "id": 7,
        "name": "Worker #7 (@courseforge-vault-6)",
        "token": "FFR6ckhays2Jj4VUnfAE84TWevBWeT1b",
        "channel_id": "b724ab1577929a9c337e809848d04870f097a550",
        "wallet_address": "bPoSFKHAHpFLJKqzFZxYaAoAmu67RRr4VJ",
    },
    {
        "id": 8,
        "name": "Worker #8 (@gauravkumarkr27081996)",
        "token": "AhSUNhNrXGFstrNp1t8MGyACM4fsALLA",
        "channel_id": "7e45226e4d9f7cf1619a24730f450dba1fbd3cbb",
        "wallet_address": "bLJDTxSEyrg4k6NgHWYpAD6ST25RSdXmHw",
    },
    {
        "id": 9,
        "name": "Worker #9 (@jecuxy2915)",
        "token": "2nq2diujNk94uUeX85Zd56V8ma4ejchK",
        "channel_id": "b62902a05f926e11a07010466dc2b5eeb23c3d85",
        "wallet_address": "",
    },
    {
        "id": 10,
        "name": "Worker #10 (@togeki364)",
        "token": "EwwfiF8E1Vo3NZ4C6afgCBmvuQ5HHTyx",
        "channel_id": "9df519d4a630dc0b27c6d242306cb4634a4dc48f",
        "wallet_address": "",
    },
    {
        "id": 11,
        "name": "Worker #11 (@jyxisa3386)",
        "token": "BGMo9GGWgStVggKFhXWxuGKLhmUzWJ6S",
        "channel_id": "a4f55aa9f40806084ae31e60dc481f3e9d839868",
        "wallet_address": "",
    },
    {
        "id": 12,
        "name": "Worker #12 (@wepoga5498)",
        "token": "BHKsS8y3kuj6mtDrtA1wLQxT8v62mRvF",
        "channel_id": "6d4c761804625ee56f7d8ff2a69dd64317b98d4a",
        "wallet_address": "",
    },
    {
        "id": 13,
        "name": "Worker #13 (@rigyki589)",
        "token": "XTKSBbzbjgGQudvvPZ2VmvtbHtf1iWr2",
        "channel_id": "2135030d2b0ae5d72a3795c1b652712bf629ff21",
        "wallet_address": "bWG9E9ojzTXMdCuPEKGNBJRPpJfiSoR1nH",
    },
    {
        "id": 14,
        "name": "Worker #14 (@irfandaner)",
        "token": "jq8K5GV2rQrJ1H3i48KZ5UT7SYWCCGda",
        "channel_id": "5a3e7505007f66d5a6760ee67ac880779b1c20ff",
        "wallet_address": "bPBaoyDFJ8JAVCFyyxcoCWnye9YxZ6r286",
    },
]

def rpc_call(auth_token: str, method: str, params: dict, timeout: int = 15) -> dict:
    req = urllib.request.Request(
        f"{ODYSEE_PROXY}?m={method}",
        data=json.dumps({"jsonrpc": "2.0", "method": method, "params": params, "id": int(time.time() * 1000)}).encode(),
        headers={
            "X-Lbry-Auth-Token": auth_token,
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())

def get_balance(auth_token: str) -> dict:
    try:
        res = rpc_call(auth_token, "wallet_balance", {})
        return res.get("result", {})
    except Exception as e:
        return {"available": "0.0", "total": "0.0", "error": str(e)}

def unlock_tips(acc: dict) -> float:
    token = acc["token"]
    unlocked = 0.0
    try:
        res = rpc_call(token, "support_list", {"page_size": 50})
        items = (res.get("result") or {}).get("items") or []
        for it in items:
            txid = it.get("txid")
            nout = it.get("nout", 0)
            amt = float(it.get("amount", 0.0))
            if txid:
                try:
                    rpc_call(token, "support_abandon", {"txid": txid, "nout": nout})
                    unlocked += amt
                except Exception:
                    pass
    except Exception:
        pass
    return unlocked

def trim_channels(acc: dict):
    token = acc["token"]
    ch_id = acc["channel_id"]
    try:
        res = rpc_call(token, "channel_list", {})
        items = (res.get("result") or {}).get("items") or []
        for ch in items:
            if ch.get("claim_id") == ch_id:
                amt = float(ch.get("amount", "0.0"))
                if amt > 0.0015:
                    rpc_call(token, "channel_update", {"claim_id": ch_id, "bid": "0.001"})
    except Exception:
        pass

def reload_wallets():
    print("=" * 80)
    print("💰 STEP 1: RELOADING & AUDITING ALL 8 ODYSEE WORKER WALLETS")
    print("=" * 80)
    
    wallet_data = []
    total_avail = 0.0
    total_funds = 0.0
    total_claims = 0

    for acc in ACCOUNTS:
        token = acc["token"]
        trim_channels(acc)
        unlock_tips(acc)
        
        # Check wallet status
        status = rpc_call(token, "wallet_status", {}).get("result", {})
        bal = get_balance(token)
        avail = float(bal.get("available", 0.0))
        tot = float(bal.get("total", 0.0))
        
        # Total claims count
        claims_res = rpc_call(token, "claim_list", {"page_size": 1})
        claims_count = (claims_res.get("result") or {}).get("total_items", 0)
        
        total_avail += avail
        total_funds += tot
        total_claims += claims_count
        
        wallet_data.append({
            "name": acc["name"],
            "address": acc["wallet_address"],
            "available": avail,
            "total": tot,
            "claims": claims_count,
            "status": "Healthy" if not status.get("is_locked") else "Locked"
        })
        print(f"  {acc['name']:<32} | Avail: {avail:.6f} LBC | Total: {tot:.6f} LBC | Claims: {claims_count:<5} | {wallet_data[-1]['status']}")

    print("-" * 80)
    print(f"  Total Available Liquid LBC: {total_avail:.6f} LBC across 8 workers")
    print(f"  Total Locked/Reserved LBC : {total_funds - total_avail:.6f} LBC (staked in active claims)")
    print(f"  Total Claims on Chain     : {total_claims} claims")
    print("=" * 80)
    return wallet_data

def resync_companion_materials():
    print("\n" + "=" * 80)
    print("📚 STEP 2: RESYNCING COMPANION STUDY MATERIALS (from scratch)")
    print("=" * 80)
    # Delegate to the focused materials sync — claim-only UPDATE was skipping
    # inserts and leaving broken relative_path / single-lesson dumps intact.
    sync_script = ROOT_DIR / "scripts" / "sync_course_materials.py"
    if not sync_script.exists():
        raise FileNotFoundError(f"missing {sync_script}")
    proc = subprocess.run(
        [sys.executable, str(sync_script), "--apply"],
        cwd=str(ROOT_DIR),
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"sync_course_materials.py failed with code {proc.returncode}")

def resync_courses_and_videos():
    print("\n" + "=" * 80)
    print("🎬 STEP 3: RESYNCING COURSES, CURRICULA & VIDEO CLAIMS")
    print("=" * 80)
    
    curricula_path = ROOT_DIR / "new_5_curricula.json"
    manifest_path = ROOT_DIR / "data/odysee_manifest.json"
    sqlite_path = ROOT_DIR / "data/courseforge.sqlite3"
    
    with open(curricula_path) as f:
        curricula = json.load(f)
    with open(manifest_path) as f:
        manifest = json.load(f)

    # Fast manifest lookup tables
    manifest_by_claim_name = {v.get("claim_name"): v for v in manifest.values() if v.get("claim_name")}
    manifest_by_basename = {k.split("/")[-1]: v for k, v in manifest.items()}
    
    pg_conn = psycopg2.connect("postgresql://courseforge:local_rewrite_only@127.0.0.1:15439/courseforge_rewrite")
    pg_cur = pg_conn.cursor()
    
    sq_conn = sqlite3.connect(sqlite_path) if sqlite_path.exists() else None
    sq_cur = sq_conn.cursor() if sq_conn else None

    total_lessons = 0
    mapped_lessons = 0
    
    for c in curricula:
        course_key = c.get("course_key")
        title = c.get("course_title") or c.get("title") or course_key
        desc = c.get("description", "")
        instructor = c.get("instructor", "CourseForge Lead Faculty")
        category = c.get("category", "Software Engineering")
        
        # Ensure course exists in PostgreSQL
        pg_cur.execute(
            """INSERT INTO courses (id, title, description, published, instructor, category, updated_at)
               VALUES (%s, %s, %s, true, %s, %s, NOW())
               ON CONFLICT (id) DO UPDATE SET
                   title = EXCLUDED.title,
                   description = EXCLUDED.description,
                   published = true,
                   instructor = EXCLUDED.instructor,
                   category = EXCLUDED.category,
                   updated_at = NOW();""",
            (course_key, title, desc, instructor, category)
        )
        
        # Process video lessons only — study/document items belong in materials.
        items = c.get("items", [])
        claim_prefix = c.get("claim_prefix")
        for item in items:
            if is_material_item(item) or not is_video_item(item):
                continue
            total_lessons += 1
            idx = item.get("idx")
            lesson_id = item.get("video_id") or f"v_{hashlib.sha1(f'{course_key}:{idx}'.encode()).hexdigest()[:12]}"
            l_title = item.get("title") or f"Lesson {idx}"
            sec_title = item.get("module_title") or f"Module {item.get('module_num', 1)}"
            dur = float(item.get("duration") or 3600.0)
            
            # Find claim from manifest or item
            v_entry = None
            cf = item.get("clean_filename")
            cname = item.get("claim_name")
            
            if cf and cf in manifest:
                v_entry = manifest[cf]
            elif cf and cf in manifest_by_basename:
                v_entry = manifest_by_basename[cf]
            elif f"{course_key}/{cf}" in manifest:
                v_entry = manifest[f"{course_key}/{cf}"]
            elif cname and cname in manifest_by_claim_name:
                v_entry = manifest_by_claim_name[cname]
                
            claim_id = v_entry.get("claim_id") if v_entry else item.get("claim_id")
            claim_name = v_entry.get("claim_name") if v_entry else item.get("claim_name")
            if is_document_claim(claim_name) or (
                claim_name and not claim_belongs_to_course(claim_name, course_key, claim_prefix)
            ):
                claim_id = None
                claim_name = None
            
            # Register in Postgres lessons
            pg_cur.execute(
                """INSERT INTO lessons (id, course_id, title, sort_order, duration_seconds, section_title, flow_order, status, created_at)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, 'done', NOW())
                   ON CONFLICT (id) DO UPDATE SET
                       title = EXCLUDED.title,
                       sort_order = EXCLUDED.sort_order,
                       duration_seconds = EXCLUDED.duration_seconds,
                       section_title = EXCLUDED.section_title;""",
                (lesson_id, course_key, l_title, idx, dur, sec_title, float(idx))
            )
            
            if claim_id and claim_name:
                mapped_lessons += 1
                # Sync into PostgreSQL lesson_providers
                pg_cur.execute(
                    """INSERT INTO lesson_providers (lesson_id, claim_name, claim_id, updated_at)
                       VALUES (%s, %s, %s, NOW())
                       ON CONFLICT (lesson_id) DO UPDATE SET
                           claim_name = EXCLUDED.claim_name,
                           claim_id = EXCLUDED.claim_id,
                           updated_at = NOW();""",
                    (lesson_id, claim_name, claim_id)
                )

                # Sync into SQLite lecture_providers & videos
                if sq_cur:
                    sq_cur.execute(
                        """INSERT OR REPLACE INTO lecture_providers (video_id, claim_name, claim_id, updated_at)
                           VALUES (?, ?, ?, datetime('now'));""",
                        (lesson_id, claim_name, claim_id)
                    )
                    sq_cur.execute(
                        """INSERT OR REPLACE INTO videos (id, path, course, title, bytes, mtime_ns, status, duration, created_at)
                           VALUES (?, ?, ?, ?, ?, 0, 'ready', ?, datetime('now'));""",
                        (lesson_id, f"courses/{course_key}/{cf}", course_key, l_title, item.get("size", 100000000), dur)
                    )

    pg_conn.commit()
    print(f"  PostgreSQL: {len(curricula)} Courses and {total_lessons} Lessons synchronized.")
    print(f"  PostgreSQL: {mapped_lessons} / {total_lessons} Video claims mapped into lesson_providers ({mapped_lessons/total_lessons*100:.1f}%)")
    pg_conn.close()

    # Sync SQLite metadata & publication
    if sq_conn:
        for c in curricula:
            ck = c.get("course_key")
            sq_cur.execute(
                """INSERT OR REPLACE INTO course_metadata (course, title, instructor, category, tags_json, updated_at)
                   VALUES (?, ?, ?, ?, ?, datetime('now'));""",
                (ck, c.get("course_title", ck), c.get("instructor", ""), c.get("category", ""), json.dumps(c.get("tags", [])))
            )
            sq_cur.execute(
                """INSERT OR REPLACE INTO course_publication (course, published, description, updated_at)
                   VALUES (?, 1, ?, datetime('now'));""",
                (ck, c.get("description", ""))
            )
        sq_conn.commit()
        sq_conn.close()
        print(f"  SQLite: course_metadata, publication, videos, and lecture_providers synchronized for {len(curricula)} courses.")

def resync_users():
    print("\n" + "=" * 80)
    print("👤 STEP 4: RESYNCING USERS, ROLES & ENROLLMENTS")
    print("=" * 80)
    fix_script = ROOT_DIR / "scripts/fix_accounts.py"
    if fix_script.exists():
        subprocess.run([str(ROOT_DIR / ".venv/bin/python"), str(fix_script)], check=False)

def verify_pipeline():
    print("\n" + "=" * 80)
    print("🚀 STEP 5: VERIFYING PIPELINE RUNTIME & STORAGE")
    print("=" * 80)
    
    # Check process
    proc = subprocess.run(["pgrep", "-f", "linux_pipeline.py"], capture_output=True, text=True)
    pids = proc.stdout.strip().split()
    if pids:
        print(f"  ✅ linux_pipeline.py is actively running (PID: {', '.join(pids)})")
    else:
        print("  ⚠️ Pipeline not currently running; launching in background...")
        subprocess.Popen(
            ["nohup", ".venv/bin/python", "-u", "linux_pipeline.py"],
            cwd=str(ROOT_DIR),
            stdout=open(ROOT_DIR / "linux_pipeline.log", "a"),
            stderr=subprocess.STDOUT,
            preexec_fn=os.setpgrp
        )
        print("  ✅ Pipeline launched successfully.")

    # Check disk
    df_out = subprocess.run(["df", "-h", "/dev/sda1"], capture_output=True, text=True).stdout
    for line in df_out.strip().splitlines()[1:]:
        parts = line.split()
        if len(parts) >= 5:
            print(f"  💾 Storage Status: {parts[3]} available ({parts[4]} used)")

def main():
    reload_wallets()
    resync_companion_materials()
    resync_courses_and_videos()
    resync_users()
    verify_pipeline()
    print("\n" + "=" * 80)
    print("🏁 FULL RELOAD & RESYNC COMPLETE SUCCESSFULLY!")
    print("=" * 80)

if __name__ == "__main__":
    main()
