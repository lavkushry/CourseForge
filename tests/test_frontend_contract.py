"""Guard against missing controls in the no-build UI (the original v2 init bug)."""
from html.parser import HTMLParser
from pathlib import Path
import re

STATIC = Path(__file__).resolve().parents[1] / 'app' / 'static'

class DOM(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids=[];self.views=[];self.nav=[]
    def handle_starttag(self,_tag,attrs):
        props=dict(attrs)
        if props.get('id'):self.ids.append(props['id'])
        if props.get('data-view'):self.views.append(props['data-view'])
        if props.get('data-nav'):self.nav.append(props['data-nav'])

def test_all_js_id_lookups_resolve():
    dom=DOM();dom.feed((STATIC/'index.html').read_text())
    js=(STATIC/'app.js').read_text()
    ids=set(re.findall(r"\$\(['\"]#([\w-]+)['\"]\)",js))
    assert len(dom.ids)==len(set(dom.ids)),'duplicate HTML IDs'
    assert ids<=set(dom.ids),f'JS expects missing controls: {ids-set(dom.ids)}'

def test_real_navigation_and_views():
    dom=DOM();dom.feed((STATIC/'index.html').read_text())
    assert set(dom.views)=={'dashboard','library','learning','tutor','syllabus','reviews','labs','settings'}
    assert {'dashboard','library','learning','tutor','reviews','labs','settings'}<=set(dom.nav)
    assert set(dom.nav)<=set(dom.views)

def test_theme_accessibility_and_loading_states():
    html=(STATIC/'index.html').read_text()
    css=(STATIC/'style.css').read_text()
    js=(STATIC/'app.js').read_text()
    assert 'data-theme="system"' in html and 'data-resolved-theme=' in html
    for mode in ('light','dark','system'):
        assert f'data-theme-option="{mode}"' in html
    for accent in ('indigo','teal','rose'):
        assert f'data-accent-option="{accent}"' in html
    assert 'aria-busy="true"' in html
    assert 'aria-live=' in html
    assert 'aria-expanded' in html
    assert ':focus-visible' in css and 'prefers-reduced-motion' in css
    assert 'localStorage' in js

def test_js_service_layer_typed_and_source_linked():
    service=(STATIC/'services.js').read_text()
    for keyword in ('@typedef','/api/videos','/api/progress','/api/studio/insights','/api/notes/'):
        assert keyword in service
    assert 'unavailableCourseMetadata' in service
