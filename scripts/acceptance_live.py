"""Opt-in, loopback-only acceptance checks against the REAL local CourseForge app.

No simulated model or grader results. Each probe has an explicit PASS/FAIL/SKIP.
Run this on the computer hosting CourseForge, its original videos and services.
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass, asdict
from pathlib import Path
from urllib.parse import quote, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.validate_local import local_url
from app.config import settings


@dataclass
class Check:
    name: str
    status: str  # PASS | FAIL | SKIP
    detail: str = ''


class Acceptance:
    def __init__(self, origin: str):
        self.origin = local_url(origin)
        self.results: list[Check] = []

    def record(self, name: str, ok: bool, detail: str = '') -> None:
        self.results.append(Check(name, 'PASS' if ok else 'FAIL', str(detail)[:280]))

    def skip(self, name: str, why: str) -> None:
        self.results.append(Check(name, 'SKIP', why[:280]))

    def call(self, path: str, method: str = 'GET', *, payload=None, headers=None, timeout=20,
             max_bytes=2_000_000):
        # Every HTTP operation stays on the validated loopback app origin.
        assert path.startswith('/') and not path.startswith('//')
        url = self.origin + path
        body = None if payload is None else json.dumps(payload).encode('utf-8')
        request = urllib.request.Request(url, data=body, method=method,
                      headers={'Content-Type': 'application/json', **(headers or {})})
        # Do not follow redirects away from localhost, even if the server is misconfigured.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, hdrs, newurl):
                raise ValueError('Redirect rejected: only the original local API is allowed')
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        try:
            with opener.open(request, timeout=timeout) as resp:
                data = resp.read(max_bytes + 1)
                if len(data) > max_bytes:
                    raise ValueError('API response exceeds allowed size')
                return resp.status, dict(resp.headers), data
        except urllib.error.HTTPError as exc:
            return exc.code, dict(exc.headers), exc.read(min(4096, max_bytes))

    def json(self, path, method='GET', **kwargs):
        status, headers, body = self.call(path, method, **kwargs)
        return status, json.loads(body), headers

    def health(self) -> bool:
        try:
            status, data, _ = self.json('/api/health')
            ok = status == 200 and data.get('status') == 'ok'
            self.record('local FastAPI health', ok, f'HTTP {status}')
            return ok
        except (OSError, ValueError, TimeoutError) as exc:
            self.record('local FastAPI health', False, type(exc).__name__)
            return False

    def video(self, video_id: str) -> bool:
        vid = quote(video_id, safe='')
        try:
            status, info, _ = self.json('/api/videos/' + vid)
            video = info.get('video') or {}
            chunks = info.get('chunks') or []
            ok = status == 200 and video.get('status') == 'done' and bool(chunks)
            self.record('indexed lecture and transcript', ok,
                        f'HTTP {status}, timestamped chunks: {len(chunks)}')
            self.record('source timestamps', bool(chunks) and all(
                        isinstance(c.get('start'), (int, float)) and c['start'] >= 0 for c in chunks))
            status, headers, content = self.call('/api/videos/' + vid + '/stream',
                         headers={'Range': 'bytes=0-63'}, max_bytes=64)
            range_header = headers.get('Content-Range') or headers.get('content-range') or ''
            self.record('video byte-range seeking', status == 206 and len(content) == 64
                        and bool(re.match(r'^bytes 0-63/\d+$', range_header)), f'HTTP {status}')
            return ok
        except (OSError, ValueError, KeyError, TimeoutError) as exc:
            self.record('lecture media API', False, type(exc).__name__)
            return False

    def notes(self, video_id: str) -> None:
        vid = quote(video_id, safe='')
        note_id = None
        try:
            status, note, _ = self.json('/api/videos/' + vid + '/notes', 'POST',
                        payload={'position': 1.25, 'content': 'CourseForge acceptance probe '+uuid.uuid4().hex})
            note_id = note.get('id') if status == 201 else None
            self.record('note create', status == 201 and bool(note_id), f'HTTP {status}')
            if note_id:
                status, data, _ = self.json('/api/videos/' + vid + '/notes')
                self.record('timestamped note read', status == 200 and any(
                    n.get('id') == note_id and abs(n.get('position', -1) - 1.25) < 0.01
                    for n in data.get('notes', [])))
        except (OSError, ValueError, TypeError, TimeoutError) as exc:
            self.record('note API', False, type(exc).__name__)
        finally:
            if note_id:
                try:
                    status, _, _ = self.call('/api/notes/' + quote(str(note_id),safe=''), 'DELETE')
                    self.record('probe note cleanup', status == 204, f'HTTP {status}')
                except (OSError, TimeoutError) as exc:
                    self.record('probe note cleanup', False, type(exc).__name__)

    def focus(self, video_id: str | None) -> None:
        """Cancel ONLY a newly created probe session; do not touch learner sessions."""
        session_id = None
        try:
            status, active, _ = self.json('/api/focus/active')
            if status != 200:
                self.record('focus preflight', False, f'HTTP {status}')
                return
            if active.get('session') is not None:
                self.skip('focus timer lifecycle', 'Existing active/paused learner session; not modified')
                return
            payload = {'mode':'focus','duration_minutes':1,'title':'CourseForge acceptance probe'}
            if video_id:
                payload['video_id'] = video_id
            status, started, _ = self.json('/api/focus/sessions','POST',payload=payload)
            session_id = started.get('id') if status == 201 else None
            self.record('focus session starts and links to lesson',status == 201 and bool(session_id)
                        and started.get('video_id') == video_id, f'HTTP {status}')
            if not session_id:
                return
            sid = quote(str(session_id),safe='')
            status, paused, _ = self.json('/api/focus/sessions/'+sid+'/actions','POST',payload={'action':'pause'})
            self.record('focus pauses', status == 200 and paused.get('status') == 'paused')
            status, resumed, _ = self.json('/api/focus/sessions/'+sid+'/actions','POST',payload={'action':'resume'})
            self.record('focus resumes', status == 200 and resumed.get('status') == 'running')
            status, history, _ = self.json('/api/focus/history')
            self.record('focus persisted history',status == 200 and any(
                       row.get('id') == session_id for row in history.get('sessions',[])))
        except (OSError, ValueError, TypeError, TimeoutError) as exc:
            self.record('focus API lifecycle', False, type(exc).__name__)
        finally:
            if session_id:
                try:
                    status, cancelled, _ = self.json('/api/focus/sessions/'+quote(str(session_id),safe='')+'/actions',
                                  'POST',payload={'action':'cancel'})
                    self.record('probe timer cleanup', status == 200 and cancelled.get('status')=='cancelled')
                except (OSError, ValueError, TimeoutError) as exc:
                    self.record('probe timer cleanup',False,type(exc).__name__)

    def lab(self) -> None:
        """Opt-in: creates one persisted lab session and runs pre-reviewed code in Docker."""
        if not shutil.which('docker'):
            self.record('restricted Docker grader', False,'Docker CLI unavailable')
            return
        try:
            status, new, _ = self.json('/api/labs/python-log-analysis/start','POST')
            if status != 200:
                self.record('lab start',False,f'HTTP {status}')
                return
            sid = quote(new['session_id'],safe='')
            solution = 'def count_errors(lines):\n    return sum("ERROR" in line.split() for line in lines)\n'
            status, saved, _ = self.json('/api/lab-sessions/'+sid+'/file','PUT',payload={'content':solution})
            self.record('lab file save',status == 200 and saved.get('saved') is True)
            status, result, _ = self.json('/api/lab-sessions/'+sid+'/submit','POST',
                             payload={'validate_in_kind':False},timeout=60)
            self.record('real isolated Docker grading',status == 200 and result.get('passed') is True
                        and bool(result.get('checks')),f'HTTP {status}')
        except (OSError, ValueError, KeyError, TimeoutError) as exc:
            self.record('restricted Docker grading',False,type(exc).__name__)

    def inference(self, video_id: str, timeout: int) -> None:
        # No fake fallback: call existing explicit, real-model pipeline on this machine.
        if not 30 <= timeout <= 14400:
            self.record('real AI pipeline',False,'timeout must be 30–14400 seconds')
            return
        cmd = [sys.executable, str(Path(__file__).with_name('e2e_real.py')),
               '--video-id', video_id, '--fresh-transcript']
        try:
            proc = subprocess.run(cmd, capture_output=True,text=True,timeout=timeout)
            # Only pass a short fixed-purpose summary, never model output, paths or transcripts to the report.
            self.record('real Whisper/Ollama/Qdrant/AI pipeline',proc.returncode == 0,
                        'Model pipeline exit code '+str(proc.returncode))
            if proc.returncode != 0:
                print('Model pipeline failed; inspect local worker/model logs. Source output is intentionally excluded from report.', file=sys.stderr)
        except (OSError, subprocess.TimeoutExpired) as exc:
            self.record('real Whisper/Ollama/Qdrant/AI pipeline',False,type(exc).__name__)

    def browser(self, video_id: str | None, screenshot_dir: Path | None) -> None:
        try:
            from playwright.sync_api import sync_playwright
        except ImportError:
            self.record('real Chromium browser',False,'Install: pip install playwright && python -m playwright install chromium')
            return
        try:
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(headless=True)
                context = browser.new_context(viewport={'width':1280,'height':800},accept_downloads=False)
                page = context.new_page()
                errors=[]
                page.on('pageerror',lambda exc: errors.append(str(exc)[:100]))
                response=page.goto(self.origin+'/#planner',wait_until='domcontentloaded',timeout=20000)
                page.locator('#focusClock').wait_for(timeout=12000)
                self.record('real Chromium app initialization',response is not None and response.status==200)
                # Navigate without modifying persisted learner data.
                page.locator('[data-nav="library"]').first.click()
                self.record('real Chromium library navigation',page.locator('[data-view="library"]:not([hidden])').count()==1)
                page.locator('[data-nav="planner"]').first.click()
                self.record('real Chromium planner navigation',page.locator('#focusStart').count()==1)
                if video_id:
                    # Real decoder and seek check, not just HTTP 206. Codec support varies by browser.
                    source=self.origin+'/api/videos/'+quote(video_id,safe='')+'/stream'
                    result=page.evaluate('''async src=>{
                      const video=document.createElement('video');video.preload='auto';
                      video.muted=true;video.style.display='none';document.body.append(video);
                      try{
                        video.src=src;
                        await Promise.race([new Promise((ok,fail)=>{
                          video.addEventListener('loadedmetadata',ok,{once:true});
                          video.addEventListener('error',()=>fail(Error('Decoder or format unsupported')),{once:true});
                        }),new Promise((_,fail)=>setTimeout(()=>fail(Error('Metadata timeout')),12000))]);
                        if(!Number.isFinite(video.duration) || video.duration<1)return 'No seekable duration';
                        video.currentTime=Math.min(2,video.duration/2);
                        await Promise.race([new Promise((ok,fail)=>{
                          video.addEventListener('seeked',ok,{once:true});
                          video.addEventListener('error',()=>fail(Error('Seek failed')),{once:true});
                        }),new Promise((_,fail)=>setTimeout(()=>fail(Error('Seek timeout')),12000))]);
                        return 'ok';
                      }catch(e){return e.message;}finally{video.removeAttribute('src');video.load();video.remove();}
                    }''',source)
                    self.record('real Chromium video decode and seek',result=='ok',result)
                self.record('browser uncaught JavaScript errors',not errors,'; '.join(errors[:2]))
                if screenshot_dir is not None:
                    screenshot_dir.mkdir(parents=True,exist_ok=True)
                    page.screenshot(path=str(screenshot_dir/'courseforge-acceptance.png'),full_page=True)
                context.close();browser.close()
        except Exception as exc:
            self.record('real Chromium browser',False,type(exc).__name__+' (see browser/localhost configuration)')


def execute(args):
    suite=Acceptance(args.url)
    if not suite.health():
        for name in ('video', 'notes', 'focus', 'Docker lab', 'real AI', 'browser'):
            suite.skip(name, 'Application health failed; no mutations attempted')
        return suite.results
    if args.video_id:
        indexed = suite.video(args.video_id)
        if indexed:
            suite.notes(args.video_id)
        else:
            suite.skip('notes','Indexed lecture missing')
    else:
        suite.skip('video and note checks','Pass --video-id from GET /api/videos')
    if args.focus:
        suite.focus(args.video_id)
    else:
        suite.skip('focus timer lifecycle','Enable --focus')
    if args.docker_lab:
        suite.lab()
    else:
        suite.skip('Docker lab grading','Enable --docker-lab')
    if args.real_ai:
        if args.video_id:
            suite.inference(args.video_id,args.inference_timeout)
        else:
            suite.record('real AI pipeline',False,'--real-ai requires --video-id')
    else:
        suite.skip('real AI inference','Enable --real-ai (reindexes the selected lecture)')
    if args.browser:
        suite.browser(args.video_id,args.screenshot_dir)
    else:
        suite.skip('real Chromium browser','Enable --browser')
    return suite.results


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url',default='http://127.0.0.1:8000',help='Local app origin only')
    parser.add_argument('--video-id',help='Indexed video ID from /api/videos')
    parser.add_argument('--focus',action='store_true',help='Test and cancel one new timer session')
    parser.add_argument('--docker-lab',action='store_true',help='Run a curated Docker grader test (leaves a lab session)')
    parser.add_argument('--real-ai',action='store_true',help='Run real Whisper/Ollama/Qdrant pipeline (reindexes video)')
    parser.add_argument('--browser',action='store_true',help='Use actual local Chromium for navigation and playback seeking')
    parser.add_argument('--inference-timeout',type=int,default=3600)
    parser.add_argument('--screenshot-dir',type=Path,help='Optional local-only screenshot destination; could contain personal course names')
    parser.add_argument('--json-output',type=Path,help='Optional local-only JSON report; do not commit personal run details')
    args=parser.parse_args(argv)
    try:
        checks=execute(args)
    except ValueError as exc:
        parser.error(str(exc))
    for c in checks:
        print(f'{c.status:4} {c.name}'+(f' — {c.detail}' if c.detail else ''))
    summary={status:sum(c.status==status for c in checks) for status in ('PASS','FAIL','SKIP')}
    print('Result:', 'PASS' if summary['FAIL']==0 and summary['PASS'] else 'FAIL',summary)
    if args.json_output:
        args.json_output.parent.mkdir(parents=True,exist_ok=True)
        args.json_output.write_text(json.dumps({'summary':summary,'checks':[asdict(c) for c in checks]},indent=2))
    return 0 if summary['FAIL']==0 and summary['PASS'] else 1


if __name__=='__main__':
    raise SystemExit(main())