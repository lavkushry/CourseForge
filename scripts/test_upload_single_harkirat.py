import sys, os, time, json
from pathlib import Path

ROOT_DIR = Path('/home/ubuntu/CourseForge')
sys.path.insert(0, str(ROOT_DIR))

import psycopg2
import sqlite3
import odysee_batch_upload as obu

CURRICULA_PATH = ROOT_DIR / 'new_5_curricula.json'
MANIFEST_PATH = ROOT_DIR / 'data/odysee_manifest.json'
COURSE_KEY = 'Harkirat Singh Super 30 Courses'

with open(CURRICULA_PATH) as f:
    curricula = json.load(f)
course = [x for x in curricula if x.get('course_key') == COURSE_KEY][0]

d = ROOT_DIR / 'courses' / COURSE_KEY
target_item = None
target_file = None
for item in course['items']:
    prefix = f"[{item['idx']:03d}]"
    matches = [f for f in os.listdir(d) if f.startswith(prefix) and f.endswith('.mp4')]
    if matches:
        target_item = item
        target_file = d / matches[0]
        break

if not target_item or not target_file:
    print('No pending local file found!')
    sys.exit(0)

print(f'Testing upload for: {target_file.name} ({target_file.stat().st_size / (1024**2):.1f} MB)')

token = '3Nj7vMUEayo8PLWgYTLMfpbcbtSzVj9f'
channel_id = '29a2037dd2bf5e8d3c5eaee36243368fd8410fba'

print('Requesting upload token...')
up_token, up_location = obu.request_upload_token(token)
print('Starting TUS upload...')
tus_url = obu.start_tus_upload(up_location, up_token, target_file)
print('Publishing claim on Odysee...')
claim_name = target_item['claim_name']
title = target_item['title']

thumb_file = obu.extract_thumbnail(target_file)
thumb_url = obu.upload_thumbnail(thumb_file) if thumb_file else 'https://odysee.com/public/favicon.png'
if thumb_file and thumb_file.exists():
    thumb_file.unlink(missing_ok=True)

res = obu.create_claim_and_wait(
    auth_token=token,
    tus_file_url=tus_url,
    title=title,
    claim_name=claim_name,
    thumb_url=thumb_url,
    course_desc=course['description'][:240],
    base_tags=['harkirat-singh', 'super-30', 'courseforge'],
    channel_id=channel_id,
    unlisted=True,
)

outputs = res.get('outputs') or [{}]
claim_id = outputs[0].get('claim_id', '')
if not claim_id:
    existing = obu.check_claim_exists(claim_name)
    if existing and existing.get('claim_id'):
        claim_id = existing['claim_id']

print(f'✅ Minted Claim ID: {claim_id} for {claim_name}')

pg_conn = psycopg2.connect('postgresql://courseforge:local_rewrite_only@127.0.0.1:15439/courseforge_rewrite')
cur = pg_conn.cursor()
cur.execute('''
    INSERT INTO lesson_providers (lesson_id, claim_name, claim_id, updated_at)
    VALUES (%s, %s, %s, NOW())
    ON CONFLICT (lesson_id) DO UPDATE SET claim_name = excluded.claim_name, claim_id = excluded.claim_id, updated_at = NOW();
''', (target_item['video_id'], claim_name, claim_id))
cur.execute('UPDATE lessons SET status = %s WHERE id = %s;', ('done', target_item['video_id']))
pg_conn.commit()
pg_conn.close()
print('✅ Recorded in PostgreSQL lesson_providers & marked done.')

with open(MANIFEST_PATH) as f:
    manifest = json.load(f)
manifest[f"{COURSE_KEY}/{target_item['clean_filename']}"] = {
    'video_id': target_item['video_id'],
    'course': COURSE_KEY,
    'title': title,
    'claim_name': claim_name,
    'claim_id': claim_id,
    'odysee_url': f'https://odysee.com/{claim_name}:{claim_id}',
    'stream_url': f'https://odysee.com/$/stream/{claim_name}/{claim_id}',
    'uploaded_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
}
with open(MANIFEST_PATH, 'w') as f:
    json.dump(manifest, f, indent=2)
print('✅ Recorded in odysee_manifest.json')

target_file.unlink()
print(f'🗑️ Deleted {target_file.name} to free disk space!')
