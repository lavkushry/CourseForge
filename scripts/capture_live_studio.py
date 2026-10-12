import time
from playwright.sync_api import sync_playwright

LIVE_URL = 'https://acrobat-shopzilla-classified-webmasters.trycloudflare.com'
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
        page.goto(LIVE_URL, wait_until='domcontentloaded')
        time.sleep(2)
        
        # Check if login needed
        if page.is_visible('#signinNav'):
            page.click('#signinNav')
            page.wait_for_selector('input[type=email]', timeout=10000)
            page.fill('input[type=email]', 'admin@courseforge.com')
            page.fill('input[type=password]', 'password123')
            # Wait for reload after login
            with page.expect_navigation(wait_until='domcontentloaded', timeout=15000):
                page.click('#academyContent button[type=submit]')
            time.sleep(2)
        
        page.wait_for_selector('#appShell:not([hidden])', timeout=15000)
        time.sleep(1)
        
        # Open the lesson
        page.evaluate(f"window.openVideo('{LESSON_ID}')")
        time.sleep(4)
        
        # Measurements
        header_h = page.eval_on_selector('.studio-header', 'el => el.offsetHeight')
        prev_bot = page.eval_on_selector('#previousLessonBtn', 'el => el.getBoundingClientRect().bottom')
        next_bot = page.eval_on_selector('#nextLessonBtn', 'el => el.getBoundingClientRect().bottom')
        active_title = page.eval_on_selector('.lesson-link.active .name', 'el => el.textContent')
        print(f'=== {name} ({w}x{h}) ===')
        print(f'Header height: {header_h}px')
        print(f'Active lesson: {active_title}')
        print(f'Previous button bottom: {prev_bot}px (visible in viewport: {prev_bot <= h})')
        print(f'Next button bottom: {next_bot}px (visible in viewport: {next_bot <= h})')
        
        path = f'/home/ubuntu/CourseForge/studio_{name}.png'
        page.screenshot(path=path)
        print(f'Saved: {path}\n')
        context.close()
    browser.close()
print('ALL STUDIO CAPTURES SUCCEEDED')
