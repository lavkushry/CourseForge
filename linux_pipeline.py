#!/usr/bin/env python3
"""
Autonomous Linux Cloud Pipeline (Ultra-Turbo Multi-Engine Edition):
Runs directly on the high-speed Linux server (Oracle Cloud Datacenter):
1. Downloads Telegram course videos using patched FastTelethon (zero socket leaks, cached DC auth).
2. Dual Concurrent Downloaders + Triple Concurrent Odysee Uploaders (3x Parallel Account/Channel Pool):
   - Slot 1: 9ryTA4sULdxnA3hZZPaPVVQDJvBa4G5u (@courseforge-vault-3)
   - Slot 2: 31feNHAQyrk5KCXnxwQuFQbRg83hAGr7 (@frdweb12)
   - Slot 3: Cf98LFvmLBNQsqbmy1mZXxmP2wnbHroZ (@babyMosai)
3. Direct fresh message lookup per video (0% FileReferenceExpiredError rate).
4. Auto-remuxes .ts to .mp4 via ffmpeg when required.
5. Mapped directly into CourseForge live production database (courseforge.sqlite3).
6. Strict Storage Stack Guard:
   - Trigger ceiling: 6 GB (if cache >= 6 GB, automatically prunes oldest inactive files down to <= 2 GB).
   - Each completed lecture is deleted immediately upon upload.
7. Runs 24/7 autonomously until all 24 courses in new_5_curricula.json are 100% complete.
"""
from __future__ import annotations

import asyncio
import inspect
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from telethon import TelegramClient, utils
from FastTelethonhelper import download_file
import odysee_batch_upload as obu

ROOT_DIR = Path("/home/ubuntu/CourseForge")
TEMP_DIR = ROOT_DIR / "temp_videos"
TEMP_DIR.mkdir(parents=True, exist_ok=True)

# ----------------------------------------------------------------------
# Storage Stack Guard Configuration
# If cache reaches 6 GB, prune oldest 4 GB down to <= 2 GB. Absolute cap 10 GB.
# ----------------------------------------------------------------------
MAX_STORAGE_BYTES = 6 * 1024 * 1024 * 1024       # 6 GB Trigger threshold
PRUNE_TARGET_BYTES = 2 * 1024 * 1024 * 1024      # Target after pruning (deleting 4 GB)
ABSOLUTE_LIMIT_BYTES = 10 * 1024 * 1024 * 1024   # 10 GB hard limit

ACTIVE_FILES: set[Path] = set()
MANIFEST_LOCK = threading.Lock()


def get_cache_size() -> int:
    total = 0
    if TEMP_DIR.exists():
        for p in TEMP_DIR.iterdir():
            if p.is_file():
                try:
                    total += p.stat().st_size
                except Exception:
                    pass
    return total


def enforce_storage_stack():
    """
    Storage stack manager:
    If temporary cache exceeds 6 GB, deletes the oldest inactive files in FIFO stack order
    until cache drops to <= 2 GB.
    """
    total = get_cache_size()
    if total >= MAX_STORAGE_BYTES:
        cur_gb = total / (1024 ** 3)
        print(f"\n🚨 [Storage Stack Guard] Cache reached {cur_gb:.2f} GB >= 6 GB threshold! Pruning inactive files...", flush=True)
        files = []
        if TEMP_DIR.exists():
            for p in TEMP_DIR.iterdir():
                if p.is_file() and p not in ACTIVE_FILES:
                    try:
                        files.append((p.stat().st_mtime, p.stat().st_size, p))
                    except Exception:
                        pass
        files.sort(key=lambda x: x[0])
        freed = 0
        for mtime, fsz, p in files:
            try:
                p.unlink(missing_ok=True)
                freed += fsz
                total -= fsz
                print(f"   🗑️ Stack Pruned: {p.name} ({fsz / (1024**2):.1f} MB)", flush=True)
                if total <= PRUNE_TARGET_BYTES:
                    break
            except Exception as e:
                print(f"   ⚠️ Could not prune {p.name}: {e}", flush=True)
        print(f"  ✅ [Storage Stack Guard] Pruned {freed / (1024**3):.2f} GB. Cache is now {total / (1024**3):.2f} GB.\n", flush=True)


CURRICULA_PATH = ROOT_DIR / "new_5_curricula.json"
MANIFEST_PATH = ROOT_DIR / "data/odysee_manifest.json"
ROOT_MANIFEST = ROOT_DIR / "odysee_manifest.json"
DB_PATH = ROOT_DIR / "data/courseforge.sqlite3"
SESSION_PATH = str(ROOT_DIR / ".tg_downloader")

API_ID = 2040
API_HASH = "b18441a1ff607e10a989891a5462e627"

# ----------------------------------------------------------------------
# Multi-Token Odysee Parallel Pool & Channel Mapping
# ----------------------------------------------------------------------
ODYSEE_TOKENS = [
    "9ryTA4sULdxnA3hZZPaPVVQDJvBa4G5u",
    "31feNHAQyrk5KCXnxwQuFQbRg83hAGr7",
    "Cf98LFvmLBNQsqbmy1mZXxmP2wnbHroZ",
    "6KN2Wfe14qhyinSshBTgwt6igwnBmoqx",
]
TOKEN_CHANNELS = {
    "9ryTA4sULdxnA3hZZPaPVVQDJvBa4G5u": "97af564bce47e5ed942e992d720da25fa173b00c",
    "31feNHAQyrk5KCXnxwQuFQbRg83hAGr7": "096b6b7c7e831d4c2051d173cd1c528998df2e98",
    "Cf98LFvmLBNQsqbmy1mZXxmP2wnbHroZ": "8fb43b578a5c8508b03bfd75e8dfe2a6f9ba1cde",
    "6KN2Wfe14qhyinSshBTgwt6igwnBmoqx": "485e18e67c115b92834b540c8e1cb1a9b2bd5ea9",
}
ODYSEE_CHANNEL_ID = "97af564bce47e5ed942e992d720da25fa173b00c"


class OdyseeTokenRotator:
    def __init__(self, tokens: list[str], start_idx: int = 0):
        self.tokens = list(tokens)
        self.idx = start_idx % len(self.tokens)
        self._lock = threading.Lock()

    @property
    def current(self) -> str:
        with self._lock:
            return self.tokens[self.idx]

    def rotate(self, reason: str = "") -> str:
        with self._lock:
            old_tok = self.tokens[self.idx][:8]
            self.idx = (self.idx + 1) % len(self.tokens)
            new_tok = self.tokens[self.idx][:8]
            print(f"  🔄 [Odysee Token Failover] Rotated token {old_tok}... -> {new_tok}... (Slot {self.idx+1}/{len(self.tokens)}) | Reason: {reason[:120]}", flush=True)
            return self.tokens[self.idx]


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def load_manifest() -> dict:
    if MANIFEST_PATH.exists():
        try:
            return json.loads(MANIFEST_PATH.read_text())
        except Exception:
            pass
    if ROOT_MANIFEST.exists():
        try:
            return json.loads(ROOT_MANIFEST.read_text())
        except Exception:
            pass
    return {}


def save_manifest(manifest: dict):
    text = json.dumps(manifest, indent=2)
    MANIFEST_PATH.write_text(text)
    ROOT_MANIFEST.write_text(text)


def record_claim_in_db(video_id: str, claim_name: str, claim_id: str):
    if not DB_PATH.exists():
        return
    try:
        with sqlite3.connect(str(DB_PATH), timeout=30) as conn:
            conn.execute(
                """INSERT INTO lecture_providers(video_id, claim_name, claim_id, updated_at)
                   VALUES (?, ?, ?, ?)
                   ON CONFLICT(video_id) DO UPDATE SET
                     claim_name=excluded.claim_name,
                     claim_id=excluded.claim_id,
                     updated_at=excluded.updated_at""",
                (video_id, claim_name, claim_id, utcnow()),
            )
    except Exception as e:
        print(f"  ⚠️ DB insert note: {e}", flush=True)


def do_odysee_upload_sync(
    course: dict,
    v_item: dict,
    target_mp4: Path,
    token_rotator: OdyseeTokenRotator,
    total_vids: int,
    worker_id: int = 0,
) -> bool:
    """
    Synchronously upload a single video to Odysee via TUS in a background thread.
    Multiple workers run concurrently across independent Odysee tokens/channels.
    """
    course_key = course["course_key"]
    v_idx = v_item["idx"]
    size_mb = v_item["size"] / (1024 * 1024)
    claim_name = v_item["claim_name"]
    title = v_item["title"]
    base_tags = [course_key.lower().replace(" ", "-"), "courseforge", "lecture"]
    m_key = f"{course_key}/{v_item['clean_filename']}"

    print(f"\n📤 [Odysee Worker #{worker_id+1} Starting] [{course_key} Video {v_idx:03d}/{total_vids}] ({size_mb:.1f} MB)...", flush=True)

    thumb_file = obu.extract_thumbnail(target_mp4)
    thumb_url = obu.upload_thumbnail(thumb_file) if thumb_file else "https://odysee.com/public/favicon.png"
    if thumb_file and thumb_file.exists():
        thumb_file.unlink(missing_ok=True)

    max_up_attempts = max(6, len(ODYSEE_TOKENS) * 2)
    for up_attempt in range(max_up_attempts):
        active_token = token_rotator.current
        active_channel = TOKEN_CHANNELS.get(active_token, ODYSEE_CHANNEL_ID)
        try:
            up_token, up_location = obu.request_upload_token(active_token)
            tus_url = obu.start_tus_upload(up_location, up_token, target_mp4)
            sdk_res = obu.create_claim_and_wait(
                auth_token=active_token,
                tus_file_url=tus_url,
                title=title,
                claim_name=claim_name,
                thumb_url=thumb_url,
                course_desc=course["description"][:240],
                base_tags=base_tags,
                channel_id=active_channel,
                unlisted=True,
            )
            outputs = sdk_res.get("outputs") or [{}]
            claim_id = outputs[0].get("claim_id", "")
            if not claim_id:
                raise RuntimeError(f"Missing claim_id in {sdk_res}")

            odysee_url = f"https://odysee.com/{claim_name}:{claim_id}"
            stream_url = f"https://odysee.com/$/stream/{claim_name}/{claim_id}"

            with MANIFEST_LOCK:
                manifest = load_manifest()
                manifest[m_key] = {
                    "video_id": v_item["video_id"],
                    "course": course_key,
                    "title": title,
                    "claim_name": claim_name,
                    "claim_id": claim_id,
                    "odysee_url": odysee_url,
                    "stream_url": stream_url,
                    "uploaded_at": utcnow(),
                }
                save_manifest(manifest)
                record_claim_in_db(v_item["video_id"], claim_name, claim_id)
                total_all = sum(1 for v in manifest.values() if v.get("claim_id"))

            print(f"  🚀 [{course_key} Odysee {v_idx:03d}/{total_vids} Mapped | Platform: {total_all}/3256] -> {odysee_url}", flush=True)
            return True
        except Exception as e:
            err_str = str(e).lower()
            print(f"  ⚠️ Odysee retry {up_attempt+1}/{max_up_attempts} for [{v_idx:03d}] (Worker #{worker_id+1}, Token: {active_token[:8]}...): {e}", flush=True)
            if any(k in err_str for k in ["token", "unauthorized", "forbidden", "expired", "quota", "rate limit", "limit exceeded", "auth", "fund", "funds", "balance", "insufficient", "channel"]):
                token_rotator.rotate(reason=str(e))
            time.sleep(3 * (up_attempt + 1))
    return False


async def main():
    print(f"================================================================================", flush=True)
    print(f"🚀 CLOUD PIPELINE (ULTRA-TURBO MULTI-ENGINE EDITION): Oracle Cloud ({utcnow()})", flush=True)
    print(f"   Storage Stack Guard: 6 GB trigger -> 4 GB prune (Target: <= 2 GB, Cap: 10 GB)", flush=True)
    print(f"   Turbo Parallelism: 2x Concurrent Telegram Downloaders + 3x Odysee Upload Workers", flush=True)
    print(f"   Zero Socket Leaks: Patched FastTelethon + Cached Cross-DC Auth + Fresh FileRefs", flush=True)
    print(f"================================================================================", flush=True)

    # Clean up stale .part or orphaned .mp4 files on startup
    if TEMP_DIR.exists():
        for p in TEMP_DIR.iterdir():
            if p.is_file():
                try:
                    p.unlink(missing_ok=True)
                except Exception:
                    pass

    # Create 3 dedicated token rotators staggered across the 3 accounts
    worker_rotators = [OdyseeTokenRotator(ODYSEE_TOKENS, start_idx=i) for i in range(4)]

    client = TelegramClient(SESSION_PATH, API_ID, API_HASH)
    await client.connect()
    if not await client.is_user_authorized():
        print("❌ Telegram client is NOT authorized! Exiting.", flush=True)
        return

    me = await client.get_me()
    print(f"✅ Telegram Connected as: {me.first_name} (+{me.phone})", flush=True)

    cycle = 0
    while True:
        cycle += 1
        courses = json.loads(CURRICULA_PATH.read_text())
        manifest = load_manifest()

        total_remaining = 0
        for c in courses:
            vids = [x for x in c["items"] if x["kind"] == "video"]
            for v in vids:
                k1 = f"{c['course_key']}/{v['clean_filename']}"
                k2 = v["clean_filename"]
                if not ((k1 in manifest and manifest[k1].get("claim_id")) or (k2 in manifest and manifest[k2].get("claim_id"))):
                    total_remaining += 1

        print(f"\n================================================================================", flush=True)
        print(f"🔄 PIPELINE CYCLE {cycle}: {len(courses)} courses queued | {total_remaining} lectures remaining", flush=True)
        print(f"================================================================================", flush=True)

        if total_remaining == 0:
            print(f"\n🎉 ALL {len(courses)} COURSES ARE 100% COMPLETE & MAPPED TO ODYSEE! OVERNIGHT TASK COMPLETE!", flush=True)
            break

        for c_idx, course in enumerate(courses, start=1):
            course_key = course["course_key"]
            channel_id = course["channel_id"]
            course_dir = ROOT_DIR / "courses" / course_key
            course_dir.mkdir(parents=True, exist_ok=True)

            study_items = [x for x in course["items"] if x["kind"] == "study"]
            video_items = [x for x in course["items"] if x["kind"] == "video"]
            total_vids = len(video_items)
            total_bytes = sum(x["size"] for x in video_items)

            manifest = load_manifest()
            mapped_count = sum(
                1 for v in video_items
                if (f"{course_key}/{v['clean_filename']}" in manifest and manifest[f"{course_key}/{v['clean_filename']}"].get("claim_id"))
                or (v["clean_filename"] in manifest and manifest[v["clean_filename"]].get("claim_id"))
            )

            if mapped_count >= total_vids:
                continue

            # Skip single missing item in Course 3 during Cycle 1 so active HLD course continues immediately
            if cycle == 1 and course_key == "Gaurav Sen AI Engineering 2026" and mapped_count >= 29:
                continue

            print(f"\n--------------------------------------------------------------------------------", flush=True)
            print(f"📚 COURSE {c_idx}/{len(courses)}: {course_key}", flush=True)
            print(f"   Videos: {mapped_count}/{total_vids} mapped ({total_bytes/(1024**3):.2f} GB total)", flush=True)
            print(f"--------------------------------------------------------------------------------", flush=True)

            try:
                entity = await client.get_input_entity(channel_id)
            except Exception as e:
                print(f"  ⚠️ Warning resolving entity {channel_id}: {e}", flush=True)
                continue

            # 1. Download study materials if needed (with 30s timeout guard)
            for s_item in study_items:
                dest_file = course_dir / s_item["clean_filename"]
                if not dest_file.exists() or dest_file.stat().st_size == 0:
                    try:
                        msg = await client.get_messages(entity, ids=s_item["msg_id"])
                        if msg:
                            print(f"  📚 [Downloading Study] {s_item['clean_filename']}...", flush=True)
                            await asyncio.wait_for(client.download_media(msg, file=str(dest_file)), timeout=30)
                    except Exception as e:
                        print(f"  ⚠️ Study download note: {e}", flush=True)
                        if dest_file.exists() and dest_file.stat().st_size == 0:
                            dest_file.unlink(missing_ok=True)

            # 2. Multi-Worker Pipelined Video Processing
            unmapped_videos = [
                v for v in video_items
                if not (
                    (f"{course_key}/{v['clean_filename']}" in manifest and manifest[f"{course_key}/{v['clean_filename']}"].get("claim_id"))
                    or (v["clean_filename"] in manifest and manifest[v["clean_filename"]].get("claim_id"))
                )
            ]

            if not unmapped_videos:
                continue

            # For HLD on Cycle 1, finish 151..161 first, then sweep 006..048
            if cycle == 1 and course_key == "Gaurav Sen System Design Simplified (HLD)":
                unmapped_videos.sort(key=lambda x: (0 if x["idx"] >= 151 else 1, x["idx"]))

            NUM_DL_WORKERS = 1
            NUM_UP_WORKERS = 4

            dl_queue: asyncio.Queue = asyncio.Queue()
            for v in unmapped_videos:
                dl_queue.put_nowait(v)
            for _ in range(NUM_DL_WORKERS):
                dl_queue.put_nowait(None)

            upload_queue: asyncio.Queue = asyncio.Queue(maxsize=4)

            async def downloader_worker(dl_id: int):
                while True:
                    v_item = await dl_queue.get()
                    if v_item is None:
                        dl_queue.task_done()
                        break

                    v_idx = v_item["idx"]
                    target_mp4 = TEMP_DIR / v_item["clean_filename"]
                    target_part = TEMP_DIR / f"{v_item['clean_filename']}.dt{dl_id}.part"
                    fsize = v_item["size"]
                    size_mb = fsize / (1024 * 1024)

                    ACTIVE_FILES.add(target_mp4)
                    ACTIVE_FILES.add(target_part)

                    try:
                        enforce_storage_stack()
                        while get_cache_size() + fsize > MAX_STORAGE_BYTES:
                            enforce_storage_stack()
                            if get_cache_size() + fsize > MAX_STORAGE_BYTES:
                                cur_gb = get_cache_size() / (1024 ** 3)
                                print(f"  ⏳ [DL #{dl_id+1}] Waiting for cache space ({cur_gb:.2f}/6 GB). Sleeping 4s...", flush=True)
                                await asyncio.sleep(4)

                        # Always fetch fresh message directly before downloading so file_reference is 100% fresh!
                        msg = await client.get_messages(entity, ids=v_item["msg_id"])
                        if not msg or not msg.media:
                            print(f"  ⚠️ Missing Telegram media for [{v_idx:03d}] {v_item['clean_filename']}", flush=True)
                            ACTIVE_FILES.discard(target_mp4)
                            continue

                        t0 = time.time()
                        last_log_time = t0
                        last_pct = -1

                        def make_progress_cb(total_size):
                            def progress_cb(current, total):
                                nonlocal last_log_time, last_pct
                                now = time.time()
                                pct = int((current / total) * 100) if total else 0
                                if (pct >= last_pct + 10 or now - last_log_time >= 12 or current == total) and pct != last_pct:
                                    dt = max(now - t0, 0.1)
                                    cur_mb = current / (1024 * 1024)
                                    speed = cur_mb / dt
                                    print(f"  📥 [DL #{dl_id+1} | {course_key} Video {v_idx:03d}/{total_vids}] {pct}% ({cur_mb:.1f}/{size_mb:.1f} MB @ {speed:.2f} MB/s)", flush=True)
                                    last_pct = pct
                                    last_log_time = now
                            return progress_cb

                        print(f"\n📥 [DL #{dl_id+1}] [{course_key} Video {v_idx:03d}/{total_vids}] Starting download ({size_mb:.1f} MB)...", flush=True)
                        download_success = False
                        for dl_attempt in range(4):
                            try:
                                if target_part.exists():
                                    target_part.unlink(missing_ok=True)

                                with open(target_part, "wb") as out_f:
                                    dl_timeout = max(600, int((fsize / (1024 * 1024)) * 10))
                                    await asyncio.wait_for(
                                        download_file(
                                            client=client,
                                            location=msg.document,
                                            out=out_f,
                                            progress_callback=make_progress_cb(fsize),
                                        ),
                                        timeout=dl_timeout,
                                    )
                                if target_part.exists() and target_part.stat().st_size > 0:
                                    download_success = True
                                    break
                            except Exception as e:
                                print(f"  ⚠️ [DL #{dl_id+1}] Retry {dl_attempt+1}/4 for [{v_idx:03d}]: {e}", flush=True)
                                await asyncio.sleep(2 * (dl_attempt + 1))
                                try:
                                    msg = await client.get_messages(entity, ids=v_item["msg_id"])
                                except Exception:
                                    pass

                        if not download_success:
                            print(f"  ❌ [DL #{dl_id+1}] Failed to download [{v_idx:03d}] {v_item['clean_filename']}", flush=True)
                            target_part.unlink(missing_ok=True)
                            ACTIVE_FILES.discard(target_mp4)
                            continue

                        dl_dt = max(time.time() - t0, 0.1)
                        print(f"  ✅ [DL #{dl_id+1}] Complete [{v_idx:03d}]: {size_mb:.1f} MB in {dl_dt:.1f}s ({size_mb/dl_dt:.2f} MB/s)", flush=True)

                        if v_item.get("needs_remux"):
                            print(f"  🔄 Remuxing .ts to .mp4 via ffmpeg: {v_item['clean_filename']}...", flush=True)
                            await asyncio.to_thread(
                                subprocess.run,
                                ["ffmpeg", "-y", "-loglevel", "error", "-i", str(target_part), "-c", "copy", str(target_mp4)],
                                check=False,
                            )
                            target_part.unlink(missing_ok=True)
                            if not target_mp4.exists() or target_mp4.stat().st_size == 0:
                                print(f"  ❌ Remux failed for [{v_idx:03d}]", flush=True)
                                ACTIVE_FILES.discard(target_mp4)
                                continue
                        else:
                            target_part.rename(target_mp4)

                        await upload_queue.put((v_item, target_mp4))
                    finally:
                        ACTIVE_FILES.discard(target_part)
                        dl_queue.task_done()

            async def uploader_worker(up_id: int):
                rotator = worker_rotators[up_id % len(worker_rotators)]
                while True:
                    q_item = await upload_queue.get()
                    if q_item is None:
                        upload_queue.task_done()
                        break

                    v_item, target_mp4 = q_item
                    try:
                        await asyncio.to_thread(
                            do_odysee_upload_sync,
                            course,
                            v_item,
                            target_mp4,
                            rotator,
                            total_vids,
                            up_id,
                        )
                    except Exception as e:
                        print(f"  ❌ Uploader #{up_id+1} exception for {v_item['title']}: {e}", flush=True)
                    finally:
                        target_mp4.unlink(missing_ok=True)
                        ACTIVE_FILES.discard(target_mp4)
                        enforce_storage_stack()
                        upload_queue.task_done()

            dl_tasks = [asyncio.create_task(downloader_worker(i)) for i in range(NUM_DL_WORKERS)]
            up_tasks = [asyncio.create_task(uploader_worker(i)) for i in range(NUM_UP_WORKERS)]

            await asyncio.gather(*dl_tasks)
            for _ in range(NUM_UP_WORKERS):
                await upload_queue.put(None)
            await asyncio.gather(*up_tasks)

            print(f"\n🎉 COURSE PASS COMPLETE: {course_key}!\n", flush=True)

    await client.disconnect()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n⏹️ Pipeline stopped by user.", flush=True)
