import json

with open("/tmp/adb_channel_dump.json") as f:
    data = json.load(f)

texts = data.get("texts", [])
print(f"Total text messages: {len(texts)}")
for t in texts:
    txt = t.get("text", "")
    if any(k in txt.lower() for k in ["databricks", "sameer", "session - 4", "session - 5", "session - 6", "session - 7", "adb"]):
        print(f"Msg {t['id']}: {txt[:120]}")
