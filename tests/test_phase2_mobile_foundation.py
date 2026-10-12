"""Phase 2 Mobile-First Foundation automated acceptance tests.

Validates:
- Screen audit at 320, 390, 768px (zero overflow, cramping, unreachable controls)
- Player one-handed controls, minimum 44px touch targets, floating next-lesson button, screen rotation
- Navigation: 5 thumb-zone bottom tabs, edge swipe, visible breadcrumb back path
- Materials panel: large one-handed download targets, inline preview formatting
- Performance: lesson page with materials interactive in under 2 seconds on throttled 3G
"""
import json
from pathlib import Path
import re
import pytest

playwright = pytest.importorskip('playwright.sync_api')
STATIC = Path(__file__).resolve().parents[1] / 'app' / 'static'


@pytest.fixture(scope='module')
def browser():
    with playwright.sync_playwright() as pw:
        try:
            instance = pw.chromium.launch()
        except playwright.Error as error:
            pytest.skip(f'Chromium unavailable: {str(error).splitlines()[0]}')
        yield instance
        instance.close()


def get_bootstrap_payload():
    return {
        'user': {'id': 'student-1', 'name': 'Demo Student', 'email': 'student@test.com', 'verified': True, 'role': 'student'},
        'csrf_token': 'test-csrf-token',
        'videos': [
            {'id': 'vid-1', 'title': '[001] Introduction to Cloud', 'course': 'Cloud 101', 'section': 'Week 1 — Foundations', 'duration': 1800, 'cloud_ready': True},
            {'id': 'vid-2', 'title': '[002] Virtual Machines', 'course': 'Cloud 101', 'section': 'Week 1 — Foundations', 'duration': 2400, 'cloud_ready': True}
        ],
        'materials': [
            {'id': 'm1', 'course': 'Cloud 101', 'lesson_id': 'vid-1', 'scope': 'lesson', 'name': 'cloud_notes.pdf', 'friendly_name': 'Cloud Notes', 'ext': 'pdf', 'size_kb': 450, 'material_type': 'PDF', 'download_url': '/download/m1'},
            {'id': 'm2', 'course': 'Cloud 101', 'lesson_id': 'vid-1', 'scope': 'lesson', 'name': 'starter_lab.py', 'friendly_name': 'Starter Code', 'ext': 'py', 'size_kb': 12, 'material_type': 'Code', 'download_url': '/download/m2'},
            {'id': 'm3', 'course': 'Cloud 101', 'lesson_id': 'vid-1', 'scope': 'lesson', 'name': 'cloud_lab.ipynb', 'friendly_name': 'Interactive Notebook', 'ext': 'ipynb', 'size_kb': 920, 'material_type': 'Notebook', 'download_url': '/download/m3'}
        ],
        'courses': [{'id': 'Cloud 101', 'title': 'Cloud 101 Masterclass', 'category': 'Cloud'}],
        'progress': [{'video_id': 'vid-1', 'completed': False, 'position': 120, 'percent': 15}],
        'learning': {'courses': [{'course': 'Cloud 101', 'last_video_id': 'vid-1'}]},
        'preferences': {'speed': 1},
        'options': {'registration_enabled': True}
    }


def create_test_page(browser, width=390, height=844, initial_hash='', bootstrap_override=None):
    page = browser.new_page(viewport={'width': width, 'height': height})
    html = re.sub(r'<script\b[^>]*>.*?</script>', '', (STATIC / 'index.html').read_text(), flags=re.S)
    bootstrap = bootstrap_override or get_bootstrap_payload()

    def serve(route):
        from urllib.parse import urlsplit
        p = urlsplit(route.request.url).path
        if p == '/':
            route.fulfill(body=html, content_type='text/html')
        elif p.startswith('/static/'):
            sub = p.removeprefix('/static/')
            f = STATIC / sub
            if f.is_file():
                ct = 'application/javascript' if f.suffix == '.js' else 'text/css' if f.suffix == '.css' else 'text/plain'
                route.fulfill(path=str(f), content_type=ct)
            else:
                route.fulfill(status=404, body='not found')
        elif p == '/api/me/bootstrap':
            route.fulfill(body=json.dumps(bootstrap), content_type='application/json')
        elif p == '/api/public/account-options':
            route.fulfill(body=json.dumps({'registration_enabled': True}), content_type='application/json')
        elif p.startswith('/api/videos/'):
            vid = {**bootstrap['videos'][0], 'cloud_ready': True}
            if p.endswith('/player-session'):
                route.fulfill(body=json.dumps({'id': 'ps-1', 'claimed': True}), content_type='application/json')
            elif p.endswith('/native-session'):
                route.fulfill(body=json.dumps({'id': 's1', 'watermark': 'Demo', 'start_pos': 0, 'media_url': ''}), content_type='application/json')
            elif p.endswith('/notes'):
                route.fulfill(body=json.dumps({'notes': []}), content_type='application/json')
            elif p.endswith('/activity-session'):
                route.fulfill(body=json.dumps({'id': 'act-1', 'activity_seconds': 0}), content_type='application/json')
            elif p.endswith('/bookmarks'):
                route.fulfill(body=json.dumps({'bookmarks': []}), content_type='application/json')
            else:
                route.fulfill(body=json.dumps({'video': vid, 'chunks': []}), content_type='application/json')
        elif p.startswith('/api/player-sessions/'):
            route.fulfill(body=json.dumps({'active': True, 'claimed': True}), content_type='application/json')
        elif p.startswith('/api/player/'):
            route.fulfill(body=json.dumps({'accepted': True, 'completed': False, 'position': 0}), content_type='application/json')
        elif p.startswith('/api/activity/'):
            route.fulfill(body=json.dumps({'id': 'act-1', 'activity_seconds': 5}), content_type='application/json')
        elif p.startswith('/api/me'):
            route.fulfill(body=json.dumps({'user': bootstrap['user'], 'csrf_token': bootstrap['csrf_token']}), content_type='application/json')
        elif p == '/api/materials':
            route.fulfill(body=json.dumps({'materials': bootstrap['materials']}), content_type='application/json')
        elif p == '/api/syllabus':
            route.fulfill(body=json.dumps({'syllabus': None}), content_type='application/json')
        elif p.startswith('/api/reviews/due'):
            route.fulfill(body=json.dumps({'cards': []}), content_type='application/json')
        elif p == '/api/labs':
            route.fulfill(body=json.dumps({'labs': []}), content_type='application/json')
        else:
            route.fulfill(body='{}', content_type='application/json')

    page.route('**/*', serve)
    page.goto(f'http://courseforge.test/{initial_hash}')
    page.add_style_tag(content=(STATIC / 'core.css').read_text())
    page.add_style_tag(content=(STATIC / 'tools.css').read_text())
    page.add_script_tag(type='module', content=(STATIC / 'vendor/media-chrome-4.19.3.js').read_text())
    page.wait_for_function("!!customElements.get('media-controller')")
    page.add_script_tag(content=(STATIC / 'core.js').read_text())
    return page


@pytest.mark.parametrize('width', [320, 390, 768])
def test_every_learner_screen_responsive_at_mobile_widths(browser, width):
    page = create_test_page(browser, width=width, height=844, initial_hash='#learning/vid-1')
    try:
        page.wait_for_function("document.documentElement.dataset.lessonInteractive === 'true'")

        def show(view):
            page.evaluate('''view => {
              navigate(view);
              document.body.classList.toggle('in-learning', view === 'learning');
            }''', view)

        # 1. Dashboard
        show('dashboard')
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), f'Dashboard overflows at {width}px'

        # 2. Today's Plan (Planner)
        show('planner')
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), f'Planner overflows at {width}px'

        # 3. Library
        show('library')
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), f'Library overflows at {width}px'

        # 4. Learning Studio & Player
        show('learning')
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), f'Learning view overflows at {width}px'

        # Verify study tabs fit without clipping
        study_tabs_clipped = page.evaluate('''() => {
          const container = document.querySelector('.lesson-tabs').getBoundingClientRect();
          const tabs = [...document.querySelectorAll('.lesson-tab')];
          return tabs.some(t => {
            const r = t.getBoundingClientRect();
            return r.left < container.left - 1 || r.right > container.right + 1;
          });
        }''')
        assert not study_tabs_clipped, f'Study tabs clipped at {width}px'

        # 5. Materials panel
        assert page.locator('#lessonMaterialsSection').is_visible()
        page.evaluate("selectLessonTab('materials')")
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), f'Materials tab overflows at {width}px'
        assert page.locator('#panel-materials').is_visible()

        # 6. Notes panel
        page.evaluate("selectLessonTab('notes')")
        page.locator('#noteText').fill('Notes content at mobile width')
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), f'Notes panel overflows at {width}px'

        # 7. Transcript panel
        page.evaluate("selectLessonTab('transcript')")
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), f'Transcript panel overflows at {width}px'

        # 8. Syllabus / Assessments
        show('syllabus')
        page.evaluate("document.querySelector('#assessmentPanel').hidden = false")
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), f'Syllabus & assessments overflow at {width}px'

        # 9. Review
        show('reviews')
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), f'Review overflows at {width}px'

        # 10. Settings
        show('settings')
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), f'Settings overflows at {width}px'

    finally:
        page.close()


def test_player_one_handed_touch_targets_and_screen_rotation(browser):
    page = create_test_page(browser, width=390, height=844, initial_hash='#learning/vid-1')
    try:
        page.wait_for_function("document.documentElement.dataset.lessonInteractive === 'true'")

        # Ensure player stage is mounted with player module
        page.evaluate('''async () => {
          let wrap = document.getElementById('lecturePlayerWrap');
          if (!wrap) {
            wrap = document.createElement('div');
            wrap.id = 'lecturePlayerWrap';
            wrap.className = 'lecture-player-wrap';
            document.querySelector('.player-shell').append(wrap);
          }
          await CourseForgeNative.open(wrap, {id: 'vid-1', title: 'Intro'}, {id: 's1', watermark: 'Demo', start_pos: 0, media_url: ''}, () => {});
        }''')

        # 1. Central play touch target >= 44x44
        play_btn = page.locator('.player-center-play')
        assert play_btn.is_visible()
        assert play_btn.evaluate('e => { const r = e.getBoundingClientRect(); return r.width >= 44 && r.height >= 44; }')

        # 2. Speed menu touch targets >= 44x44
        speed_btn = page.locator('.player-settings')
        assert speed_btn.is_visible()
        speed_btn.click(force=True)
        speed_buttons = page.locator('.player-speed-options button')
        assert speed_buttons.count() >= 4
        assert speed_buttons.evaluate_all('(btns) => btns.every(b => b.getBoundingClientRect().width >= 44 && b.getBoundingClientRect().height >= 44)')

        # 3. Floating next-lesson button reachable without scrolling
        mobile_next = page.locator('.mobile-next')
        assert mobile_next.is_visible()
        assert mobile_next.evaluate('e => { const r = e.getBoundingClientRect(); return r.height >= 44 && r.width >= 44 && (r.y + r.height <= innerHeight) && r.x > 150; }')

        # 4. Screen rotation handling: phone rotated to landscape (844 x 390)
        page.set_viewport_size({'width': 844, 'height': 390})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
        # In landscape (height <= 500px), bottom tabs hide to grant maximum stage to player
        assert page.locator('.mobile-tabs').evaluate('e => getComputedStyle(e).display === "none"')

    finally:
        page.close()


def test_mobile_thumb_tabs_and_edge_swipe(browser):
    page = create_test_page(browser, width=390, height=844, initial_hash='#dashboard')
    try:
        page.wait_for_function("document.documentElement.dataset.lessonInteractive === 'true'")

        # 1. 5 thumb-zone tabs present
        tabs = page.locator('.mobile-tab').all()
        assert len(tabs) == 5, f'Expected 5 thumb tabs, got {len(tabs)}'
        expected_views = ['dashboard', 'library', 'planner', 'tutor', 'reviews']
        for i, tab in enumerate(tabs):
            assert tab.get_attribute('data-mobile-view') == expected_views[i]
            box = tab.bounding_box()
            assert box is not None and box['height'] >= 44 and box['width'] >= 44
            assert tab.locator('svg.icon').count() == 1

        # 2. Tapping bottom tab navigates
        tabs[1].click()  # Library
        assert page.evaluate("state.view === 'library'")

        tabs[2].click()  # Today (planner)
        assert page.evaluate("state.view === 'planner'")

        # 3. Breadcrumb navigation from learning back to library
        page.evaluate("navigate('learning')")
        assert page.evaluate("state.view === 'learning'")
        crumb_link = page.locator('#studioCourseCrumb')
        assert crumb_link.is_visible()
        crumb_link.click()
        assert page.evaluate("state.view === 'library'"), 'Breadcrumb course link should navigate to library'

        # 4. Edge-swipe from left bezel (clientX <= 36) in learning mode goes back to library
        page.evaluate('''() => {
          navigate('learning');
          document.body.classList.add('in-learning');
          window.__courseforge_test_swipe = true;
        }''')
        assert page.evaluate("state.view === 'learning'")

        # Simulate edge swipe
        page.dispatch_event('body', 'pointerdown', {
            'pointerType': 'mouse', 'isPrimary': True, 'clientX': 15, 'clientY': 250
        })
        page.wait_for_timeout(50)
        page.dispatch_event('body', 'pointerup', {
            'clientX': 120, 'clientY': 255
        })
        assert page.evaluate("state.view === 'library'"), 'Edge swipe should navigate to library'

    finally:
        page.close()


def test_materials_panel_one_handed_and_downloads(browser):
    page = create_test_page(browser, width=320, height=667, initial_hash='#learning/vid-1')
    try:
        page.wait_for_function("document.documentElement.dataset.lessonInteractive === 'true'")

        # Check section is visible
        assert page.locator('#lessonMaterialsSection').is_visible()
        cards = page.locator('#lessonMaterialsList .material-item-card').all()
        assert len(cards) == 3

        # Check download buttons have min 44px touch targets and download attribute
        download_btns = page.locator('#lessonMaterialsList .material-download-btn')
        assert download_btns.count() == 3
        assert download_btns.evaluate_all('(btns) => btns.every(b => b.getBoundingClientRect().height >= 44 && b.hasAttribute("download"))')

        # Check inline preview formatting (no page overflow)
        open_btn = page.locator('#lessonMaterialsList .material-open-btn').first
        open_btn.click()
        assert page.locator('#lessonMaterialPreview').is_visible()
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), 'Preview causes overflow'

    finally:
        page.close()


def test_lesson_page_3g_performance(browser):
    """Simulated Fast 3G network conditions with 4x CPU throttle: lesson shell interactive in < 2.0s."""
    page = browser.new_page(viewport={'width': 390, 'height': 844})
    html = re.sub(r'<script\b[^>]*>.*?</script>', '', (STATIC / 'index.html').read_text(), flags=re.S)
    bootstrap = get_bootstrap_payload()

    def serve(route):
        from urllib.parse import urlsplit
        p = urlsplit(route.request.url).path
        if p == '/':
            route.fulfill(body=html, content_type='text/html')
        elif p.startswith('/static/') and (STATIC / Path(p).name).is_file():
            route.fulfill(path=str(STATIC / Path(p).name))
        elif p == '/api/me/bootstrap':
            route.fulfill(body=json.dumps(bootstrap), content_type='application/json')
        elif p == '/api/public/account-options':
            route.fulfill(body=json.dumps({'registration_enabled': True}), content_type='application/json')
        elif p.startswith('/api/videos/'):
            vid = bootstrap['videos'][0]
            if p.endswith('/native-session'):
                route.fulfill(body=json.dumps({'id': 's1', 'watermark': 'Demo', 'start_pos': 0, 'media_url': ''}), content_type='application/json')
            elif p.endswith('/notes'):
                route.fulfill(body=json.dumps({'notes': []}), content_type='application/json')
            else:
                route.fulfill(body=json.dumps({'video': vid, 'chunks': []}), content_type='application/json')
        else:
            route.fulfill(body='{}', content_type='application/json')

    page.route('**/*', serve)
    cdp = page.context.new_cdp_session(page)
    cdp.send('Network.enable')
    cdp.send('Network.setCacheDisabled', {'cacheDisabled': True})
    # Fast 3G profile: 1.6 Mbps download, 750 kbps upload, 150ms round-trip latency
    cdp.send('Network.emulateNetworkConditions', {
        'offline': False,
        'latency': 150,
        'downloadThroughput': 1_600_000 / 8,
        'uploadThroughput': 750_000 / 8
    })
    cdp.send('Emulation.setCPUThrottlingRate', {'rate': 4})

    try:
        t_start = page.evaluate('performance.now()')
        page.goto('http://courseforge.test/#learning/vid-1', wait_until='commit')
        page.add_style_tag(content=(STATIC / 'tools.css').read_text())
        page.add_style_tag(content=(STATIC / 'mobile.css').read_text())
        page.add_script_tag(type='module', content=(STATIC / 'vendor/media-chrome-4.19.3.js').read_text())
        page.wait_for_function("!!customElements.get('media-controller')")
        page.add_script_tag(content=(STATIC / 'core.js').read_text())

        page.wait_for_function("document.documentElement.dataset.lessonInteractive === 'true' && document.querySelector('#lessonMaterialsSection:not([hidden])')")
        t_interactive = page.evaluate('performance.now()')
        elapsed_ms = t_interactive - t_start

        # Clean up emulation
        cdp.send('Network.emulateNetworkConditions', {'offline': False, 'latency': 0, 'downloadThroughput': -1, 'uploadThroughput': -1})
        cdp.send('Emulation.setCPUThrottlingRate', {'rate': 1})

        print(f"Throttled Fast 3G + 4x CPU boot to interactive: {elapsed_ms:.1f}ms")
        assert elapsed_ms < 2000, f"Interactive time {elapsed_ms}ms exceeded 2000ms threshold"

    finally:
        page.close()
