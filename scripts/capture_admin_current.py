import time
import requests
from playwright.sync_api import sync_playwright

HOST = 'acrobat-shopzilla-classified-webmasters.trycloudflare.com'
LIVE_URL = f'https://{HOST}'

resp = requests.post(f'{LIVE_URL}/api/auth/login', json={'email': 'admin@courseforge.com', 'password': 'password123'})
cf_session = resp.cookies.get_dict().get('cf_session')

tabs = [
    ('admin_overview', '#admin'),
    ('admin_students', '#admin/students'),
    ('admin_courses', '#admin/courses'),
    ('admin_player', '#admin/player'),
    ('admin_system', '#admin/system'),
]

with sync_playwright() as p:
    browser = p.chromium.launch()
    context = browser.new_context(viewport={'width': 1366, 'height': 768})
    context.add_cookies([{
        'name': 'cf_session',
        'value': cf_session,
        'domain': HOST,
        'path': '/',
        'secure': True,
        'httpOnly': True
    }])
    page = context.new_page()
    for name, route in tabs:
        page.goto(f'{LIVE_URL}/{route}', wait_until='domcontentloaded')
        time.sleep(2)
        page.screenshot(path=f'/home/ubuntu/CourseForge/{name}.png', full_page=True)
        print(f'Captured: {name}')
    browser.close()
print('DONE')
