"""Populated UI geometry and negative regressions for the release gate."""
from pathlib import Path
import os
import pytest
from scripts.audit_ui import audit, scan_css, scan_markup, evaluate_evidence

ROOT=Path(__file__).resolve().parents[1]


def test_shipped_ui_uses_tokens_and_current_bundles():
    assert audit(ROOT)==[]


@pytest.mark.parametrize('source',[
    '.btn { color: #123456; }', '.panel { padding: 13px; }',
    '.field { font-size: .9rem; }', '.chip { background: rgba(0,0,0,.3); }',
])
def test_css_guard_rejects_ad_hoc_presentation(source):
    assert scan_css(source,'feature.css')


@pytest.mark.parametrize('source',[
    'button.style.cssText="padding:12px";', '<button style="color:red">Save</button>',
    'button.style.padding="12px";',
    '<button>🔒 Lock</button>',
])
def test_markup_guard_rejects_inline_presentation_and_emoji(source):
    assert scan_markup(source,'feature.js')


def test_data_driven_artwork_and_progress_are_allowed():
    assert not scan_markup('<div style="width: ${percent}%"></div>','feature.js')
    assert not scan_css('.panel { padding: var(--space-4); }','feature.css')


def test_full_evidence_gate_rejects_missing_capture(tmp_path):
    assert evaluate_evidence(tmp_path)


@pytest.mark.parametrize('theme,accent,studio',[
    ('light','indigo',False),('dark','indigo',False),('light','teal',False),
    ('dark','rose',False),('light','indigo',True),('dark','indigo',True),
])
def test_control_text_stays_readable_across_themes(ui_browser,theme,accent,studio):
    page=ui_browser.new_page()
    try:
        page.set_content('<a class="lesson-link active" href="#">Selected lesson</a><button class="lesson-tab active">Lessons</button><button class="btn btn-primary">Sign in</button>')
        page.add_style_tag(content=(ROOT/'app/static/core.css').read_text())
        page.add_script_tag(content=(ROOT/'app/static/components.js').read_text())
        page.evaluate('([theme,accent,studio])=>{document.documentElement.dataset.theme=theme;document.documentElement.dataset.accent=accent;document.body.classList.toggle("in-learning",studio)}',[theme,accent,studio])
        page.wait_for_timeout(250)
        ratios=page.locator('a,button').evaluate_all('''elements=>{
          const rgb=s=>{const values=(s.match(/[\\d.]+/g)||[]).map(Number);return s.startsWith('color(srgb')?values.map((n,i)=>i<3?n*255:n):values;};
          const luminance=c=>c.slice(0,3).map(n=>{n/=255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4}).reduce((v,n,i)=>v+n*[.2126,.7152,.0722][i],0);
          return elements.map(e=>{const s=getComputedStyle(e),a=luminance(rgb(s.color)),b=luminance(rgb(s.backgroundColor));return (Math.max(a,b)+.05)/(Math.min(a,b)+.05)});
        }''')
        assert min(ratios)>=4.5,ratios
    finally:page.close()


@pytest.fixture(scope='module')
def ui_browser():
    api=pytest.importorskip('playwright.sync_api')
    with api.sync_playwright() as pw:
        try:browser=pw.chromium.launch()
        except api.Error as error:
            if os.environ.get('COURSEFORGE_REQUIRE_BROWSERS'):pytest.fail(str(error))
            pytest.skip('Chromium unavailable')
        yield browser
        browser.close()


@pytest.mark.parametrize('width',[320,390])
def test_phone_focus_controls_remain_clickable_after_start(ui_browser,width,tmp_path):
    import json
    from test_phase2_mobile_foundation import create_test_page
    page=create_test_page(ui_browser,width=width,height=900)
    session={'id':'focus-ui','status':'running','mode':'focus','title':'Independent focus',
             'duration_seconds':1500,'remaining_seconds':1500}
    def serve(route):
        path=route.request.url.split('/api/focus/',1)[1]
        if path.startswith('analytics'):
            payload={'days':[{'planned_minutes':0,'measured_minutes':0} for _ in range(7)],
                     'planned_minutes':0,'self_reported_minutes':0,'measured_minutes':0,'active_days':0}
        elif path.startswith('history'):payload={'sessions':[]}
        elif path.startswith('active'):payload={'session':None}
        elif path.endswith('/actions'):
            session['status']=json.loads(route.request.post_data)['action']+'d'
            payload=session
        else:payload=session
        route.fulfill(json=payload)
    page.route('**/api/focus/**',serve)
    try:
        page.wait_for_function('window.CourseForgeReady===true')
        page.evaluate('CourseForgeLoadTools();navigate("planner")')
        page.locator('#focusStart').click()
        page.wait_for_selector('#focusPause:not([hidden])')
        page.locator('.focus-studio').scroll_into_view_if_needed()
        page.screenshot(path=str(tmp_path/'focus-running.png'))
        # Moving to the bottom edge must not start a hover/leave movement loop.
        box=page.locator('#focusPause').bounding_box()
        page.mouse.move(box['x']+box['width']/2,box['y']+box['height']-.5)
        page.wait_for_timeout(200)
        page.locator('#focusPause').click(timeout=2000)
        page.wait_for_selector('#focusResume:not([hidden])')
    finally:page.close()


def test_native_player_icons_use_existing_shared_sprite(ui_browser):
    from test_phase2_mobile_foundation import create_test_page
    page=create_test_page(ui_browser,initial_hash='#learning/vid-1')
    try:
        page.wait_for_function('document.documentElement.dataset.lessonInteractive==="true"')
        page.evaluate('''async()=>{
          const wrap=document.createElement('div');document.querySelector('.player-shell').append(wrap);
          await CourseForgeNative.open(wrap,{id:'vid-1',title:'Icon contract'},
            {id:'icon-ui',watermark:'Test learner',start_pos:0,media_url:''},()=>{});
          CourseForgeComponents.apply(document);
        }''')
        controls=page.locator('media-play-button,media-mute-button,media-seek-backward-button,media-seek-forward-button,media-fullscreen-button')
        assert controls.count()>=5
        for control in controls.all():
            assert control.locator('svg[slot] use').count()
            assert control.locator('svg[slot] use').evaluate_all('nodes=>nodes.every(e=>document.querySelector(e.getAttribute("href")))')
    finally:page.close()


@pytest.mark.parametrize('width',[320,390,768,1366,1920])
def test_populated_views_have_no_overflow_and_cards_fill_rows(ui_browser,width):
    from test_phase2_mobile_foundation import create_test_page, get_bootstrap_payload
    payload=get_bootstrap_payload()
    payload['courses']=[];payload['videos']=[];payload['progress']=[]
    for index in range(8):
        name=f'Course {index+1}'
        payload['courses'].append({'id':name,'title':name+' — A complete course with a longer title',
                                   'category':['Engineering','Data Engineering','Architecture and Distributed Systems Foundations'][index%3]})
        payload['videos'].append({'id':f'video-{index}','title':'[001] Foundations and worked examples',
                                  'course':name,'duration':1200,'cloud_ready':True})
        payload['progress'].append({'video_id':f'video-{index}','completed':False,'position':120,'percent':10})
    payload['materials']=[]
    page=create_test_page(ui_browser,width=width,bootstrap_override=payload)
    try:
        page.wait_for_function("window.CourseForgeReady===true")
        page.evaluate('CourseForgeLoadTools()')
        page.add_script_tag(content=(ROOT/'scripts/ui_geometry.js').read_text())
        for view in ('library','settings','syllabus','labs','planner','tutor','reviews'):
            page.evaluate('view=>navigate(view)',view)
            page.wait_for_timeout(100)
            page.evaluate('CourseForgeComponents.apply(document)')
            result=page.evaluate('CourseForgeUIAudit()')
            for key in ('overflow','clipped','gridFailures','unmapped','badIcons'):
                assert not result[key],f'{width}px {view} {key}: {result[key]}'
            assert result['documentWidth']<=width+1
            if view=='library':
                assert page.locator('#courseCatalog .course-tile').count()==8
                grid=next(g for g in result['grids'] if g['selector']=='#courseCatalog')
                assert len(grid['columns'].split())=={320:1,390:1,768:3,1366:4,1920:6}[width]
        page.evaluate('window.scrollTo(0,500)')
        assert page.locator('.topbar').evaluate('(e)=>e.getBoundingClientRect().top<=1'), 'Workspace header floats over scrolled content'
        # A deliberate overflow hidden by the page's CSS must still fail.
        page.evaluate("const e=document.createElement('button');e.textContent='Overflow probe';e.style.width='2500px';e.style.maxWidth='none';document.querySelector('#pageContent').append(e)")
        assert page.evaluate('CourseForgeUIAudit().overflow.length')>0
    finally:page.close()
