import asyncio
from telethon import TelegramClient

API_ID = 20562681
API_HASH = "ca29f64923f1a92e106df5c6ca861e6c"
SESSION = "/tmp/search_ansible"

async def main():
    async with TelegramClient(SESSION, API_ID, API_HASH) as client:
        print("Connected to Telegram!")
        
        # 1. First search all dialogs
        print("Scanning dialogs...")
        async for dialog in client.iter_dialogs():
            title = dialog.title or ""
            d_id = dialog.id
            t_low = title.lower()
            if any(k in t_low for k in ["ansible", "do447", "vimal", "tower", "redhat", "red hat"]):
                print(f"Found dialog: {title} (ID: {d_id})")
        
        # 2. Check Vimal Daga channel -1003153374736 specifically
        vimal_cid = -1003153374736
        print(f"\nChecking messages in Vimal Daga Courses channel ({vimal_cid})...")
        try:
            entity = await client.get_entity(vimal_cid)
            count = 0
            matches = []
            async for msg in client.iter_messages(entity):
                count += 1
                txt = (msg.text or "").lower()
                fn = msg.file.name.lower() if msg.file and msg.file.name else ""
                if any(k in txt or k in fn for k in ["ansible", "do447", "tower"]):
                    m_text = (msg.text or "")[:100].replace("\n", " ")
                    matches.append((msg.id, msg.file.name if msg.file else None, m_text))
            print(f"Total messages in Vimal Daga channel: {count}. Matches: {len(matches)}")
            for mid, fn, t in matches[:25]:
                print(f"  Msg {mid}: file={fn} text={t}")
        except Exception as e:
            print(f"Error inspecting Vimal channel: {e}")

        # 3. Global message search across all chats for "DO447"
        print("\nSearching globally for 'DO447'...")
        try:
            async for msg in client.iter_messages(None, search="DO447", limit=30):
                chat = await msg.get_chat()
                chat_title = getattr(chat, "title", str(msg.chat_id))
                m_fn = getattr(msg.file, "name", None) if msg.file else None
                m_text = (msg.text or "")[:80].replace("\n", " ")
                print(f"  [DO447] In '{chat_title}' ({msg.chat_id}) Msg {msg.id}: file={m_fn} text={m_text}")
        except Exception as e:
            print(f"Error global search DO447: {e}")

        # 4. Global message search across all chats for "Ansible"
        print("\nSearching globally for 'Ansible'...")
        try:
            async for msg in client.iter_messages(None, search="Ansible", limit=30):
                chat = await msg.get_chat()
                chat_title = getattr(chat, "title", str(msg.chat_id))
                m_fn = getattr(msg.file, "name", None) if msg.file else None
                m_text = (msg.text or "")[:80].replace("\n", " ")
                print(f"  [Ansible] In '{chat_title}' ({msg.chat_id}) Msg {msg.id}: file={m_fn} text={m_text}")
        except Exception as e:
            print(f"Error global search Ansible: {e}")

if __name__ == "__main__":
    asyncio.run(main())
