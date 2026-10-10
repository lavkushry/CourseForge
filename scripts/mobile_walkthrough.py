"""Phone and 3G checks using an isolated copy of the real library.

Creates no production accounts, progresses no production lessons, and prints
no credentials. Run with .venv/bin/python scripts/mobile_walkthrough.py.
"""
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
import urllib.request
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from playwright.sync_api import sync_playwright
from app.config import settings


def main():
    with tempfile.TemporaryDirectory(prefix='courseforge-phone-') as folder:
        target = Path(folder) / 'courseforge.sqlite3'
        with sqlite3.connect(settings.db_path) as source, sqlite3.connect(target) as copy:
            source.backup(copy)
            password = secrets.token_urlsafe(24)
            email = 'phone-' + secrets.token_hex(8) + '@courseforge.test'
            courses = [row[0] for row in copy.execute('SELECT course FROM course_publication WHERE published=1')]
            lesson = copy.execute('SELECT v.id FROM videos v JOIN lecture_providers p ON p.video_id=v.id WHERE v.title LIKE "[005]%"').fetchone()[0]
        with socket.socket() as s:
            s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]
        url = f'http://127.0.0.1:{port}'
        env = {**os.environ, 'DATA_DIR': folder, 'PUBLIC_BASE_URL': url, 'COOKIE_SECURE': '0', 'REGISTRATION_MODE':'open'}
        server = subprocess.Popen([sys.executable, '-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', str(port)],
                                  cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            for _ in range(60):
                try:
                    urllib.request.urlopen(url + '/api/health', timeout=1); break
                except OSError:
                    time.sleep(.1)
            with sync_playwright() as pw:
                browser = pw.chromium.launch()
                context = browser.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
                signup=context.new_page();signup.goto(url+'/#register')
                signup.locator('[name=name]').fill('Mobile validation');signup.locator('[name=email]').fill(email);signup.locator('[name=password]').fill(password)
                signup.locator('.academy-form').get_by_role('button',name='Create account',exact=True).click()
                signup.wait_for_selector('#logoutNav:not([hidden])')
                signup.locator('#catalogNav').click()
                signup.locator('article.academy-course').filter(has_text='Azure Data Engineer').get_by_role('button',name='View syllabus').click()
                signup.get_by_role('button',name='Enroll for free',exact=True).click()
                signup.wait_for_selector('.player-center-play',timeout=60000);signup.locator('.player-center-play').click()
                signup.wait_for_function('CourseForgeNative.video().currentTime>1',timeout=60000)
                signup.locator('#markCompleteBtn').click()
                signup.wait_for_function("document.querySelector('#markCompleteBtn').getAttribute('aria-pressed')==='true'")
                me=context.request.get(url+'/api/me').json()
                for course in courses:
                    response=context.request.post(url+'/api/courses/'+quote(course,safe='')+'/enroll',data={},headers={'X-CSRF-Token':me['csrf_token']});assert response.ok
                signup.evaluate('CourseForgeNative.stop();CourseForgePlayerSession.close()')
                cookies=context.cookies();context.close()
                timings = []
                errors = []
                # Fast 3G: 1.6 Mbps down, 750 Kbps up, 150 ms RTT; 4x CPU.
                for trial in range(3):
                    context=browser.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True)
                    context.add_cookies(cookies);page=context.new_page()
                    page.on('pageerror',lambda e:errors.append(str(e)))
                    cdp=context.new_cdp_session(page);cdp.send('Network.enable')
                    cdp.send('Network.setCacheDisabled', {'cacheDisabled': True})
                    cdp.send('Network.emulateNetworkConditions', {'offline': False, 'latency': 150, 'downloadThroughput': 1_600_000 / 8, 'uploadThroughput': 750_000 / 8})
                    cdp.send('Emulation.setCPUThrottlingRate', {'rate': 4})
                    page.goto(url + '/#learning/' + lesson, wait_until='commit')
                    page.wait_for_function("document.documentElement.dataset.lessonInteractive==='true' && document.querySelector('#playingTitle').textContent && !document.querySelector('#nextLessonBtn').disabled")
                    timings.append(round(page.evaluate('performance.now()'), 1))
                    # Finish and release the session before the next cold load.
                    page.wait_for_function("window.CourseForgeReady===true", timeout=60000)
                    if trial<2:
                        page.evaluate('CourseForgePlayerSession.close()');context.close()
                cdp.send('Network.emulateNetworkConditions', {'offline': False, 'latency': 0, 'downloadThroughput': -1, 'uploadThroughput': -1})
                cdp.send('Emulation.setCPUThrottlingRate', {'rate': 1})
                cdp.send('Network.setCacheDisabled', {'cacheDisabled': False})
                page.wait_for_selector('.player-center-play',timeout=60000)
                page.locator('.player-center-play').click()
                page.wait_for_function('CourseForgeNative.video().currentTime>1',timeout=60000)
                page.locator('.native-player-stage').focus();page.keyboard.press('f')
                page.wait_for_function('!!document.fullscreenElement')
                cdp.send('Emulation.setDeviceMetricsOverride',{'width':844,'height':390,'deviceScaleFactor':1,'mobile':True,'screenOrientation':{'type':'landscapePrimary','angle':90}})
                assert page.locator('.native-watermark').is_visible()
                page.evaluate('document.exitFullscreen()')
                cdp.send('Emulation.clearDeviceMetricsOverride')
                checked = []
                for width in (320, 390, 768):
                    page.set_viewport_size({'width': width, 'height': 844})
                    for view in ('dashboard', 'planner', 'library', 'learning', 'syllabus'):
                        page.evaluate('view=>navigate(view)', view)
                        if view == 'syllabus':
                            page.evaluate("document.querySelector('#assessmentPanel').hidden=false")
                        assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'), f'{view} overflows at {width}'
                        checked.append(f'{view}:{width}')
                    page.evaluate("navigate('learning');selectLessonTab('notes')")
                    page.locator('#noteText').fill('A note saved during the phone walkthrough.')
                    assert page.locator('#noteText').bounding_box()['width'] <= width
                    assert page.locator('.mobile-next').bounding_box()['height'] >= 44
                    page.screenshot(path=str(settings.data_dir / f'phase1-phone-{width}.png'), full_page=False)
                page.evaluate("selectLessonTab('lessons')")
                page.set_viewport_size({'width': 844, 'height': 390})
                assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
                assert not errors, errors
                result = {'profile': 'Fast 3G: 1.6Mbps down / 750Kbps up / 150ms RTT, CPU 4x, cold cache',
                          'interactive_ms': timings, 'phone_checks': checked, 'signup_enroll_watch_complete':True,'playback_and_fullscreen':True, 'page_errors': errors}
                (settings.data_dir / 'phase1-mobile-results.json').write_text(json.dumps(result, indent=2))
                print(json.dumps(result, indent=2))
                assert max(timings) < 2000, 'Lesson shell exceeded the 2 second target'
                browser.close()
        finally:
            server.terminate(); server.wait(timeout=10)


if __name__ == '__main__':
    main()
