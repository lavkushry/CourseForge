import asyncio
import json
from telethon import TelegramClient

API_ID = 20562681
API_HASH = "ca29f64923f1a92e106df5c6ca861e6c"
SESSION = "/tmp/search_ansible"
CID = -1002464939631

async def main():
    async with TelegramClient(SESSION, API_ID, API_HASH) as client:
        entity = await client.get_entity(CID)
        print(f"Connected to {getattr(entity, 'title', CID)}!")
        
        all_videos = []
        all_docs = []
        all_texts = []
        
        async for msg in client.iter_messages(entity, reverse=True):
            fn = getattr(msg.file, 'name', None) if msg.file else None
            sz = getattr(msg.file, 'size', None) if msg.file else None
            txt = (msg.text or "").strip()
            
            is_vid = bool(msg.video or (msg.document and fn and fn.endswith(('.mp4', '.mkv', '.webm'))))
            is_doc = bool(msg.document and not is_vid)
            
            item = {
                "id": msg.id,
                "file_name": fn,
                "size_mb": round(sz / (1024*1024), 2) if sz else 0,
                "text": txt[:100],
                "reply_to": getattr(msg, "reply_to_msg_id", None)
            }
            if is_vid:
                all_videos.append(item)
            elif is_doc:
                all_docs.append(item)
            elif txt:
                all_texts.append(item)
                
        print(f"Total videos: {len(all_videos)}")
        print(f"Total docs:   {len(all_docs)}")
        print(f"Total texts:  {len(all_texts)}")
        
        # Save complete dump to json
        with open("/tmp/adb_channel_dump.json", "w") as f:
            json.dump({"videos": all_videos, "docs": all_docs, "texts": all_texts}, f, indent=2)
            
        print("\n--- FIRST 15 VIDEOS ---")
        for v in all_videos[:15]:
            print(f"Msg {v['id']:4d}: {v['size_mb']:6.1f}MB | {v['file_name']} | {v['text']}")
            
        print("\n--- LAST 20 VIDEOS ---")
        for v in all_videos[-20:]:
            print(f"Msg {v['id']:4d}: {v['size_mb']:6.1f}MB | {v['file_name']} | {v['text']}")
            
        print("\n--- ALL DOCS ---")
        for d in all_docs:
            print(f"Msg {d['id']:4d}: {d['size_mb']:6.1f}MB | {d['file_name']}")

if __name__ == "__main__":
    asyncio.run(main())
