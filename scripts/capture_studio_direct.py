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
        
        # Sign in through UI
        page.click('#signinNav')
        page.wait_for_selector('input[type=email]', timeout=10000)
        page.fill('input[type=email]', 'admin@courseforge.com')
        page.fill('input[type=password]', 'password123')
        page.click('button[type=submit]')
        page.wait_for_selector('#appShell:not([hidden])', timeout=15000)
        time.sleep(2)
        
        # Now call openVideo
        page.evaluate(f"window.openVideo('{LESSON_ID}')")
        page.wait_for_selector('#playingDetails:not([hidden])', timeout=15000)
        time.sleep(3)
        
        # Verify geometry
        header_box = page.eval_on_selector('.studio-header', 'el => ({ height: el.offsetHeight, top: el.offsetTop })')
        prev_box = page.eval_on_selector('#previousLessonBtn', 'el => ({ top: el.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom })')
        next_box = page.eval_on_selector('#nextLessonBtn', 'el => ({ top: el.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom })')
        active_link = page.eval_on_selector('.lesson-link.active', 'el => ({ text: el.innerText.split(' ')[0], bg: window.getComputedStyle(el).backgroundColor, border: window.getComputedStyle(el).borderColor, shadow: window.getComputedStyle(el).boxShadow })')
        
        print(f'=== {name} (viewport {w}x{h}) ===')
        print(f'Studio Header height: {header_box["height"]}px')
        print(f'Active lesson: {active_link["text"]}')
        print(f'Active styling bg: {active_link["bg"]}, border: {active_link["border"]}')
        print(f'Previous Lesson button bottom: {prev_box["bottom"]}px (inside screen height {h}: {prev_box["bottom"] <= h})')
        print(f'Next Lesson button bottom: {next_box["bottom"]}px (inside screen height {h}: {next_box["bottom"] <= h})')
        
        screenshot_path = f'/home/ubuntu/CourseForge/{name}.png'
        page.screenshot(path=screenshot_path)
        print(f'Saved: {screenshot_path}\n')
        context.close()
    browser.close()
print('ALL VERIFICATIONS FINISHED')
