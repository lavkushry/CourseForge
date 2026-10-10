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
            }''', view)

        show('library')
        check('library controls overflow the page', 'document.documentElement.scrollWidth <= innerWidth+1')
        check('library selects exceed the content area', '''() => {
          const container=document.querySelector('.library-controls').getBoundingClientRect();
          return [...document.querySelectorAll('.library-controls select')].every(e=>{
            const r=e.getBoundingClientRect();return r.left>=container.left-1&&r.right<=container.right+1;
          });
        }''')
        show('learning')
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
          document.querySelector('#emptyPlayer').hidden=true;
          const wrap=document.createElement('div');wrap.id='lecturePlayerWrap';wrap.className='lecture-player-wrap';
          document.querySelector('.player-shell').append(wrap);
        }''')
        page.add_script_tag(content=(STATIC / 'native-player.js').read_text())
        page.evaluate('''() => {
          const wrap=document.querySelector('#lecturePlayerWrap');
          CourseForgeNative.open(wrap,{id:'layout-only',title:'Layout check'},
            {id:'layout-only',watermark:'Layout check',start_pos:0,media_url:''},()=>{});
          wrap.append(CourseForgeNative.toolbar());
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
        assert not failures, f'{width}px: ' + '; '.join(failures)
    finally:
        page.close()
