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
        
        # Messages from 3218 to 3247
        msgs = []
        async for msg in client.iter_messages(entity, min_id=3217, max_id=3248, reverse=True):
            if msg.video or (msg.document and msg.file and msg.file.name and msg.file.name.endswith('.mp4')):
                fn = msg.file.name if msg.file else ""
                sz = msg.file.size if msg.file else 0
                dur = getattr(msg.video, 'duration', 0.0) if msg.video else getattr(msg.file, 'duration', 0.0)
                msgs.append({
                    "id": msg.id,
                    "file_name": fn,
                    "size": sz,
                    "duration": dur or 0.0
                })
        print(f"Retrieved {len(msgs)} messages for Sessions 41-70.")
        for m in msgs:
            print(f"Msg {m['id']}: {m['file_name']} | {m['size']/(1024*1024):.1f}MB | dur={m['duration']}s")
            
        with open("/tmp/adb_sessions_41_70_raw.json", "w") as f:
            json.dump(msgs, f, indent=2)

if __name__ == "__main__":
    asyncio.run(main())
