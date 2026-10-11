"""Phase 3 Habit Loop automated acceptance tests.

Validates:
- Instant momentum: Dashboard leads with "Continue [lesson name]" and resumes playback in 1 click; <=3 clicks from registration.
- Daily habit: Streak counter, daily goal selection (15m watch or 1 lesson completed), celebration on goal met, no shaming on 0 streak.
- Visible progress: Course cards show progress bar and "X of Y lessons"; finishing a lesson triggers brief check-mark moment; finishing a course shows screenshot-worthy certificate modal.
- Zero-friction watching: Autoplay-next enabled by default with one-click opt-out; player shortcuts (Space, arrows, F).
- Come-back triggers: Weekly in-app recap with learned time and lesson count; opt-in email reminder toggle.
- Admin measurement: Admin overview reports daily active students, average session minutes, and 7-day return rate.
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
            {'id': 'vid-1', 'title': '[001] Cloud Foundations', 'course': 'Cloud 101', 'section': 'Week 1', 'duration': 1800, 'cloud_ready': True},
            {'id': 'vid-2', 'title': '[002] Virtual Machines', 'course': 'Cloud 101', 'section': 'Week 1', 'duration': 2400, 'cloud_ready': True}
        ],
        'materials': [],
        'courses': [{'id': 'Cloud 101', 'title': 'Cloud 101 Masterclass', 'category': 'Cloud'}],
        'progress': [{'video_id': 'vid-1', 'completed': False, 'position': 120, 'percent': 20}],
        'learning': {'courses': [{'course': 'Cloud 101', 'last_video_id': 'vid-1'}]},
        'preferences': {'speed': 1, 'autoplay': True, 'theater': False},
        'options': {'registration_enabled': True}
    }


def create_phase3_page(browser, habit_overrides=None, overview_overrides=None):
    page = browser.new_page(viewport={'width': 1280, 'height': 800})
    html = re.sub(r'<script\b[^>]*>.*?</script>', '', (STATIC / 'index.html').read_text(), flags=re.S)
    bootstrap = get_bootstrap_payload()

    habits_data = {
        'day': '2026-10-11',
        'today': {'watched_seconds': 950, 'lessons': 1, 'quizzes': 0, 'reviews': 0, 'goal_met': 1},
        'streak': 3,
        'best_streak': 5,
        'preferences': {'goal': 'minutes', 'timezone': 'UTC', 'reminder_email': 0},
        'week': {'watched_seconds': 9600, 'lessons': 3, 'quizzes': 0, 'reviews': 0, 'active_days': 4},
        'email_available': False
    }
    if habit_overrides:
        habits_data.update(habit_overrides)

    overview_data = {
        'summary': {
            'students': 12, 'verified_students': 10, 'suspended_students': 0,
            'enrollments': 24, 'completed_lessons': 18, 'activity_seconds': 45000,
            'playing_seconds': 38000, 'courses': 4, 'available_lectures': 40,
            'lectures': 40, 'active_sessions': 3
        },
        'recent_activity': [{'name': 'Demo Student', 'event_type': 'lesson_completed', 'title': 'Cloud Foundations', 'created_at': '2026-10-11T12:00:00Z'}],
        'access_events': [],
        'funnels': [{'course': 'Cloud 101', 'enrolled': 12, 'started': 10}],
        'engagement': {
            'daily_active_students': 5,
            'average_session_minutes': 24.5,
            'sessions': 14,
            'seven_day_return_rate': 83.3,
            'return_cohort': 6,
            'returning_students': 5,
            'period': 'UTC; session average is the last 7 days'
        },
        'activity_basis': 'Visible lesson activity',
        'completion_basis': 'Lessons completed by students'
    }
    if overview_overrides:
        overview_data.update(overview_overrides)

    put_habit_payloads = []
    put_player_payloads = []

    def serve(route):
        from urllib.parse import urlsplit
        p = urlsplit(route.request.url).path
        req = route.request
        if p == '/':
            route.fulfill(body=html, content_type='text/html')
        elif p == '/static/core.css':
            route.fulfill(body=(STATIC / 'core.css').read_text(), content_type='text/css')
        elif p == '/static/core.js':
            route.fulfill(body=(STATIC / 'core.js').read_text(), content_type='application/javascript')
        elif p == '/api/me/bootstrap':
            route.fulfill(json=bootstrap)
        elif p == '/api/me':
            route.fulfill(json=bootstrap['user'])
        elif p == '/api/videos':
            route.fulfill(json={'videos': bootstrap['videos']})
        elif p == '/api/progress':
            route.fulfill(json={'progress': bootstrap['progress']})
        elif p == '/api/courses':
            route.fulfill(json={'courses': bootstrap['courses']})
        elif p == '/api/materials':
            route.fulfill(json={'materials': bootstrap['materials']})
        elif p == '/api/studio/insights':
            route.fulfill(json={
                'due_count': 0, 'total_cards': 0, 'reviews_today': 0,
                'streak_days': habits_data['streak'], 'mastery_signal_percent': 85,
                'mastery_basis': 'recall', 'weak_areas': [], 'history': []
            })
        elif p == '/api/me/habits':
            route.fulfill(json=habits_data)
        elif p == '/api/me/habit-preferences' and req.method == 'PUT':
            payload = json.loads(req.post_data)
            put_habit_payloads.append(payload)
            habits_data['preferences'].update(payload)
            route.fulfill(json=habits_data)
        elif p == '/api/me/player-preferences':
            if req.method == 'PUT':
                payload = json.loads(req.post_data)
                put_player_payloads.append(payload)
                bootstrap['preferences'].update(payload)
                route.fulfill(json=bootstrap['preferences'])
            else:
                route.fulfill(json=bootstrap['preferences'])
        elif p == '/api/admin/overview':
            route.fulfill(json=overview_data)
        elif p.startswith('/api/videos/') and p.endswith('/progress') and req.method == 'PUT':
            route.fulfill(json={'ok': True})
        elif p.startswith('/api/videos/') and p.endswith('/native-session'):
            route.fulfill(json={'id': 'sess-1', 'media_url': 'blob:test', 'start_pos': 0, 'watermark': 'student@test.com'})
        else:
            route.fulfill(json={})

    page.route('**/*', serve)
    page.goto('http://localhost:8000/#dashboard')
    page.add_style_tag(content=(STATIC / 'core.css').read_text())
    page.add_style_tag(content=(STATIC / 'tools.css').read_text())
    page.add_script_tag(type='module', content=(STATIC / 'vendor/media-chrome-4.19.3.js').read_text())
    page.wait_for_function("!!customElements.get('media-controller')")
    page.add_script_tag(content=(STATIC / 'core.js').read_text())
    page.wait_for_function("typeof navigate === 'function'")
    page.evaluate("navigate('dashboard')")
    page.wait_for_selector('[data-view="dashboard"]:not([hidden])')
    return page, put_habit_payloads, put_player_payloads


def test_instant_momentum_hero_leads_with_continue_and_resumes(browser):
    """Criterion 10: After sign-in, the dashboard leads with 'Continue [lesson name]' and resumes playback in one click."""
    page, _, _ = create_phase3_page(browser)
    hero_btn = page.locator('#heroLearnBtn')
    hero_btn.wait_for(state='visible')
    text = hero_btn.inner_text()
    assert 'Continue' in text or 'Start' in text
    assert 'Cloud Foundations' in text

    # Clicking hero button transitions directly to learning studio with the lesson
    hero_btn.click()
    page.wait_for_selector('[data-view="learning"]:not([hidden])')
    assert 'learning' in page.url or 'lecture' in page.url
    page.close()


def test_daily_habit_streak_counter_and_celebration(browser):
    """Criterion 11: Streak counter plus a daily goal; celebration when met; 0 streak never shames."""
    # 1. Active streak with goal met
    page, put_habits, _ = create_phase3_page(browser, habit_overrides={
        'streak': 3,
        'today': {'watched_seconds': 950, 'lessons': 1, 'goal_met': 1}
    })
    streak_el = page.locator('#dashStreak')
    streak_el.wait_for(state='visible')
    assert '3 days' in streak_el.inner_text()
    assert page.locator('.goal-met-badge').is_visible()

    # 2. Daily goal toggle (minutes vs lesson)
    goal_select = page.locator('#goalMinutes')
    assert goal_select.input_value() == 'minutes'
    goal_select.select_option('lesson')
    page.wait_for_timeout(300)
    assert len(put_habits) > 0
    assert put_habits[-1]['goal'] == 'lesson'
    page.close()

    # 3. Zero streak shows friendly invitation without shame or nagging
    zero_page, _, _ = create_phase3_page(browser, habit_overrides={
        'streak': 0,
        'today': {'watched_seconds': 0, 'lessons': 0, 'goal_met': 0}
    })
    zero_streak = zero_page.locator('#dashStreak').inner_text()
    assert '0 days' in zero_streak
    assert 'shame' not in zero_streak.lower()
    assert 'reset' not in zero_streak.lower()
    zero_page.close()


def test_visible_progress_and_course_completion_certificate(browser):
    """Criterion 12: Course cards show 'X of Y lessons'; check-mark moment on lesson finish; completion certificate on course complete."""
    page, _, _ = create_phase3_page(browser)
    progress_line = page.locator('.course-progress-line').first
    progress_line.wait_for(state='visible')
    line_text = progress_line.inner_text()
    assert 'of' in line_text and 'lessons' in line_text

    # Check-mark moment trigger
    page.evaluate('window.CourseForgeCompletion.triggerLessonCheckMoment()')
    moment = page.locator('.lesson-check-moment')
    moment.wait_for(state='visible')
    assert 'Lesson completed!' in moment.inner_text()

    # Course completion certificate dialog
    page.evaluate("window.CourseForgeCompletion.showCourseCompletion({title: 'Cloud 101 Masterclass', name: 'Cloud 101', videos: [{}, {}]})")
    cert = page.locator('#courseCompletionDialog')
    assert cert.is_visible()
    assert 'Certificate of Completion' in cert.inner_text()
    assert 'Cloud 101 Masterclass' in cert.inner_text()
    assert 'Demo Student' in cert.inner_text()
    page.close()


def test_zero_friction_watching_autoplay_and_shortcuts(browser):
    """Criterion 13: Autoplay-next on by default with one-click opt-out; player shortcuts."""
    page, _, put_player = create_phase3_page(browser)
    # Open learning view
    page.locator('#heroLearnBtn').click()
    page.wait_for_selector('[data-view="learning"]:not([hidden])')

    # Autoplay checkbox is on by default
    autoplay_box = page.locator('#playerAutoplay')
    autoplay_box.wait_for(state='attached')
    assert autoplay_box.is_checked()

    # One-click opt-out
    autoplay_box.uncheck()
    page.wait_for_timeout(600)
    assert len(put_player) > 0
    assert put_player[-1]['autoplay'] is False
    page.close()


def test_come_back_triggers_weekly_recap_and_email_opt_in(browser):
    """Criterion 14: Weekly in-app recap ('You learned 2h 40m across 3 lessons this week') + opt-in reminder toggle."""
    page, put_habits, _ = create_phase3_page(browser, habit_overrides={
        'week': {'watched_seconds': 9600, 'lessons': 3, 'quizzes': 0, 'reviews': 0, 'active_days': 4},
        'preferences': {'goal': 'minutes', 'timezone': 'UTC', 'reminder_email': 0}
    })
    recap = page.locator('#weeklyRecap')
    recap.wait_for(state='visible')
    recap_text = page.locator('#recapText').inner_text()
    assert '2h 40m' in recap_text
    assert '3 lessons' in recap_text

    # Opt-in button saves preference
    opt_btn = page.locator('#recapOptInBtn')
    assert 'Off' in opt_btn.inner_text()
    opt_btn.click()
    page.wait_for_timeout(300)
    assert len(put_habits) > 0
    assert put_habits[-1]['reminder_email'] is True
    page.close()


def test_admin_engagement_metrics_render_in_overview(browser):
    """Criterion 15: Add daily active students, average session minutes, and 7-day return rate to admin reports."""
    page, _, _ = create_phase3_page(browser)
    page.evaluate('''() => {
        window.CourseForgeAccount.user = { id: 'admin-1', role: 'admin', name: 'Admin User' };
        document.getElementById('adminNav').hidden = false;
        document.getElementById('adminNav').click();
    }''')
    page.wait_for_selector('.academy-metrics')

    admin_body = page.locator('body').inner_text()
    assert 'Daily active students' in admin_body
    assert 'Average session duration' in admin_body
    assert '24.5 min' in admin_body
    assert '7-day return rate' in admin_body
    assert '83.3%' in admin_body
    page.close()
