import asyncio
import json
from telethon import TelegramClient

API_ID = 20562681
API_HASH = "ca29f64923f1a92e106df5c6ca861e6c"
SESSION = "/tmp/search_ansible"
CID = -1002434190660

async def main():
    async with TelegramClient(SESSION, API_ID, API_HASH) as client:
        entity = await client.get_entity(CID)
        
        items = []
        # Range is 835 to 870
        async for msg in client.iter_messages(entity, min_id=834, max_id=871, reverse=True):
            fn = getattr(msg.file, 'name', None) if msg.file else None
            sz = getattr(msg.file, 'size', None) if msg.file else None
            dur = None
            if msg.video:
                dur = getattr(msg.video, 'duration', None)
            elif msg.document:
                dur = getattr(msg.file, 'duration', None)
                
            is_vid = bool(msg.video or (msg.document and fn and fn.endswith(('.mp4', '.mkv', '.webm'))))
            is_doc = bool(msg.document and not is_vid)
            
            items.append({
                "id": msg.id,
                "file_name": fn,
                "file_size": sz,
                "duration": dur,
                "text": msg.text or "",
                "is_video": is_vid,
                "is_document": is_doc
            })
            
        with open("/tmp/ansible_do447_raw.json", "w") as f:
            json.dump(items, f, indent=2)
            
        print(f"Dumped {len(items)} messages for Ansible DO447.")
        for it in items:
            tag = "[VID]" if it["is_video"] else ("[DOC]" if it["is_document"] else "[TXT]")
            sz_mb = f"{it['file_size']/(1024*1024):.1f}MB" if it['file_size'] else ""
            print(f"Msg {it['id']:4d} {tag:5s} {sz_mb:>8s} | fn: {it['file_name']} | txt: {it['text'][:50]}")

if __name__ == "__main__":
    asyncio.run(main())
