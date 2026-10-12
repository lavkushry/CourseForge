import time
from playwright.sync_api import sync_playwright

LOCAL_URL = 'http://127.0.0.1:8000'
LESSON_ID = 'e0b8187a2b31f15c8662f389'

viewports = [
    ('user_screen_1024x570', 1024, 570),
    ('desktop_1366x768', 1366, 768),
    ('mobile_390x844', 390, 844),
]

with sync_playwright() as p:
    browser = p.chromium.launch()
    for name, w, h in viewports:
        context = browser.new_context(viewport={'width': w, 'height': h})
        page = context.new_page()
        page.goto(LOCAL_URL, wait_until='networkidle')
        
        # Sign in
        page.click('#signinNav')
        page.wait_for_selector('input[type=email]', timeout=5000)
        page.fill('input[type=email]', 'admin@courseforge.com')
        page.fill('input[type=password]', 'password123')
        page.click('button[type=submit]')
        page.wait_for_selector('#streamingHero', timeout=15000)
        
        # Navigate directly to the lesson from the user's screenshot
        page.evaluate(f"window.location.hash = '#lecture/{LESSON_ID}'")
        page.wait_for_selector('#playingDetails', timeout=15000)
        time.sleep(2)
        
        # Check geometry of studio header and action buttons
        header_box = page.eval_on_selector('.studio-header', 'el => el.getBoundingClientRect()')
        prev_box = page.eval_on_selector('#previousLessonBtn', 'el => el.getBoundingClientRect()')
        next_box = page.eval_on_selector('#nextLessonBtn', 'el => el.getBoundingClientRect()')
        
        print(f'[{name}] Studio Header height: {header_box["height"]}px, top: {header_box["top"]}px')
        print(f'[{name}] Previous Button top: {prev_box["top"]}px, bottom: {prev_box["bottom"]}px, visible in viewport {h}: {prev_box["bottom"] <= h}')
        print(f'[{name}] Next Button top: {next_box["top"]}px, bottom: {next_box["bottom"]}px, visible in viewport {h}: {next_box["bottom"] <= h}')
        
        screenshot_path = f'/home/ubuntu/CourseForge/{name}.png'
        page.screenshot(path=screenshot_path)
        print(f'Saved screenshot: {screenshot_path}')
        context.close()
    browser.close()
print('ALL VERIFICATIONS COMPLETED')
