import time
import requests
from playwright.sync_api import sync_playwright

BASE_URL = 'http://127.0.0.1:8000'
LESSON_ID = 'e0b8187a2b31f15c8662f389'

# Login via API
resp = requests.post(
    f'{BASE_URL}/api/auth/login',
    json={'email': 'admin@courseforge.com', 'password': 'password123'}
)
print('API login status:', resp.status_code)
cookies = resp.cookies.get_dict()
cf_session = cookies.get('cf_session')
print('Session cookie:', cf_session[:10] + '...' if cf_session else 'None')

viewports = [
    ('studio_1024x570', 1024, 570),
    ('studio_1366x768', 1366, 768),
    ('studio_mobile_390', 390, 844),
]

with sync_playwright() as p:
    browser = p.chromium.launch()
    for name, w, h in viewports:
        context = browser.new_context(
            viewport={'width': w, 'height': h},
            ignore_https_errors=True
        )
        context.add_cookies([{
            'name': 'cf_session',
            'value': cf_session,
            'domain': '127.0.0.1',
            'path': '/'
        }])
        page = context.new_page()
        page.goto(f'{BASE_URL}/#lecture/{LESSON_ID}', wait_until='domcontentloaded')
        time.sleep(3)
        
        # Verify elements
        header_box = page.eval_on_selector('.studio-header', 'el => ({ height: el.offsetHeight, top: el.offsetTop })')
        prev_box = page.eval_on_selector('#previousLessonBtn', 'el => ({ top: el.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom })')
        next_box = page.eval_on_selector('#nextLessonBtn', 'el => ({ top: el.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom })')
        active_link = page.eval_on_selector('.lesson-link.active', 'el => ({ text: el.innerText.slice(0, 30), bg: window.getComputedStyle(el).backgroundColor, border: window.getComputedStyle(el).borderColor, shadow: window.getComputedStyle(el).boxShadow })')
        
        print(f'=== {name} (viewport {w}x{h}) ===')
        print(f'Studio Header height: {header_box[height]}px')
        print(f'Active lesson: {active_link[text]}')
        print(f'Active styling bg: {active_link[bg]}')
        print(f'Previous button bottom: {prev_box[bottom]}px (inside screen height {h}: {prev_box[bottom] <= h})')
        print(f'Next button bottom: {next_box[bottom]}px (inside screen height {h}: {next_box[bottom] <= h})')
        
        out_path = f'/home/ubuntu/CourseForge/{name}.png'
        page.screenshot(path=out_path)
        print(f'Saved: {out_path}\n')
        context.close()
    browser.close()
print('DONE')
