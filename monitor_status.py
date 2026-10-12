import json, sqlite3, os, subprocess
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path('/home/ubuntu/CourseForge')
CURRICULA = ROOT / 'new_5_curricula.json'
MANIFEST = ROOT / 'data/odysee_manifest.json'
DB = ROOT / 'data/courseforge.sqlite3'
LOG = ROOT / 'night_monitor.log'

def run():
    now = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')
    
    # 1. Process Check
    res = subprocess.run(['pgrep', '-f', 'linux_pipeline.py'], capture_output=True, text=True)
    pids = res.stdout.strip().split()
    status = f'RUNNING (PID: {", ".join(pids)})' if pids else 'STOPPED'
    
    # 2. Disk Check
    df = subprocess.run(['df', '-h', '/'], capture_output=True, text=True)
    df_line = [l for l in df.stdout.split('\n') if '/dev/' in l]
    disk_info = df_line[0] if df_line else 'Unknown'
    
    # 3. Manifest Progress
    manifest = json.loads(MANIFEST.read_text()) if MANIFEST.exists() else {}
    mapped_total = sum(1 for v in manifest.values() if v.get('claim_id'))
    
    # 4. Curricula Progress
    curricula = json.loads(CURRICULA.read_text()) if CURRICULA.exists() else []
    total_videos = 0
    courses_summary = []
    for c in curricula:
        ck = c['course_key']
        vids = [x for x in c['items'] if x['kind'] == 'video']
        total_videos += len(vids)
        c_mapped = sum(1 for v in vids if (f"{ck}/{v['clean_filename']}" in manifest and manifest[f"{ck}/{v['clean_filename']}"].get('claim_id')) or (v['clean_filename'] in manifest and manifest[v['clean_filename']].get('claim_id')))
        if c_mapped < len(vids):
            courses_summary.append(f"{ck}: {c_mapped}/{len(vids)}")

    # 5. Last Log Entry
    last_log = 'No log'
    if (ROOT / 'linux_pipeline.log').exists():
        tail = subprocess.run(['tail', '-n', '2', str(ROOT / 'linux_pipeline.log')], capture_output=True, text=True)
        last_log = ' | '.join(l.strip() for l in tail.stdout.strip().split('\n') if l.strip())

    entry = f"[{now}] Status: {status} | Claims: {mapped_total}/{total_videos} | Active: {', '.join(courses_summary[:2])} | Disk: {disk_info} | Recent: {last_log}\n"
    with open(LOG, 'a') as f:
        f.write(entry)
    print(entry.strip())

if __name__ == '__main__':
    run()
