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
        
        # Check messages from 215 to 900
        print(f"Reading messages in {CID} around DO447...")
        messages = []
        # Let's get messages around 219
        async for msg in client.iter_messages(entity, min_id=210, max_id=900, reverse=True):
            fn = getattr(msg.file, 'name', None) if msg.file else None
            sz = getattr(msg.file, 'size', None) if msg.file else None
            txt = (msg.text or "").replace('\n', ' ')
            is_vid = bool(msg.video or (msg.document and fn and fn.endswith(('.mp4', '.mkv'))))
            is_doc = bool(msg.document and not is_vid)
            messages.append({
                "id": msg.id,
                "file_name": fn,
                "size_mb": round(sz / (1024*1024), 2) if sz else 0,
                "text": txt[:120],
                "is_video": is_vid,
                "is_document": is_doc
            })
            
        print(f"Total retrieved messages: {len(messages)}")
        for m in messages:
            if m["text"] or m["file_name"]:
                v_tag = " [VID]" if m["is_video"] else (" [DOC]" if m["is_document"] else "")
                print(f"Msg {m['id']:4d}{v_tag}: {m['file_name'] or ''} | {m['text'][:80]}")

if __name__ == "__main__":
    asyncio.run(main())
