#!/usr/bin/env python3
import asyncio
import json
import os
from pathlib import Path
from telethon import TelegramClient

API_ID = 20562681
API_HASH = "ca29f64923f1a92e106df5c6ca861e6c"
SESSION = "/tmp/search_tg"

OUT_DIR = Path("/home/ubuntu/CourseForge/raw_channels_dump")
OUT_DIR.mkdir(parents=True, exist_ok=True)

CHANNELS = [
    (-1002566904022, "sanket_elite_raw.json", "Sanket Elite 1.0"),
    (-1002317626548, "campusx_dsmp_raw.json", "Campus X DSMP"),
    (-1004370336974, "sheryians_backend_domination_raw.json", "Backend Domination (Sheryians)"),
    (-1003735327002, "campusx_cv_raw.json", "Campus X Deep Learning for Computer Vision"),
    (-1003748100987, "campusx_powerbi_raw.json", "Campus X Power BI Course"),
    (-1002456584373, "genai_gemini_pro_raw.json", "Building Gen AI Apps with Gemini Pro"),
    (-1003905357069, "scaler_system_design_raw.json", "System Design (LLD & HLD) Scaler"),
    (-1002266558566, "core_java_java8_raw.json", "Core Java & Java 8+ Deep Dive"),
    (-1002471107601, "dsa_java_team_spy_raw.json", "DSA in Java Masterclass Team SPY"),
]

async def dump_channel(client, cid, filename, label):
    out_file = OUT_DIR / filename
    print(f"⏳ Starting dump for {label} ({cid})...")
    try:
        entity = await client.get_entity(cid)
    except Exception as e:
        print(f"❌ Failed to get entity for {label} ({cid}): {e}")
        return

    items = []
    async for msg in client.iter_messages(entity, reverse=True):
        fn = None
        fs = None
        dur = None
        mime = None
        is_vid = False
        is_doc = False

        if msg.video:
            is_vid = True
            fs = msg.file.size if msg.file else None
            dur = getattr(msg.video, "duration", None)
            mime = getattr(msg.video, "mime_type", None)
            fn = msg.file.name if msg.file else None
        elif msg.document:
            fn = msg.file.name if msg.file else None
            fs = msg.file.size if msg.file else None
            mime = getattr(msg.document, "mime_type", "")
            ext = os.path.splitext(fn or "")[1].lower()
            if ext in (".mp4", ".mkv", ".ts", ".webm", ".m4v", ".mov") or (mime and "video/" in mime):
                is_vid = True
                dur = getattr(msg.file, "duration", None)
            else:
                is_doc = True

        items.append({
            "id": msg.id,
            "date": msg.date.isoformat() if msg.date else "",
            "text": msg.text or "",
            "file_name": fn,
            "file_size": fs,
            "duration": dur,
            "mime_type": mime,
            "is_video": is_vid,
            "is_document": is_doc,
        })

    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(items, f, indent=2)

    vids = sum(1 for x in items if x["is_video"])
    docs = sum(1 for x in items if x["is_document"])
    print(f"✅ Successfully dumped {label}: {len(items)} messages (vids: {vids}, docs: {docs}) -> {out_file}")

async def main():
    async with TelegramClient(SESSION, API_ID, API_HASH) as client:
        for cid, fn, lbl in CHANNELS:
            await dump_channel(client, cid, fn, lbl)

if __name__ == "__main__":
    asyncio.run(main())
