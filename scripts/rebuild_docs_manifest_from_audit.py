import json

with open('/home/ubuntu/CourseForge/COMPANION_MATERIALS_AUDIT.json', 'r', encoding='utf-8') as f:
    audit = json.load(f)

manifest = {}
valid_claims = 0

for item in audit:
    cid = item['course_id']
    fn = item['filename']
    claim_id = item.get('current_claim_id', '')
    claim_name = item.get('current_claim_name', '')
    lesson_id = item.get('current_lesson_id', '')
    k = f'{cid}/{fn}'
    manifest[k] = {
        'course': cid,
        'name': fn,
        'claim_id': claim_id,
        'claim_name': claim_name,
        'odysee_url': f'https://odysee.com/{claim_name}:{claim_id}',
        'lesson_id': lesson_id
    }
    if claim_id and len(claim_id) == 40:
        valid_claims += 1

print(f'Total manifest items: {len(manifest)}')
print(f'Valid 40-char claim IDs: {valid_claims}')

with open('/home/ubuntu/CourseForge/data/odysee_docs_manifest.json', 'w', encoding='utf-8') as f:
    json.dump(manifest, f, indent=2)

print('Saved /home/ubuntu/CourseForge/data/odysee_docs_manifest.json')
