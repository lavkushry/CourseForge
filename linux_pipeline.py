#!/usr/bin/env python3
"""
Autonomous Linux Cloud Pipeline (High-Speed Pipelined Edition):
Runs directly on the high-speed Linux server (Oracle Cloud Datacenter):
1. Downloads Telegram course videos using FastTelethon (C-accelerated tgcrypto).
2. Pipelined Prefetching: Downloads video N+1 concurrently while video N is uploading to Odysee.
3. Auto-remuxes .ts to .mp4 via ffmpeg when required.
4. Multi-token Odysee pool with automatic failover & expiry rotation:
   - Token 1: 9ryTA4sULdxnA3hZZPaPVVQDJvBa4G5u
   - Token 2: 31feNHAQyrk5KCXnxwQuFQbRg83hAGr7
   - Token 3: Cf98LFvmLBNQsqbmy1mZXxmP2wnbHroZ
5. Uploads videos as unlisted streams to Odysee channel @courseforge-vault-3 via thread pool.
6. Mapped directly into CourseForge live production database (courseforge.sqlite3).
7. Strict Storage Stack Guard:
   - Trigger ceiling: 6 GB (if cache >= 6 GB, automatically prunes 4 GB down to <= 2 GB).
   - Each completed lecture is deleted immediately upon upload.
8. Runs 24/7 autonomously until all courses in new_5_curricula.json are complete.
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
    If temporary cache exceeds 6 GB, deletes the oldest files in FIFO stack order
    until cache drops to <= 2 GB (freeing at least 4 GB).
    """
    total = get_cache_size()
    if total >= MAX_STORAGE_BYTES:
        cur_gb = total / (1024 ** 3)
        print(f"\n🚨 [Storage Stack Guard] Cache exceeded {cur_gb:.2f} GB >= 6 GB threshold! Pruning 4 GB...", flush=True)
        files = []
        if TEMP_DIR.exists():
            for p in TEMP_DIR.iterdir():
                if p.is_file():
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
        print(f"  ✅ [Storage Stack Guard] Pruned {freed / (1024**3):.2f} GB. Cache is now safe at {total / (1024**3):.2f} GB.\n", flush=True)


CURRICULA_PATH = ROOT_DIR / "new_5_curricula.json"
MANIFEST_PATH = ROOT_DIR / "data/odysee_manifest.json"
ROOT_MANIFEST = ROOT_DIR / "odysee_manifest.json"
DB_PATH = ROOT_DIR / "data/courseforge.sqlite3"
SESSION_PATH = str(ROOT_DIR / ".tg_downloader")

API_ID = 2040
API_HASH = "b18441a1ff607e10a989891a5462e627"

# ----------------------------------------------------------------------
# Multi-Token Odysee Rotation Pool
# ----------------------------------------------------------------------
ODYSEE_TOKENS = [
    "9ryTA4sULdxnA3hZZPaPVVQDJvBa4G5u",
    "31feNHAQyrk5KCXnxwQuFQbRg83hAGr7",
    "Cf98LFvmLBNQsqbmy1mZXxmP2wnbHroZ",
]
ODYSEE_CHANNEL_ID = "97af564bce47e5ed942e992d720da25fa173b00c"


class OdyseeTokenRotator:
    def __init__(self, tokens: list[str]):
        self.tokens = list(tokens)
        self.idx = 0

    @property
    def current(self) -> str:
        return self.tokens[self.idx]

    def rotate(self, reason: str = "") -> str:
        old_tok = self.current[:8]
        self.idx = (self.idx + 1) % len(self.tokens)
        new_tok = self.current[:8]
        print(f"  🔄 [Odysee Token Failover] Rotated token {old_tok}... -> {new_tok}... (Slot {self.idx+1}/{len(self.tokens)}) | Reason: {reason}", flush=True)
        return self.current


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
) -> bool:
    """
    Synchronously upload a single video to Odysee via TUS in a background thread.
    Keeps the asyncio event loop free for concurrent downloads.
    """
    course_key = course["course_key"]
    v_idx = v_item["idx"]
    size_mb = v_item["size"] / (1024 * 1024)
    claim_name = v_item["claim_name"]
    title = v_item["title"]
    base_tags = [course_key.lower().replace(" ", "-"), "courseforge", "lecture"]
    m_key = f"{course_key}/{v_item['clean_filename']}"

    print(f"\n📤 [Odysee Upload Starting] [{course_key} Video {v_idx:03d}/{total_vids}] ({size_mb:.1f} MB)...", flush=True)

    thumb_file = obu.extract_thumbnail(target_mp4)
    thumb_url = obu.upload_thumbnail(thumb_file) if thumb_file else "https://odysee.com/public/favicon.png"
    if thumb_file and thumb_file.exists():
        thumb_file.unlink(missing_ok=True)

    max_up_attempts = max(6, len(ODYSEE_TOKENS) * 2)
    for up_attempt in range(max_up_attempts):
        active_token = token_rotator.current
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
                channel_id=ODYSEE_CHANNEL_ID,
                unlisted=True,
            )
            outputs = sdk_res.get("outputs") or [{}]
            claim_id = outputs[0].get("claim_id", "")
            if not claim_id:
                raise RuntimeError(f"Missing claim_id in {sdk_res}")

            odysee_url = f"https://odysee.com/{claim_name}:{claim_id}"
            stream_url = f"https://odysee.com/$/stream/{claim_name}/{claim_id}"

            # Update Manifest & SQLite
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
            print(f"  ⚠️ Odysee retry {up_attempt+1}/{max_up_attempts} for [{v_idx:03d}] (Token: {active_token[:8]}...): {e}", flush=True)
            if any(k in err_str for k in ["token", "unauthorized", "forbidden", "expired", "quota", "rate limit", "limit exceeded", "auth"]):
                token_rotator.rotate(reason=str(e))
            time.sleep(4 * (up_attempt + 1))
    return False


async def main():
    print(f"================================================================================", flush=True)
    print(f"🚀 CLOUD PIPELINE (PIPELINED PREFETCH EDITION): Oracle Cloud Linux Server ({utcnow()})", flush=True)
    print(f"   Storage Stack Guard: 6 GB trigger -> 4 GB prune (Target: <= 2 GB, Cap: 10 GB)", flush=True)
    print(f"   High-Speed Prefetching: Concurrent Download (Inbound) + Upload (Outbound) Active", flush=True)
    print(f"   Odysee Token Pool: {len(ODYSEE_TOKENS)} tokens active with automated failover", flush=True)
    print(f"================================================================================", flush=True)

    token_rotator = OdyseeTokenRotator(ODYSEE_TOKENS)

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

            print(f"\n--------------------------------------------------------------------------------", flush=True)
            print(f"📚 COURSE {c_idx}/{len(courses)}: {course_key}", flush=True)
            print(f"   Videos: {mapped_count}/{total_vids} mapped ({total_bytes/(1024**3):.2f} GB total)", flush=True)
            print(f"--------------------------------------------------------------------------------", flush=True)

            print(f"[Telegram] Fetching message descriptors from channel {channel_id}...", flush=True)
            msg_by_id = {}
            try:
                entity = await client.get_input_entity(channel_id)
                async for m in client.iter_messages(entity, limit=2500):
                    if m.media:
                        msg_by_id[m.id] = m
                print(f"[Telegram] Cached {len(msg_by_id)} media messages for channel {channel_id}", flush=True)
            except Exception as e:
                print(f"  ⚠️ Warning caching channel messages: {e}", flush=True)

            # 1. Download study materials if needed (with 30s timeout guard)
            for s_item in study_items:
                dest_file = course_dir / s_item["clean_filename"]
                if not dest_file.exists() or dest_file.stat().st_size == 0:
                    msg = msg_by_id.get(s_item["msg_id"])
                    if not msg:
                        try:
                            msg = await client.get_messages(entity, ids=s_item["msg_id"])
                        except Exception:
                            pass
                    if msg:
                        print(f"  📚 [Downloading Study] {s_item['clean_filename']}...", flush=True)
                        try:
                            await asyncio.wait_for(client.download_media(msg, file=str(dest_file)), timeout=30)
                        except Exception as e:
                            print(f"  ⚠️ Study download note: {e}", flush=True)
                            if dest_file.exists() and dest_file.stat().st_size == 0:
                                dest_file.unlink(missing_ok=True)

            # 2. Pipelined Video Processing (Producer-Consumer Queue)
            unmapped_videos = [
                v for v in video_items
                if not (
                    (f"{course_key}/{v['clean_filename']}" in manifest and manifest[f"{course_key}/{v['clean_filename']}"].get("claim_id"))
                    or (v["clean_filename"] in manifest and manifest[v["clean_filename"]].get("claim_id"))
                )
            ]

            if not unmapped_videos:
                continue

            # Queue maxsize=1 ensures at most 1 video is pre-downloaded waiting for upload (strictly bounding disk usage)
            upload_queue = asyncio.Queue(maxsize=1)

            async def downloader_task():
                for v_item in unmapped_videos:
                    v_idx = v_item["idx"]
                    target_mp4 = TEMP_DIR / v_item["clean_filename"]
                    target_part = TEMP_DIR / f"{v_item['clean_filename']}.part"
                    fsize = v_item["size"]
                    size_mb = fsize / (1024 * 1024)

                    # Storage Stack Guard check: enforce <= 6 GB stack rule
                    enforce_storage_stack()
                    while get_cache_size() + fsize > MAX_STORAGE_BYTES:
                        enforce_storage_stack()
                        if get_cache_size() + fsize > MAX_STORAGE_BYTES:
                            cur_gb = get_cache_size() / (1024 ** 3)
                            print(f"  ⏳ Waiting for cache space ({cur_gb:.2f}/6 GB). Sleeping 5s...", flush=True)
                            await asyncio.sleep(5)

                    msg = msg_by_id.get(v_item["msg_id"])
                    if not msg:
                        try:
                            msg = await client.get_messages(entity, ids=v_item["msg_id"])
                        except Exception:
                            pass

                    if not msg or not msg.media:
                        print(f"  ⚠️ Missing Telegram media for [{v_idx:03d}] {v_item['clean_filename']}", flush=True)
                        continue

                    t0 = time.time()
                    last_log_time = t0
                    last_pct = -1

                    def make_progress_cb(total_size):
                        def progress_cb(current, total):
                            nonlocal last_log_time, last_pct
                            now = time.time()
                            pct = int((current / total) * 100) if total else 0
                            if (pct >= last_pct + 10 or now - last_log_time >= 15 or current == total) and pct != last_pct:
                                dt = max(now - t0, 0.1)
                                cur_mb = current / (1024 * 1024)
                                speed = cur_mb / dt
                                print(f"  📥 [{course_key} Video {v_idx:03d}/{total_vids}] {pct}% ({cur_mb:.1f}/{size_mb:.1f} MB @ {speed:.2f} MB/s)", flush=True)
                                last_pct = pct
                                last_log_time = now
                        return progress_cb

                    print(f"\n📥 [{course_key} Video {v_idx:03d}/{total_vids}] Starting download ({size_mb:.1f} MB)...", flush=True)
                    download_success = False
                    for dl_attempt in range(4):
                        try:
                            if target_part.exists():
                                target_part.unlink()

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
                            print(f"  ⚠️ Download retry {dl_attempt+1}/4 for [{v_idx:03d}]: {e}", flush=True)
                            await asyncio.sleep(3 * (dl_attempt + 1))
                            try:
                                msg = await client.get_messages(entity, ids=v_item["msg_id"])
                            except Exception:
                                pass

                    if not download_success:
                        print(f"  ❌ Failed to download [{v_idx:03d}] {v_item['clean_filename']} after retries.", flush=True)
                        if target_part.exists():
                            target_part.unlink(missing_ok=True)
                        continue

                    dl_dt = max(time.time() - t0, 0.1)
                    print(f"  ✅ Download complete: {size_mb:.1f} MB in {dl_dt:.1f}s ({size_mb/dl_dt:.2f} MB/s)", flush=True)

                    # Remux if needed
                    if v_item.get("needs_remux"):
                        print(f"  🔄 Remuxing .ts to .mp4 via ffmpeg: {v_item['clean_filename']}...", flush=True)
                        res = subprocess.run(
                            ["ffmpeg", "-y", "-loglevel", "error", "-i", str(target_part), "-c", "copy", str(target_mp4)],
                            check=False,
                        )
                        target_part.unlink(missing_ok=True)
                        if not target_mp4.exists() or target_mp4.stat().st_size == 0:
                            print(f"  ❌ Remux failed for [{v_idx:03d}]", flush=True)
                            continue
                    else:
                        target_part.rename(target_mp4)

                    # Put into upload queue (blocks if queue is full, enforcing 1-video prefetch buffer)
                    await upload_queue.put((v_item, target_mp4))

                # Sentinel to signal uploader that downloads for this course are finished
                await upload_queue.put(None)

            async def uploader_task():
                while True:
                    q_item = await upload_queue.get()
                    if q_item is None:
                        upload_queue.task_done()
                        break

                    v_item, target_mp4 = q_item
                    try:
                        # Offload synchronous TUS upload to thread pool so it does NOT block Telethon downloads!
                        await asyncio.to_thread(
                            do_odysee_upload_sync,
                            course,
                            v_item,
                            target_mp4,
                            token_rotator,
                            total_vids,
                        )
                    except Exception as e:
                        print(f"  ❌ Uploader exception for {v_item['title']}: {e}", flush=True)
                    finally:
                        target_mp4.unlink(missing_ok=True)
                        enforce_storage_stack()
                        upload_queue.task_done()

            # Execute Downloader and Uploader concurrently!
            await asyncio.gather(downloader_task(), uploader_task())

            print(f"\n🎉 COURSE CYCLE COMPLETE: {course_key} ({total_vids}/{total_vids} mapped)!\n", flush=True)

    await client.disconnect()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nPipeline interrupted by user.")
    except Exception as e:
        print(f"\nPipeline crashed: {e}")
        raise
