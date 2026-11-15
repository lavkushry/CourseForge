#!/usr/bin/env python3
"""
Fast-Track Multi-Wallet Batch Uploader for 1,144 Missing Companion Study Materials:
- Distributes 1,144 files across 8 dedicated worker threads (1 account/channel per thread).
- Uses 10 MB TUS chunking with zero-byte newline fallback.
- Submits stream_create with worker channel_id and tag c:unlisted.
- Checkpoints progress after every upload into /home/ubuntu/CourseForge/data/odysee_docs_manifest.json.
- Thread-safe, resilient against network timeouts and blockchain confirmations.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import mimetypes
import queue
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urljoin

ODYSEE_PROXY = "https://api.na-backend.odysee.com/api/v1/proxy"
ODYSEE_ASYNQ = "https://api.na-backend.odysee.com/api/v1/asynqueries"
CHUNK_SIZE = 10 * 1024 * 1024  # 10 MB chunks

ROOT_DIR = Path("/home/ubuntu/CourseForge")
DATA_DIR = ROOT_DIR / "data"
MANIFEST_PATH = DATA_DIR / "odysee_docs_manifest.json"
AUDIT_CATALOG_PATH = ROOT_DIR / "COMPANION_MATERIALS_AUDIT.json"

ACCOUNTS = [
    {
        "id": 1,
        "name": "Worker #1 (@courseforge-vault-2)",
        "token": "5hgCwtn2GCcunCpPg7z8fuUgYV5frxBF",
        "channel_id": "027d08f9b8aa21f9530fd44cc6d7f7de4aa57dce",
    },
    {
        "id": 7,
        "name": "Worker #7 (@courseforge-vault-6)",
        "token": "FFR6ckhays2Jj4VUnfAE84TWevBWeT1b",
        "channel_id": "b724ab1577929a9c337e809848d04870f097a550",
    },
]

COURSE_CLAIM_PREFIXES = {
    "Advanced Agentic AI And Gen AI By Prudhvi Sir Nareshit 2026": "agentic-genai-2026",
    "Arpit Bhaiyani - System Design Course": "arpit-bhayani-sd-2026",
    "Azure Data Engineering 2026 (Bhaskar Jogi)": "bhaskar-jogi-azure",
    "Codebasics Data Engineering Bootcamp 1.0": "codebasics-de-2026",
    "Daksh 3 ssc cgl 2025": "daksh-ssc-cgl-2025",
    "Deepak Data Engg": "mission-ade-2026",
    "DevOps with Multi-Cloud & AI (Veerababu)": "veerababu-devops",
    "Gaurav Sen AI Engineering 2026": "gauravsen-ai-2026",
    "Gaurav Sen Low Level Design (LLD) 2026": "gauravsen-lld-2026",
    "Gaurav Sen System Design Simplified (HLD)": "gauravsen-hld-2026",
    "Grow Data Skills Complete Data Engineering With Azure": "grow-data-skills-azure",
    "Harkirat 100x combined bootcamp Coursedost": "harkirat-100x-2026",
    "Harkirat Singh Super 30 Courses": "harkirat-super30-2026",
    "Keerti Purswani Agentic AI System Design Course 2026": "keerti-agentic-sd-2026",
    "Namaste AI": "namaste-ai-2026",
    "Namaste SQL Coursedost": "namaste-sql-ankit",
    "Sanket Advanced System Design HLD LLD 2026": "sanket-sd-2026",
    "Sanket Singh Complete AI Engineer Bootcamp 2026": "sanket-ai-eng-2026",
    "Sanket Singh System Design 2.0 2026": "sanket-sd2-2026",
    "Sanket Spring boot": "sanket-sb-2026",
    "TrendyTech Ultimate Big Data Masters Program": "trendytech-bigdata",
    "Vimal Daga Courses 2025": "vimal-daga-ai-2025",
    "Vizuara AI - Build Voice Agents From Scratch 2026": "vizuara-voice-agents-2026",
    "Vizuara AI - Context Engineering for LLMs 2026": "vizuara-context-eng-2026",
    "Vizuara AI - Master LLM Inference Engineering 2026": "vizuara-inference-eng-2026",
    "Vizuara AI - Production AI Agents Bootcamp 2026": "vizuara-ai-agents-bootcamp-2026",
    "Vizuara AI - Reinforcement Learning & RLHF 2026": "vizuara-reinforcement-learning-2026",
    "Vizuara AI - SLM Small Language Models Engineering 2026": "vizuara-slm-eng-2026",
}


def guess_mime(path: Path) -> str:
    ext = path.suffix.lower()
    custom = {
        ".ipynb": "application/x-ipynb+json",
        ".sql": "text/plain",
        ".py": "text/x-python",
        ".txt": "text/plain",
        ".md": "text/markdown",
        ".json": "application/json",
        ".csv": "text/csv",
        ".yaml": "text/yaml",
        ".yml": "text/yaml",
        ".pdf": "application/pdf",
        ".zip": "application/zip",
        ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }
    if ext in custom:
        return custom[ext]
    mt, _ = mimetypes.guess_type(path.name)
    return mt or "application/octet-stream"


def make_claim_name(course_id: str, filename: str) -> str:
    prefix = COURSE_CLAIM_PREFIXES.get(course_id, "cf-doc")
    slug_part = re.sub(r"[^a-zA-Z0-9]+", "-", filename.lower()).strip("-")
    return f"{prefix}-doc-{slug_part}"[:80].strip("-")


def request_upload_token(auth_token: str) -> tuple[str, str]:
    req = urllib.request.Request(
        f"{ODYSEE_ASYNQ}/uploads/",
        data=b"{}",
        method="POST",
        headers={
            "X-Lbry-Auth-Token": auth_token,
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read().decode())
    payload = data.get("payload") or {}
    if data.get("status") != "upload_token_created" or not payload.get("token") or not payload.get("location"):
        raise RuntimeError(f"Failed to get upload token: {data}")
    return payload["token"], payload["location"]


def start_tus_upload(upload_location: str, upload_token: str, file_path: Path) -> str:
    file_size = file_path.stat().st_size
    if file_size == 0:
        raw_bytes = b"\n"
        file_size = 1
    else:
        raw_bytes = None

    b64_name = base64.b64encode(file_path.name.encode()).decode()
    b64_type = base64.b64encode(guess_mime(file_path).encode()).decode()

    req = urllib.request.Request(
        upload_location,
        method="POST",
        headers={
            "Authorization": f"Bearer {upload_token}",
            "Tus-Resumable": "1.0.0",
            "Upload-Length": str(file_size),
            "Upload-Metadata": f"filename {b64_name},filetype {b64_type}",
            "Content-Length": "0",
            "User-Agent": "Mozilla/5.0",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        tus_url = resp.headers.get("Location")
    if not tus_url:
        raise RuntimeError("No Location returned from TUS init")
    if tus_url.startswith("/"):
        tus_url = urljoin(upload_location, tus_url)

    if raw_bytes is not None:
        patch_req = urllib.request.Request(
            tus_url,
            data=raw_bytes,
            method="PATCH",
            headers={
                "Authorization": f"Bearer {upload_token}",
                "Tus-Resumable": "1.0.0",
                "Upload-Offset": "0",
                "Content-Type": "application/offset+octet-stream",
                "Content-Length": "1",
                "User-Agent": "Mozilla/5.0",
            },
        )
        urllib.request.urlopen(patch_req, timeout=60).close()
        return tus_url

    offset = 0
    with file_path.open("rb") as f:
        while offset < file_size:
            chunk = f.read(CHUNK_SIZE)
            if not chunk:
                break
            patch_req = urllib.request.Request(
                tus_url,
                data=chunk,
                method="PATCH",
                headers={
                    "Authorization": f"Bearer {upload_token}",
                    "Tus-Resumable": "1.0.0",
                    "Upload-Offset": str(offset),
                    "Content-Type": "application/offset+octet-stream",
                    "Content-Length": str(len(chunk)),
                    "User-Agent": "Mozilla/5.0",
                },
            )
            with urllib.request.urlopen(patch_req, timeout=300) as patch_resp:
                offset = int(patch_resp.headers.get("Upload-Offset", offset + len(chunk)))
    return tus_url


def create_doc_claim(
    auth_token: str,
    tus_file_url: str,
    title: str,
    claim_name: str,
    course_desc: str,
    channel_id: str,
) -> tuple[str, str]:
    tags = ["study-material", "courseforge", "c:unlisted"]
    sdk_params = {
        "name": claim_name,
        "title": title,
        "description": f"Study Material: {title}\nCourse: {course_desc}",
        "bid": "0.00001",
        "languages": ["en"],
        "tags": tags,
        "thumbnail_url": "https://odysee.com/public/favicon.png",
        "file_path": tus_file_url,
        "optimize_file": False,
        "channel_id": channel_id,
    }
    body = json.dumps({
        "jsonrpc": "2.0",
        "method": "stream_create",
        "params": sdk_params,
        "id": int(time.time() * 1000),
    }).encode()
    req = urllib.request.Request(
        f"{ODYSEE_ASYNQ}/",
        data=body,
        method="POST",
        headers={
            "X-Lbry-Auth-Token": auth_token,
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0",
        },
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = json.loads(resp.read().decode())
    query_id = (data.get("payload") or {}).get("query_id")
    if not query_id:
        raise RuntimeError(f"Unexpected query_created response: {data}")

    for delay in [2, 3, 4, 5, 6, 8]:
        time.sleep(delay)
        status_req = urllib.request.Request(
            f"{ODYSEE_ASYNQ}/{query_id}",
            method="GET",
            headers={
                "X-Lbry-Auth-Token": auth_token,
                "Content-Type": "application/json",
                "User-Agent": "Mozilla/5.0",
            },
        )
        try:
            with urllib.request.urlopen(status_req, timeout=30) as s_resp:
                if s_resp.status == 204:
                    continue
                s_json = json.loads(s_resp.read().decode())
                if s_json.get("result"):
                    outputs = s_json["result"].get("outputs") or [{}]
                    claim_id = outputs[0].get("claim_id")
                    txid = s_json["result"].get("txid")
                    if claim_id and txid:
                        return claim_id, txid

                if s_json.get("error"):
                    err = s_json["error"]
                    raise RuntimeError(f"Odysee SDK error in stream_create: {err}")
        except urllib.error.HTTPError as e:
            if e.code in (404, 429, 500, 502, 503, 504):
                continue
            raise

    # Fallback to direct claim search if already exists
    search_req = urllib.request.Request(
        f"{ODYSEE_PROXY}?m=claim_search",
        data=json.dumps({"jsonrpc": "2.0", "method": "claim_search", "params": {"name": claim_name}, "id": 1}).encode(),
        headers={"X-Lbry-Auth-Token": auth_token, "Content-Type": "application/json", "User-Agent": "Mozilla/5.0"},
    )
    with urllib.request.urlopen(search_req, timeout=15) as s_resp:
        items = json.loads(s_resp.read().decode()).get("result", {}).get("items") or []
        if items:
            c = items[0]
            return c["claim_id"], c.get("txid") or ""

    raise RuntimeError(f"Timeout waiting for claim creation: query_id {query_id}")


def main() -> None:
    print("=" * 80)
    print("🚀 FAST-TRACK MULTI-WALLET BATCH UPLOADER (8 WORKERS)")
    print("=" * 80)

    # 1. Load Manifest
    manifest_lock = threading.Lock()
    manifest: dict[str, dict] = {}
    if MANIFEST_PATH.exists():
        try:
            with open(MANIFEST_PATH, "r", encoding="utf-8") as f:
                manifest = json.load(f)
        except Exception:
            manifest = {}
    print(f"Loaded existing manifest with {len(manifest)} claims.")

    # 2. Load Audit Catalog
    with open(AUDIT_CATALOG_PATH, "r", encoding="utf-8") as f:
        catalog = json.load(f)

    # Filter items that are pending upload
    pending_items = []
    for item in catalog:
        key = f"{item['course_id']}/{item['filename']}"
        if key not in manifest:
            pending_items.append(item)

    print(f"Total cataloged items: {len(catalog)}")
    print(f"Already uploaded in manifest: {len(manifest)}")
    print(f"Pending to upload: {len(pending_items)}")

    if not pending_items:
        print("✅ All items are already uploaded! Nothing to do.")
        return

    work_queue: queue.Queue[tuple[int, dict]] = queue.Queue()
    for idx, item in enumerate(pending_items, 1):
        work_queue.put((idx, item))

    total_pending = len(pending_items)
    success_count = [0]
    total_completed = [len(manifest)]

    def worker_thread(account: dict):
        worker_id = account["id"]
        token = account["token"]
        channel_id = account["channel_id"]
        worker_name = account["name"]

        while True:
            try:
                idx, item = work_queue.get_nowait()
            except queue.Empty:
                break

            course_id = item["course_id"]
            filename = item["filename"]
            key = f"{course_id}/{filename}"
            server_path = Path(item["server_path"])

            with manifest_lock:
                if key in manifest:
                    work_queue.task_done()
                    continue

            if not server_path.exists():
                print(f"[{worker_name}] ❌ File not found on disk: {server_path}")
                work_queue.task_done()
                continue

            claim_name = make_claim_name(course_id, filename)
            size_kb = round(server_path.stat().st_size / 1024, 1)

            uploaded = False
            for attempt in range(4):
                try:
                    up_token, up_loc = request_upload_token(token)
                    tus_url = start_tus_upload(up_loc, up_token, server_path)
                    claim_id, txid = create_doc_claim(
                        auth_token=token,
                        tus_file_url=tus_url,
                        title=filename,
                        claim_name=claim_name,
                        course_desc=course_id,
                        channel_id=channel_id,
                    )
                    entry = {
                        "course": course_id,
                        "name": filename,
                        "ext": server_path.suffix.lower().lstrip("."),
                        "size_kb": size_kb,
                        "claim_name": claim_name,
                        "claim_id": claim_id,
                        "txid": txid,
                        "odysee_url": f"https://odysee.com/{claim_name}:{claim_id}",
                        "uploaded_at": int(time.time()),
                    }
                    with manifest_lock:
                        manifest[key] = entry
                        with open(MANIFEST_PATH, "w", encoding="utf-8") as mf:
                            json.dump(manifest, mf, indent=2)
                        success_count[0] += 1
                        total_completed[0] += 1
                        done = success_count[0]
                        total_in_m = total_completed[0]

                    print(f"[{worker_name}] [{done}/{total_pending} Uploaded | Manifest: {total_in_m}/1282] {claim_name} -> {claim_id}", flush=True)
                    uploaded = True
                    break
                except Exception as exc:
                    print(f"[{worker_name}] ⚠️ Attempt {attempt+1}/4 failed on {filename}: {exc}", flush=True)
                    time.sleep(2 * (attempt + 1))

            if not uploaded:
                print(f"[{worker_name}] ❌ FAILED after 4 attempts: {filename}", flush=True)

            work_queue.task_done()

    threads = []
    for acc in ACCOUNTS:
        t = threading.Thread(target=worker_thread, args=(acc,), daemon=True)
        t.start()
        threads.append(t)

    work_queue.join()
    for t in threads:
        t.join(timeout=2)

    print("=" * 80)
    print(f"🎉 BATCH UPLOAD FINISHED: {success_count[0]}/{total_pending} items processed.")
    print(f"Total entries now in manifest: {len(manifest)}/1282")
    print("=" * 80)


if __name__ == "__main__":
    main()
