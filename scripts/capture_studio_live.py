import requests
import time
from playwright.sync_api import sync_playwright

BASE_URL = 'https://acrobat-shopzilla-classified-webmasters.trycloudflare.com'
LESSON_ID = 'e0b8187a2b31f15c8662f389'

session = requests.Session()
res = session.post(f'{BASE_URL}/api/auth/login', json={'email': 'admin@courseforge.com', 'password': 'password123'})
data = res.json()
cookie_val = session.cookies.get('cf_session')
print('Logged in, session cookie:', cookie_val[:10] if cookie_val else 'None')

viewports = [
    ('user_screen_1024x570', 1024, 570),
    ('desktop_1366x768', 1366, 768),
    ('mobile_390x844', 390, 844),
]

with sync_playwright() as p:
    browser = p.chromium.launch()
    for name, w, h in viewports:
        context = browser.new_context(viewport={'width': w, 'height': h})
        context.add_cookies([{
            'name': 'cf_session',
            'value': cookie_val,
            'url': BASE_URL,
            'httpOnly': True,
            'secure': True,
            'sameSite': 'Lax'
        }])
        page = context.new_page()
        page.goto(f'{BASE_URL}/#lecture/{LESSON_ID}', wait_until='domcontentloaded')
        time.sleep(3)
        page.wait_for_selector('body.in-learning', timeout=15000)
        page.wait_for_selector('#playingDetails:not([hidden])', timeout=15000)
        time.sleep(2)
        
        # Check elements
        header_box = page.eval_on_selector('.studio-header', 'el => ({ height: el.offsetHeight, top: el.offsetTop })')
        prev_box = page.eval_on_selector('#previousLessonBtn', 'el => ({ top: el.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom })')
        next_box = page.eval_on_selector('#nextLessonBtn', 'el => ({ top: el.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom })')
        active_name = page.eval_on_selector('.lesson-link.active .name', 'el => el.innerText')
        active_style = page.eval_on_selector('.lesson-link.active', 'el => ({ bg: window.getComputedStyle(el).backgroundColor, border: window.getComputedStyle(el).borderColor, shadow: window.getComputedStyle(el).boxShadow })')
        
        print(f'=== {name} (viewport {w}x{h}) ===')
        print(f'Studio Header height: {header_box["height"]}px')
        print(f'Active lesson: {active_name}')
        print(f'Active styling: {active_style}')
        print(f'Previous Lesson button bottom: {prev_box["bottom"]}px (inside screen height {h}: {prev_box["bottom"] <= h})')
        print(f'Next Lesson button bottom: {next_box["bottom"]}px (inside screen height {h}: {next_box["bottom"] <= h})')
        
        screenshot_path = f'/home/ubuntu/CourseForge/{name}.png'
        page.screenshot(path=screenshot_path)
        print(f'Saved: {screenshot_path}\n')
        context.close()
    browser.close()
print('ALL VIEWPORTS CAPTURED SUCCESSFULLY')
