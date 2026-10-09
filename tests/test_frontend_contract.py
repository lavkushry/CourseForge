"""Regression guard for the no-build, local-first CourseForge UI."""
from html.parser import HTMLParser
from pathlib import Path
import re

STATIC = Path(__file__).resolve().parents[1] / 'app' / 'static'


class DOMIds(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids = []
        self.views = []

    def handle_starttag(self, _tag, attrs):
        props = dict(attrs)
        if 'id' in props:
            self.ids.append(props['id'])
        if 'data-view' in props:
            self.views.append(props['data-view'])


def test_frontend_js_references_existing_ids():
    document = DOMIds()
    document.feed((STATIC / 'index.html').read_text(encoding='utf-8'))
    script = (STATIC / 'app.js').read_text(encoding='utf-8')
    refs = set(re.findall(r"\$\(['\"]#([\w-]+)['\"]\)", script))
    assert len(document.ids) == len(set(document.ids)), 'Duplicate HTML id'
    assert not refs.difference(document.ids), f'Missing markup for {refs.difference(document.ids)}'


def test_every_workspace_is_renderable():
    document = DOMIds()
    document.feed((STATIC / 'index.html').read_text(encoding='utf-8'))
    assert set(document.views) == {'home', 'library', 'learning', 'tutor', 'syllabus', 'reviews', 'labs'}


def test_theme_system_has_modes_accents_and_accessibility():
    html = (STATIC / 'index.html').read_text(encoding='utf-8')
    css = (STATIC / 'style.css').read_text(encoding='utf-8')
    for mode in ('light', 'dark', 'system'):
        assert f'data-theme-option="{mode}"' in html
    for accent in ('indigo', 'teal', 'rose'):
        assert f'data-accent-option="{accent}"' in html
    assert ':focus-visible' in css
    assert 'prefers-reduced-motion' in css
    assert 'localStorage' in html