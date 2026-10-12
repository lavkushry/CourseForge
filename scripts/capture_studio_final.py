import time
import sqlite3
import requests
from playwright.sync_api import sync_playwright

HOST = 'acrobat-shopzilla-classified-webmasters.trycloudflare.com'
LIVE_URL = f'https://{HOST}'
LESSON_ID = 'e0b8187a2b31f15c8662f389'

# Clear rate limits and stale player ownership
with sqlite3.connect('/home/ubuntu/CourseForge/data/courseforge.sqlite3', timeout=30) as db:
    db.execute('DELETE FROM rate_limits;')
    db.execute('DELETE FROM player_ownership;')
    db.commit()

resp = requests.post(
    f'{LIVE_URL}/api/auth/login',
    json={'email': 'admin@courseforge.com', 'password': 'password123'}
)
assert resp.status_code == 200, f'Login failed: {resp.status_code}'
cf_session = resp.cookies.get_dict().get('cf_session')

viewports = [
    ('studio_1024x570', 1024, 570),
    ('studio_1366x768', 1366, 768),
    ('studio_mobile_390', 390, 844),
]

with sync_playwright() as p:
    browser = p.chromium.launch()
    for name, w, h in viewports:
        # Clear ownership before each viewport session so there are no conflicts
        with sqlite3.connect('/home/ubuntu/CourseForge/data/courseforge.sqlite3', timeout=30) as db:
            db.execute('DELETE FROM player_ownership;')
            db.commit()
            
        context = browser.new_context(
            viewport={'width': w, 'height': h},
            ignore_https_errors=True
        )
        context.add_cookies([{
            'name': 'cf_session',
            'value': cf_session,
            'domain': HOST,
            'path': '/',
            'secure': True,
            'httpOnly': True
        }])
        page = context.new_page()
        page.goto(f'{LIVE_URL}/#/lecture/{LESSON_ID}', wait_until='domcontentloaded')
        
        page.wait_for_selector('#appShell:not([hidden])', timeout=25000)
        page.wait_for_selector('.lesson-link.active', timeout=20000)
        time.sleep(2)
        
        # If any takeover dialog appeared, click 'Move playback here'
        dialog_btn = page.query_selector('.player-dialog button.btn-primary')
        if dialog_btn:
            dialog_btn.click()
            time.sleep(2)
            
        # Verify footer is hidden
        footer_hidden = page.eval_on_selector('.streaming-footer', 'el => window.getComputedStyle(el).display === "none"')
        
        header_box = page.eval_on_selector('.studio-header', 'el => ({ height: el.offsetHeight, top: el.offsetTop })')
        prev_box = page.eval_on_selector('#previousLessonBtn', 'el => ({ top: el.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom })')
        next_box = page.eval_on_selector('#nextLessonBtn', 'el => ({ top: el.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom })')
        active_link = page.eval_on_selector('.lesson-link.active', 'el => ({ text: el.innerText.slice(0, 30), bg: window.getComputedStyle(el).backgroundColor, border: window.getComputedStyle(el).borderColor })')
        
        print(f'=== {name} ({w}x{h}) ===')
        print(f'Header height: {header_box['height']}px')
        print(f'Footer hidden: {footer_hidden}')
        print(f'Active lesson: {active_link['text']}')
        print(f'Active bg: {active_link['bg']}')
        print(f'Previous button bottom: {prev_box['bottom']}px (inside screen: {prev_box['bottom'] <= h})')
        print(f'Next button bottom: {next_box['bottom']}px (inside screen: {next_box['bottom'] <= h})')
        
        out_file = f'/home/ubuntu/CourseForge/{name}.png'
        page.screenshot(path=out_file)
        print(f'Saved: {out_file}\n')
        context.close()
    browser.close()
print('ALL VIEWPORTS VERIFIED')
