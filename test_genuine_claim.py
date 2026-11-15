import json, urllib.request, time, sys
from pathlib import Path

# Load manifest and catalog
with open('/home/ubuntu/CourseForge/COMPANION_MATERIALS_AUDIT.json') as f:
    catalog = json.load(f)

# Find an item
item = catalog[150]
print('Testing on item:', item['course_id'], item['filename'])
file_path = Path(item['server_path'])
print('File exists:', file_path.exists(), file_path.stat().st_size)

# Import upload functions
sys.path.insert(0, '/home/ubuntu/CourseForge/scripts')
import fast_upload_companion_materials as uploader

# Use Worker 1
token = '5hgCwtn2GCcunCpPg7z8fuUgYV5frxBF'
channel_id = '027d08f9b8aa21f9530fd44cc6d7f7de4aa57dce'
claim_name = uploader.make_claim_name(item['course_id'], item['filename'])
print('Claim name:', claim_name)

up_token, up_loc = uploader.request_upload_token(token)
print('Got upload token, uploading TUS...')
tus_url = uploader.start_tus_upload(up_loc, up_token, file_path)
print('TUS URL:', tus_url)

# Now call stream_create directly via asynq
sdk_params = {
    'name': claim_name,
    'title': item['filename'],
    'description': f"Study Material: {item['filename']}",
    'bid': '0.00001',
    'languages': ['en'],
    'tags': ['study-material', 'courseforge', 'c:unlisted'],
    'thumbnail_url': 'https://odysee.com/public/favicon.png',
    'file_path': tus_url,
    'optimize_file': False,
    'channel_id': channel_id,
}
body = json.dumps({
    'jsonrpc': '2.0',
    'method': 'stream_create',
    'params': sdk_params,
    'id': int(time.time() * 1000),
}).encode()

req = urllib.request.Request(
    'https://api.na-backend.odysee.com/api/v1/asynqueries/',
    data=body,
    method='POST',
    headers={'X-Lbry-Auth-Token': token, 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0'}
)
with urllib.request.urlopen(req, timeout=60) as resp:
    data = json.loads(resp.read().decode())
query_id = (data.get('payload') or {}).get('query_id')
print('Query ID:', query_id)

for delay in [3, 4, 5, 6, 8, 10]:
    time.sleep(delay)
    s_req = urllib.request.Request(
        f'https://api.na-backend.odysee.com/api/v1/asynqueries/{query_id}',
        headers={'X-Lbry-Auth-Token': token, 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0'}
    )
    with urllib.request.urlopen(s_req, timeout=30) as s_resp:
        if s_resp.status == 204:
            print('Still processing (204)...')
            continue
        res = json.loads(s_resp.read().decode())
        print('ASYNQ RESULT:', json.dumps(res, indent=2))
        break
