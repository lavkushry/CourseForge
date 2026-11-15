import json
import re

with open("/tmp/adb_channel_dump.json") as f:
    data = json.load(f)

vids = data.get("videos", [])
session_vids = []
for v in vids:
    fn = v.get("file_name") or ""
    # Look for "Session - <num>" or "Session <num>"
    if re.search(r"session\s*[-_ ]\s*\d+", fn, re.IGNORECASE):
        session_vids.append(v)

print(f"Total session videos found: {len(session_vids)}")
for v in session_vids:
    print(f"Msg {v['id']:4d}: {v['size_mb']:6.1f}MB | {v['file_name']}")
