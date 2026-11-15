import json

with open("/home/ubuntu/CourseForge/new_5_curricula.json") as f:
    d = json.load(f)

adb = d[16]
items = adb.get("items", [])
print(f"Total items in ADB: {len(items)}")
for it in items[:5]:
    print(f"  [{it.get('telegram_msg_id')}] {it.get('title')} (file: {it.get('file_name')})")
if len(items) > 5:
    print("  ...")
    for it in items[-5:]:
        print(f"  [{it.get('telegram_msg_id')}] {it.get('title')} (file: {it.get('file_name')})")
