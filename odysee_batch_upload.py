#!/usr/bin/env python3
"""
Batch-upload all 148 videos in 'Deepak Data Engg' to Odysee (odysee.com)
using Odysee's v4 Asynqueries + TUS API and link their Odysee URLs into CourseForge.
"""
from __future__ import annotations

import argparse
import base64
import json
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

COURSE_DIR = Path("/Users/lavkushkumar/Desktop/Courses/Deepak Data Engg")
MANIFEST_PATH = Path("/Users/lavkushkumar/Desktop/Courses/odysee_manifest.json")

ODYSEE_ASYNQ = "https://api.na-backend.odysee.com/api/v1/asynqueries"
ODYSEE_THUMB = "https://thumbs.odycdn.com/upload"
CHUNK_SIZE = 100 * 1024 * 1024  # 50 MB per TUS chunk (matches Odysee frontend)


def slugify(title: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", title.lower()).strip("-")
    return f"mission-ade-2026-{slug}"[:80].strip("-")


def extract_thumbnail(video_path: Path) -> Path | None:
    tmp = Path(tempfile.mktemp(suffix=".jpg"))
    cmd = [
        "ffmpeg", "-y", "-ss", "00:01:00", "-i", str(video_path),
        "-frames:v", "1", "-vf", "scale=1280:720:force_original_aspect_ratio=decrease",
        "-q:v", "4", str(tmp),
    ]
    res = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if res.returncode == 0 and tmp.exists() and tmp.stat().st_size > 0:
        return tmp
    return None


def upload_thumbnail(thumb_path: Path) -> str:
    res = subprocess.run(
        ["curl", "-sS", "-F", f"file-input=@{thumb_path}", ODYSEE_THUMB],
        capture_output=True, text=True, check=False,
    )
    try:
        data = json.loads(res.stdout)
        return data.get("url") or "https://odysee.com/public/favicon.png"
    except Exception:
        return "https://odysee.com/public/favicon.png"


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


def start_tus_upload(upload_location: str, upload_token: str, video_path: Path) -> str:
    file_size = video_path.stat().st_size
    b64_name = base64.b64encode(video_path.name.encode()).decode()
    b64_type = base64.b64encode(b"video/mp4").decode()

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
        from urllib.parse import urljoin
        tus_url = urljoin(upload_location, tus_url)

    offset = 0
    with video_path.open("rb") as f:
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
            with urllib.request.urlopen(patch_req, timeout=600) as patch_resp:
                offset = int(patch_resp.headers.get("Upload-Offset", offset + len(chunk)))
    print(f"    [TUS 100%] {video_path.name} ({file_size / (1024*1024):.1f} MB uploaded)", flush=True)
    return tus_url


def create_claim_and_wait(
    auth_token: str,
    tus_file_url: str,
    title: str,
    claim_name: str,
    thumb_url: str,
    course_desc: str = "Mission Azure Data Engineer (March 2026) by Deepak Goyal",
    base_tags: list[str] | None = None,
    channel_id: str | None = None,
    unlisted: bool = True,
) -> dict:
    tags = list(base_tags or ["azure-data-engineer", "databricks", "pyspark", "adf"])
    if unlisted:
        tags.append("c:unlisted")

    sdk_params = {
        "name": claim_name,
        "title": title,
        "description": f"{title}\nCourse: {course_desc}",
        "bid": "0.00003",
        "languages": ["en"],
        "tags": tags,
        "thumbnail_url": thumb_url,
        "file_path": tus_file_url,
        "optimize_file": False,
    }
    if channel_id:
        sdk_params["channel_id"] = channel_id

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

    # Poll asynqueries/{query_id} for completion
    for delay in [1, 2, 2, 3, 4, 5, 7, 10, 12, 15]:
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
                if s_json.get("result") and not s_json.get("error"):
                    return s_json["result"]
                if s_json.get("error"):
                    err_obj = s_json["error"]
                    kwargs = (err_obj.get("data") or {}).get("kwargs") if isinstance(err_obj, dict) else None
                    if kwargs and kwargs.get("sd_hash"):
                        retry_params = {k: v for k, v in kwargs.items() if k != "wallet_id"}
                        retry_params["bid"] = "0.0001"
                        for retry_wait in [3, 6, 10, 15]:
                            time.sleep(retry_wait)
                            try:
                                r_req = urllib.request.Request(
                                    "https://api.na-backend.odysee.com/api/v1/proxy?m=stream_create",
                                    data=json.dumps({"jsonrpc": "2.0", "method": "stream_create", "params": retry_params, "id": int(time.time() * 1000)}).encode(),
                                    headers={
                                        "X-Lbry-Auth-Token": auth_token,
                                        "Content-Type": "application/json",
                                        "User-Agent": "Mozilla/5.0",
                                    },
                                )
                                with urllib.request.urlopen(r_req, timeout=60) as r_resp:
                                    r_json = json.loads(r_resp.read().decode())
                                    if r_json.get("result") and not r_json.get("error"):
                                        return r_json["result"]
                            except Exception:
                                pass
                    if "already have a stream claim published under the name" in str(err_obj):
                        try:
                            s_req = urllib.request.Request(
                                "https://api.na-backend.odysee.com/api/v1/proxy?m=claim_search",
                                data=json.dumps({"jsonrpc": "2.0", "method": "claim_search", "params": {"name": claim_name}, "id": int(time.time() * 1000)}).encode(),
                                headers={"X-Lbry-Auth-Token": auth_token, "Content-Type": "application/json", "User-Agent": "Mozilla/5.0"},
                            )
                            with urllib.request.urlopen(s_req, timeout=30) as s_resp:
                                items = json.loads(s_resp.read().decode()).get("result", {}).get("items", [])
                                if items:
                                    return {"outputs": [{"claim_id": items[0]["claim_id"]}]}
                        except Exception:
                            pass
                    raise RuntimeError(f"Odysee SDK error: {err_obj}")
        except urllib.error.HTTPError as e:
            if e.code in (404, 429, 500, 502, 503, 504):
                continue
            raise
    return {"query_id": query_id, "status": "pending"}


COURSE_DIRS = [
    (
        Path("/Users/lavkushkumar/Desktop/Courses/Deepak Data Engg"),
        "mission-ade-2026",
        "Mission Azure Data Engineer (March 2026) by Deepak Goyal",
        ["azure-data-engineer", "databricks", "pyspark", "adf"],
    ),
    (
        Path("/Users/lavkushkumar/Desktop/Courses/Advanced Agentic AI And Gen AI By Prudhvi Sir Nareshit 2026"),
        "agentic-genai-2026",
        "Advanced Agentic AI & Gen AI (2026) by Prudhvi Sir (NareshIT)",
        ["agentic-ai", "generative-ai", "langchain", "langgraph"],
    ),
]


def main() -> None:
    import concurrent.futures
    import threading

    parser = argparse.ArgumentParser(description="Batch-upload course videos to Odysee (10x parallel)")
    parser.add_argument("--token", required=True, help="Odysee auth_token")
    parser.add_argument("--channel-id", default="29a2037dd2bf5e8d3c5eaee36243368fd8410fba", help="Odysee channel claim_id")
    parser.add_argument("--public", action="store_true", help="Publish as public instead of unlisted")
    parser.add_argument("--limit", type=int, default=0, help="Max videos to upload in this run")
    parser.add_argument("--workers", type=int, default=10, help="Concurrent upload workers (default: 10)")
    args = parser.parse_args()

    manifest_lock = threading.Lock()
    manifest: dict[str, dict] = {}
    if MANIFEST_PATH.exists():
        manifest = json.loads(MANIFEST_PATH.read_text())

    course_buckets: list[list[tuple[Path, str, str, list[str]]]] = []
    for c_dir, prefix, desc, base_tags in COURSE_DIRS:
        bucket = []
        if c_dir.exists():
            for p in sorted(c_dir.iterdir()):
                if p.suffix.lower() == ".mp4" and not p.name.startswith("."):
                    bucket.append((p, prefix, desc, base_tags))
        course_buckets.append(bucket)

    all_videos: list[tuple[int, Path, str, str, list[str]]] = []
    idx_counter = 0
    max_len = max((len(b) for b in course_buckets), default=0)
    for i in range(max_len):
        for b in course_buckets:
            if i < len(b):
                idx_counter += 1
                p, prefix, desc, base_tags = b[i]
                all_videos.append((idx_counter, p, prefix, desc, base_tags))

    pending_videos = []
    for item in all_videos:
        idx, video, prefix, course_desc, base_tags = item
        manifest_key = video.name if video.name in manifest else f"{video.parent.name}/{video.name}"
        if video.name in manifest or manifest_key in manifest:
            continue
        pending_videos.append(item)

    if args.limit > 0:
        pending_videos = pending_videos[:args.limit]

    print(
        f"Found {len(all_videos)} total MP4 lectures ({len(manifest)} already uploaded, "
        f"{len(pending_videos)} pending). Launching {args.workers} parallel upload workers..."
    )

    def upload_one(item: tuple[int, Path, str, str, list[str]]) -> bool:
        idx, video, prefix, course_desc, base_tags = item
        manifest_key = f"{video.parent.name}/{video.name}"
        with manifest_lock:
            if video.name in manifest or manifest_key in manifest:
                return False

        title = video.stem
        slug_part = re.sub(r"[^a-zA-Z0-9]+", "-", title.lower()).strip("-")
        claim_name = f"{prefix}-{slug_part}"[:80].strip("-")
        size_mb = video.stat().st_size / (1024 * 1024)
        print(f"[Worker] Starting [{idx}/{len(all_videos)}] ({size_mb:.1f} MB): {video.name}", flush=True)

        thumb_file = extract_thumbnail(video)
        thumb_url = upload_thumbnail(thumb_file) if thumb_file else "https://odysee.com/public/favicon.png"
        if thumb_file and thumb_file.exists():
            thumb_file.unlink()

        try:
            up_token, up_location = request_upload_token(args.token)
            tus_url = start_tus_upload(up_location, up_token, video)
            sdk_res = create_claim_and_wait(
                auth_token=args.token,
                tus_file_url=tus_url,
                title=title,
                claim_name=claim_name,
                thumb_url=thumb_url,
                course_desc=course_desc,
                base_tags=base_tags,
                channel_id=args.channel_id,
                unlisted=not args.public,
            )
            outputs = sdk_res.get("outputs") or [{}]
            claim_id = outputs[0].get("claim_id", "")
            odysee_url = f"https://odysee.com/{claim_name}:{claim_id}" if claim_id else f"https://odysee.com/{claim_name}"
            stream_url = f"https://odysee.com/$/stream/{claim_name}/{claim_id}" if claim_id else ""

            with manifest_lock:
                if MANIFEST_PATH.exists():
                    try:
                        disk_m = json.loads(MANIFEST_PATH.read_text())
                        disk_m.update(manifest)
                        manifest.update(disk_m)
                    except Exception:
                        pass
                manifest[manifest_key] = {
                    "course": video.parent.name,
                    "title": title,
                    "claim_name": claim_name,
                    "claim_id": claim_id,
                    "odysee_url": odysee_url,
                    "stream_url": stream_url,
                    "uploaded_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                }
                manifest_json = json.dumps(manifest, indent=2)
                MANIFEST_PATH.write_text(manifest_json)
                cf_manifest = Path("/Users/lavkushkumar/Downloads/CourseForge/data/odysee_manifest.json")
                if cf_manifest.parent.exists():
                    cf_manifest.write_text(manifest_json)
                total_done = len(manifest)

            subprocess.run(
                [
                    "scp", "-o", "StrictHostKeyChecking=no",
                    "-i", str(Path.home() / ".ssh/ssh-key-2026-08-30.key"),
                    str(MANIFEST_PATH),
                    "ubuntu@141.148.195.233:/home/ubuntu/CourseForge/data/odysee_manifest.json",
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
            print(f"    -> [{total_done}/{len(all_videos)} Done] Published ({video.name}): {odysee_url}", flush=True)
            return True
        except Exception as exc:
            print(f"    [!] Failed on {video.name}: {exc}", file=sys.stderr, flush=True)
            return False

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        list(pool.map(upload_one, pending_videos))

    print(f"\nDone! {len(manifest)}/{len(all_videos)} videos recorded in {MANIFEST_PATH}", flush=True)


if __name__ == "__main__":
    main()
