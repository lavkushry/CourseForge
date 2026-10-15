import time
from pathlib import Path
from playwright.sync_api import sync_playwright

LIVE_URL = 'https://acrobat-shopzilla-classified-webmasters.trycloudflare.com'

viewports = [
    ('desktop_1920', 1920, 1080),
    ('desktop_1366', 1366, 768),
    ('desktop_1280', 1280, 800),
    ('tablet_768', 768, 1024),
    ('mobile_390', 390, 844)
]

with sync_playwright() as p:
    browser = p.chromium.launch()
    for name, w, h in viewports:
        context = browser.new_context(viewport={'width': w, 'height': h})
        page = context.new_page()
        page.goto(LIVE_URL, wait_until='domcontentloaded')
        page.click('#signinNav')
        page.wait_for_selector('input[type=email]', timeout=5000)
        page.fill('input[type=email]', 'admin@courseforge.com')
        page.fill('input[type=password]', 'password123')
        page.click('button[type=submit]')
        page.wait_for_selector('#streamingHero', timeout=15000)
        time.sleep(1)
        page.screenshot(path=f'/home/ubuntu/CourseForge/live_{name}.png')
        context.close()
    browser.close()
print('CAPTURED ALL')
