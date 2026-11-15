import json

with open("/tmp/adb_channel_dump.json") as f:
    data = json.load(f)

# Combine videos, docs, texts
all_items = []
for k in ["videos", "docs", "texts"]:
    for x in data.get(k, []):
        x["kind"] = k
        all_items.append(x)

all_items.sort(key=lambda x: x["id"])

print("--- Inspecting msgs 3125 to 3250 ---")
for x in all_items:
    if 3125 <= x["id"] <= 3250:
        fn = x.get("file_name") or ""
        txt = (x.get("text") or "").replace("\n", " ")
        sz = x.get("size_mb", 0)
        print(f"Msg {x['id']:4d} [{x['kind'][:3]}]: {sz:5.1f}MB | {fn:40s} | {txt[:60]}")
