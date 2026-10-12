import time
import requests
from playwright.sync_api import sync_playwright

BASE_URL = 'http://127.0.0.1:8000'

# Authenticate admin
resp = requests.post(f'{BASE_URL}/api/auth/login', json={'email': 'admin@courseforge.com', 'password': 'password123'})
data = resp.json()
cf_session = resp.cookies.get_dict().get('cf_session')
assert cf_session, f'Session cookie missing: {data}'
print('Logged in as admin. Session cookie acquired.')

with sync_playwright() as p:
    browser = p.chromium.launch()

    # Desktop 1366x768
    context = browser.new_context(viewport={'width': 1366, 'height': 768})
    context.add_cookies([{
        'name': 'cf_session',
        'value': cf_session,
        'domain': '127.0.0.1',
        'path': '/',
        'httpOnly': True
    }])

    page = context.new_page()

    # 1. Overview
    page.goto(f'{BASE_URL}/#admin', wait_until='networkidle')
    time.sleep(2)
    page.screenshot(path='/home/ubuntu/CourseForge/admin_overview.png', full_page=True)
    print('1. Captured admin_overview.png')

    # 2. Students
    page.click('.admin-navigation button:has-text("Students")')
    time.sleep(2)
    page.screenshot(path='/home/ubuntu/CourseForge/admin_students.png', full_page=True)
    print('2. Captured admin_students.png')

    # 3. Courses
    page.click('.admin-navigation button:has-text("Courses")')
    time.sleep(2)
    page.screenshot(path='/home/ubuntu/CourseForge/admin_courses.png', full_page=True)
    print('3. Captured admin_courses.png')

    # 4. Player activity
    page.click('.admin-navigation button:has-text("Player activity")')
    time.sleep(2)
    page.screenshot(path='/home/ubuntu/CourseForge/admin_player.png', full_page=True)
    print('4. Captured admin_player.png')

    # 5. System & audit
    page.click('.admin-navigation button:has-text("System & audit")')
    time.sleep(2)
    page.screenshot(path='/home/ubuntu/CourseForge/admin_system.png', full_page=True)
    print('5. Captured admin_system.png')

    # 6. Course detail inspection
    page.click('.admin-navigation button:has-text("Courses")')
    time.sleep(2)
    first_drill = page.query_selector('.admin-course-drill')
    if first_drill:
        first_drill.click()
        time.sleep(2)
        page.screenshot(path='/home/ubuntu/CourseForge/admin_course_detail.png', full_page=True)
        print('6. Captured admin_course_detail.png')

    # 7. Student detail inspection
    page.click('.admin-navigation button:has-text("Students")')
    time.sleep(2)
    first_inspect = page.query_selector('.academy-table button:has-text("Inspect")')
    if first_inspect:
        first_inspect.click()
        time.sleep(2)
        page.screenshot(path='/home/ubuntu/CourseForge/admin_student_detail.png', full_page=True)
        print('7. Captured admin_student_detail.png')

    context.close()

    # Mobile 390x844
    mobile_ctx = browser.new_context(viewport={'width': 390, 'height': 844})
    mobile_ctx.add_cookies([{
        'name': 'cf_session',
        'value': cf_session,
        'domain': '127.0.0.1',
        'path': '/',
        'httpOnly': True
    }])
    mpage = mobile_ctx.new_page()

    mpage.goto(f'{BASE_URL}/#admin', wait_until='networkidle')
    time.sleep(2)
    mpage.screenshot(path='/home/ubuntu/CourseForge/admin_overview_mobile.png')
    print('8. Captured admin_overview_mobile.png')

    mpage.click('.admin-navigation button:has-text("Courses")')
    time.sleep(2)
    mpage.screenshot(path='/home/ubuntu/CourseForge/admin_courses_mobile.png')
    print('9. Captured admin_courses_mobile.png')

    mobile_ctx.close()
    browser.close()

print('ALL ADMIN REDESIGN SCREENSHOTS CAPTURED SUCCESSFULLY!')
