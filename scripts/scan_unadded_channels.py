#!/usr/bin/env python3
"""
Scan all Telegram channels in user account, compare against CourseForge,
and list all unadded course channels with full details.
"""
import asyncio
import json
from pathlib import Path
from telethon import TelegramClient

API_ID = 20562681
API_HASH = "ca29f64923f1a92e106df5c6ca861e6c"

ROOT_DIR = Path("/home/ubuntu/CourseForge")
CURRICULA_PATH = ROOT_DIR / "new_5_curricula.json"
OUT_PATH = ROOT_DIR / "unadded_channels_report.json"

added_channels = set()
curricula = json.loads(CURRICULA_PATH.read_text())
for c in curricula:
    cid = c.get("channel_id")
    if cid:
        added_channels.add(int(cid))
        raw_id = int(str(abs(cid)).replace("100", "", 1)) if str(abs(cid)).startswith("100") else abs(cid)
        added_channels.add(raw_id)
        added_channels.add(-abs(cid))

# Also TrendyTech Paid channel
added_channels.add(-1004488964654)
added_channels.add(4488964654)

async def main():
    client = TelegramClient("/tmp/search_tg.session", API_ID, API_HASH)
    await client.connect()
    if not await client.is_user_authorized():
        print("Telegram client not authorized!")
        return

    dialogs = []
    async for d in client.iter_dialogs():
        if d.is_channel or d.is_group:
            dialogs.append(d)

    print(f"Total dialogs (channels + groups): {len(dialogs)}")

    channels_data = []

    for d in dialogs:
        d_id = d.id
        abs_d_id = abs(d_id)
        raw_id = int(str(abs_d_id).replace("100", "", 1)) if str(abs_d_id).startswith("100") else abs_d_id
        is_added = (d_id in added_channels or abs_d_id in added_channels or raw_id in added_channels)

        if is_added:
            continue

        try:
            entity = await client.get_entity(d_id)
            total_vids = 0
            total_docs = 0
            samples = []
            
            async for m in client.iter_messages(entity, limit=25):
                fn = None
                if m.document:
                    for a in m.document.attributes:
                        if hasattr(a, "file_name"):
                            fn = a.file_name
                elif m.video:
                    for a in m.video.attributes:
                        if hasattr(a, "file_name"):
                            fn = a.file_name
                            
                is_v = bool(m.video or (m.document and m.document.mime_type and "video" in m.document.mime_type) or (fn and fn.lower().endswith((".mp4", ".mkv"))))
                if is_v:
                    total_vids += 1
                elif m.document:
                    total_docs += 1
                    
                if len(samples) < 3 and (fn or m.text):
                    clean_text = (fn or m.text.split("\n")[0]).strip()
                    if clean_text:
                        samples.append(clean_text[:60])

            channels_data.append({
                "id": d.id,
                "title": d.title,
                "is_channel": d.is_channel,
                "is_group": d.is_group,
                "vids_sample": total_vids,
                "docs_sample": total_docs,
                "has_media": (total_vids > 0 or total_docs > 0),
                "samples": samples
            })
        except Exception as e:
            channels_data.append({
                "id": d.id,
                "title": d.title,
                "is_channel": d.is_channel,
                "is_group": d.is_group,
                "error": str(e)
            })

    # Sort: channels with videos first, then channels with docs, then rest
    channels_data.sort(key=lambda x: (x.get("vids_sample", 0) * 10 + x.get("docs_sample", 0)), reverse=True)

    with open(OUT_PATH, "w") as f:
        json.dump(channels_data, f, indent=2)

    print(f"\nSaved report to {OUT_PATH}")
    print(f"\n================================================================================")
    print(f"📚 UNADDED COURSE CHANNELS IN YOUR TELEGRAM (Sorted by Video/Doc Content)")
    print(f"================================================================================")
    
    course_like = [c for c in channels_data if c.get("has_media")]
    for i, c in enumerate(course_like, 1):
        print(f"\n[{i:02d}] Title: \"{c['title']}\" (ID: {c['id']})")
        print(f"     Videos in sample: {c['vids_sample']} | Documents in sample: {c['docs_sample']}")
        if c.get("samples"):
            print(f"     Samples: {c['samples']}")

    print(f"\n================================================================================")
    print(f"💬 OTHER CHANNELS / GROUPS (Non-Media / Trading / General Chats)")
    print(f"================================================================================")
    non_course = [c for c in channels_data if not c.get("has_media") and not c.get("error")]
    for i, c in enumerate(non_course, 1):
        print(f"[{i:02d}] \"{c['title']}\" (ID: {c['id']})")

    await client.disconnect()

if __name__ == "__main__":
    asyncio.run(main())
