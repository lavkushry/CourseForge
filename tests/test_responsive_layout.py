"""Browser geometry checks against the shipped HTML and styles.

Requires Playwright and its Chromium binary; skipped when unavailable. No server,
provider credentials, production records, or generated course data are needed.
"""
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


@pytest.mark.parametrize('width', [320, 390, 768, 1024, 1366])
def test_workspace_controls_fit_their_containers(browser, width):
    page = browser.new_page(viewport={'width': width, 'height': 600})
    html = re.sub(r'<script\b[^>]*>.*?</script>', '', (STATIC / 'index.html').read_text(), flags=re.S)

    def serve(route):
        from urllib.parse import urlsplit
        path = urlsplit(route.request.url).path
        if path == '/':
            route.fulfill(body=html, content_type='text/html')
        elif path.startswith('/static/') and (STATIC / Path(path).name).is_file():
            route.fulfill(path=str(STATIC / Path(path).name))
        else:
            route.abort()

    page.route('**/*', serve)
    try:
        page.goto('http://courseforge.test/')
        page.evaluate('''() => {
          document.querySelector('#academyContent').hidden=true;
          document.querySelector('#appShell').hidden=false;
          for(const id of ['learningNav','adminNav','accountNav','logoutNav'])document.getElementById(id).hidden=false;
          document.querySelector('#signinNav').hidden=true;
          document.querySelector('#accountName').textContent='Administrator';
        }''')
        failures = []

        def check(label, expression):
            if not page.evaluate(expression):
                failures.append(label)

        def show(view):
            page.evaluate('''view => {
              document.querySelectorAll('[data-view]').forEach(e=>e.hidden=e.dataset.view!==view);
              document.body.classList.toggle('in-learning',view==='learning');
            }''', view)

        show('library')
        check('library controls overflow the page', 'document.documentElement.scrollWidth <= innerWidth+1')
        check('library selects exceed the content area', '''() => {
          const container=document.querySelector('.library-controls').getBoundingClientRect();
          return [...document.querySelectorAll('.library-controls select')].every(e=>{
            const r=e.getBoundingClientRect();return r.left>=container.left-1&&r.right<=container.right+1;
          });
        }''')
        # Audit the other learner screens, including the full planner and
        # question form rather than only an empty lesson panel.
        page.add_style_tag(content=(STATIC / 'tools.css').read_text())
        for view in ['dashboard', 'planner', 'syllabus', 'reviews', 'settings']:
            show(view)
            if view == 'syllabus':
                page.evaluate("document.querySelector('#assessmentPanel').hidden=false")
            check(f'{view} overflows the phone', 'document.documentElement.scrollWidth <= innerWidth+1')
        show('learning')
        page.evaluate("document.querySelector('#noteText').value='A longer note about this lesson and the next steps to practice.'")
        check('learning view overflows the page', 'document.documentElement.scrollWidth <= innerWidth+1')
        check('empty-player actions are clipped', '''() => {
          const shell=document.querySelector('.player-shell').getBoundingClientRect();
          return [...document.querySelectorAll('#emptyPlayer > *')].every(e=>{
            const r=e.getBoundingClientRect();return r.bottom<=shell.bottom+1;
          });
        }''')
        check('study tabs are clipped', '''() => {
          const container=document.querySelector('.lesson-tabs').getBoundingClientRect();
          return [...document.querySelectorAll('.lesson-tab')].every(e=>{
            const r=e.getBoundingClientRect();return r.left>=container.left-1&&r.right<=container.right+1;
          });
        }''')
        # Generate the native stage and toolbar with the actual player module.
        # Only its network service is stubbed; it cannot write learner events.
        page.evaluate('''() => {
          window.state={progress:new Map()};window.prettyTime=()=> '00:00:00';window.toast=()=>{};
          window.CourseForgeServices={request:async()=>({accepted:false}),json:()=>({})};
          window.CourseForgeAccount={csrf:''};
          window.CourseForgePlayerSession={isOwner:()=>false,preferences:()=>({speed:1})};
          document.querySelector('#emptyPlayer').hidden=true;
          const wrap=document.createElement('div');wrap.id='lecturePlayerWrap';wrap.className='lecture-player-wrap';
          document.querySelector('.player-shell').append(wrap);
        }''')
        page.add_script_tag(content=(STATIC / 'player-tracking.js').read_text())
        page.add_script_tag(content=(STATIC / 'player-recovery.js').read_text())
        page.add_script_tag(type='module',content=(STATIC / 'vendor/media-chrome-4.19.3.js').read_text())
        page.wait_for_function("!!customElements.get('media-controller')")
        page.add_script_tag(content=(STATIC / 'native-player.js').read_text())
        page.evaluate('''async () => {
          const wrap=document.querySelector('#lecturePlayerWrap');
          await CourseForgeNative.open(wrap,{id:'layout-only',title:'Layout check'},
            {id:'layout-only',watermark:'Layout check',start_pos:0,media_url:''},()=>{});

        }''')
        check('native-player toolbar is clipped', '''() => {
          const shell=document.querySelector('.player-shell').getBoundingClientRect();
          const tools=document.querySelector('.native-controls').getBoundingClientRect();
          return tools.bottom<=shell.bottom+1;
        }''')
        check('native video loses its aspect ratio', '''() => {
          const stage=document.querySelector('.native-player-stage').getBoundingClientRect();
          return Math.abs(stage.width/stage.height-16/9)<.02;
        }''')
        if width <= 768:
            # A visible central Play button must receive a real touch; the
            # timeline must not cover it on the shortest portrait stages.
            page.locator('.player-center-play').click()
        if width==390:
            # Moving focus between speed choices must not dismiss the menu
            # before the pointer click reaches the selected button.
            page.get_by_role('button',name='Playback speed',exact=True).click()
            page.locator('.player-speed-options button[data-rate="1.5"]').click()
            assert page.evaluate('CourseForgeNative.video().playbackRate')==1.5
            assert page.locator('.player-speed-menu').evaluate('(e)=>e.hidden')
            # The real controls must lock for touch and remain unlockable from
            # a keyboard. A brief accidental touch cannot unlock playback.
            page.locator('[aria-label="Lock player controls"]').click()
            assert page.evaluate('CourseForgeNative.locked()')
            assert page.locator('.native-controls').evaluate('(e)=>e.inert')
            box=page.locator('.player-unlock').bounding_box()
            page.mouse.move(box['x']+10,box['y']+10)
            page.mouse.down()
            page.wait_for_timeout(200)
            page.mouse.up()
            assert page.evaluate('CourseForgeNative.locked()')
            page.keyboard.press('Escape')
            assert not page.evaluate('CourseForgeNative.locked()')
            page.locator('.native-player-stage').focus()
            page.keyboard.press('l')
            assert page.evaluate('CourseForgeNative.locked()')
            page.keyboard.press('Enter')
            assert not page.evaluate('CourseForgeNative.locked()')
        assert not failures, f'{width}px: ' + '; '.join(failures)
    finally:
        page.close()
