#!/usr/bin/env python3
"""Exercise concurrent learning sessions against an isolated copy of the real library."""
import argparse
import asyncio
import hashlib
import json
import os
from pathlib import Path
import secrets
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone, timedelta

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.config import settings
import httpx


async def exercise(base, sessions, video_id, rounds):
    durations = []
    failures = []
    async with httpx.AsyncClient(base_url=base, timeout=30, limits=httpx.Limits(max_connections=len(sessions))) as client:
        async def request(method, url, token, csrf, expected=200, **kwargs):
            started = time.monotonic()
            try:
                result = await client.request(method, url, headers={'Cookie': 'cf_session='+token, 'X-CSRF-Token': csrf}, **kwargs)
            except httpx.HTTPError as exc:
                durations.append(time.monotonic()-started)
                failures.append({'endpoint':url,'reason':type(exc).__name__})
                return {}
            durations.append(time.monotonic()-started)
            if result.status_code != expected:
                failures.append({'endpoint':url,'expected':expected,'status':result.status_code})
                return {}
            return result.json()

        async def learner(index, token, csrf):
            opened = await request('POST', f'/api/videos/{video_id}/activity-session', token, csrf, 201, json={})
            if not opened.get('id'):return
            for sequence in range(1, rounds+1):
                if not (await request('GET', '/api/videos', token, csrf)).get('videos'):return
                await request('GET', '/api/progress', token, csrf)
                await request('GET', '/api/me/learning', token, csrf)
                if opened.get('id'):
                    await request('POST', '/api/activity/'+opened['id']+'/heartbeat', token, csrf,
                                  json={'sequence':sequence,'visible':True,'elapsed_seconds':1})
            await request('POST', f'/api/videos/{video_id}/notes', token, csrf, 201,
                          json={'content':f'Capacity check account {index}', 'position':0})
            notes = await request('GET', f'/api/videos/{video_id}/notes', token, csrf)
            if notes.get('notes') and any(n['content'] != f'Capacity check account {index}' for n in notes['notes']):
                failures.append({'endpoint':'notes','reason':'ownership mismatch'})
            await request('GET', '/api/admin/overview', token, csrf, 403)

        started = time.monotonic()
        await asyncio.gather(*(learner(i, *s) for i,s in enumerate(sessions)))
        elapsed = time.monotonic()-started
    ordered = sorted(durations)
    return {'concurrent_sessions':len(sessions),'requests':len(durations),'failures':failures,
            'elapsed_seconds':round(elapsed,2),'requests_per_second':round(len(durations)/elapsed,2),
            'p95_seconds':round(ordered[int(.95*(len(ordered)-1))],3),
            'scope':'Authenticated API browsing, bounded activity and private notes; excludes login bursts, CDN video delivery and AI/grading throughput'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--users',type=int,default=150)
    parser.add_argument('--rounds',type=int,default=2)
    args = parser.parse_args()
    if not 1 <= args.users <= 500 or not 1 <= args.rounds <= 10:
        raise SystemExit('Use 1–500 sessions and 1–10 rounds')
    with tempfile.TemporaryDirectory(prefix='courseforge-capacity-') as directory:
        root = Path(directory);data = root/'data';data.mkdir()
        with sqlite3.connect(f'file:{settings.db_path}?mode=ro',uri=True) as source, sqlite3.connect(data/'courseforge.sqlite3') as target:
            source.backup(target)
        env = dict(os.environ,DATA_DIR=str(data),COURSES_DIR=str(settings.courses_dir),COOKIE_SECURE='0',
                   ALLOWED_HOSTS='127.0.0.1',ODYSEE_AUTH_TOKEN='',ODYSEE_CHANNEL_ID='')
        with socket.socket() as sock:
            sock.bind(('127.0.0.1',0));port = sock.getsockname()[1]
        base = f'http://127.0.0.1:{port}';env['PUBLIC_BASE_URL'] = base
        subprocess.run([sys.executable,'scripts/academy_manage.py','migrate'],env=env,check=True,stdout=subprocess.DEVNULL)
        now = datetime.now(timezone.utc).isoformat(timespec='seconds')
        expires = (datetime.now(timezone.utc)+timedelta(hours=1)).isoformat(timespec='seconds')
        sessions = []
        with sqlite3.connect(data/'courseforge.sqlite3') as db:
            course = db.execute('SELECT course FROM videos GROUP BY course ORDER BY COUNT(*) DESC LIMIT 1').fetchone()
            if not course:raise SystemExit('The library must contain a real course')
            course = course[0]
            video_id = db.execute('SELECT id FROM videos WHERE course=? ORDER BY title LIMIT 1',(course,)).fetchone()[0]
            db.execute('INSERT OR REPLACE INTO course_publication VALUES(?,1,?,?)',(course,'',now))
            for i in range(args.users):
                uid = 'capacity_'+secrets.token_hex(12);token = secrets.token_urlsafe(32);csrf = secrets.token_urlsafe(32)
                # These accounts exist only in this temporary database. No mail,
                # password login or changes to the production library occur.
                db.execute('INSERT INTO users VALUES(?,?,?,?,?,1,0,?)',(uid,uid+'@capacity.test',uid,'disabled','student',now))
                db.execute('INSERT INTO auth_sessions VALUES(?,?,?,?,?,?,?,?,?)',(uid,uid,hashlib.sha256(token.encode()).hexdigest(),csrf,now,expires,now,'Capacity check','127.0.0.1'))
                db.execute('INSERT INTO enrollments VALUES(?,?,?)',(uid,course,now));sessions.append((token,csrf))
        with (root/'server.log').open('w') as log:
            process = subprocess.Popen([sys.executable,'-m','uvicorn','app.main:app','--host','127.0.0.1','--port',str(port),'--timeout-keep-alive','30'],env=env,stdout=log,stderr=log)
            try:
                for _ in range(100):
                    try:
                        if httpx.get(base+'/api/health',timeout=.5).status_code==200:break
                    except httpx.HTTPError:pass
                    if process.poll() is not None:raise RuntimeError('Capacity server failed to start')
                    time.sleep(.1)
                else:raise RuntimeError('Capacity server timed out')
                report = asyncio.run(exercise(base,sessions,video_id,args.rounds))
                print(json.dumps(report,indent=2))
                if report['failures']:
                    log.flush()
                    print('Server return code:', process.poll())
                    print((root/'server.log').read_text()[-5000:])
                    raise SystemExit(1)
            finally:
                process.terminate()
                try:process.wait(timeout=10)
                except subprocess.TimeoutExpired:process.kill();process.wait()


if __name__=='__main__':
    main()
