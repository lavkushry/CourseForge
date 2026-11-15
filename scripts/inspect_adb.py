import json

with open("/home/ubuntu/CourseForge/new_5_curricula.json") as f:
    d = json.load(f)

for i, c in enumerate(d):
    ck = c.get('course_key')
    ct = c.get('course_title')
    cid = c.get('channel_id')
    print(f"{i:2d}. {ck} | {ct} | Channel: {cid}")
