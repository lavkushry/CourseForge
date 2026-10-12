import time
import requests
from playwright.sync_api import sync_playwright

HOST = 'acrobat-shopzilla-classified-webmasters.trycloudflare.com'
LIVE_URL = f'https://{HOST}'

resp = requests.post(f'{LIVE_URL}/api/auth/login', json={'email': 'admin@courseforge.com', 'password': 'password123'})
cf_session = resp.cookies.get_dict().get('cf_session')
assert cf_session, 'Session cookie missing'

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
    page.goto(f'{LIVE_URL}/#admin', wait_until='domcontentloaded')
    time.sleep(3)
    page.screenshot(path='/home/ubuntu/CourseForge/admin_overview.png', full_page=True)
    print('Captured admin_overview')

    # Students
    page.click('.admin-navigation button:has-text("Students")')
    time.sleep(2)
    page.screenshot(path='/home/ubuntu/CourseForge/admin_students.png', full_page=True)
    print('Captured admin_students')

    # Courses
    page.click('.admin-navigation button:has-text("Courses")')
    time.sleep(2)
    page.screenshot(path='/home/ubuntu/CourseForge/admin_courses.png', full_page=True)
    print('Captured admin_courses')

    # Player activity
    page.click('.admin-navigation button:has-text("Player activity")')
    time.sleep(2)
    page.screenshot(path='/home/ubuntu/CourseForge/admin_player.png', full_page=True)
    print('Captured admin_player')

    # System & audit
    page.click('.admin-navigation button:has-text("System & audit")')
    time.sleep(2)
    page.screenshot(path='/home/ubuntu/CourseForge/admin_system.png', full_page=True)
    print('Captured admin_system')

    # Course detail inspection
    page.click('.admin-navigation button:has-text("Courses")')
    time.sleep(2)
    first_drill = page.query_selector('.admin-course-drill')
    if first_drill:
        first_drill.click()
        time.sleep(3)
        page.screenshot(path='/home/ubuntu/CourseForge/admin_course_detail.png', full_page=True)
        print('Captured admin_course_detail')

    # Student detail inspection
    page.click('.admin-navigation button:has-text("Students")')
    time.sleep(2)
    first_inspect = page.query_selector('.academy-table button:has-text("Inspect")')
    if first_inspect:
        first_inspect.click()
        time.sleep(3)
        page.screenshot(path='/home/ubuntu/CourseForge/admin_student_detail.png', full_page=True)
        print('Captured admin_student_detail')

    browser.close()
print('ALL ADMIN CAPTURES FINISHED')
