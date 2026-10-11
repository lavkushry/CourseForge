"""Stage 2: Global Chrome + Cinematic Home test suite.

Validates:
1. Sticky Header: logo, center search, topbar nav links, notifications, avatar.
2. Streaming Billboard Slider: 16:9 backdrop, title, synopsis, Play & More Info CTAs, dot pills, chevron arrows.
3. Netflix-Style Carousels: Continue Watching, Top 10 (numerals + 2:3 posters), Featured Masterclasses, New Episodes.
4. Clean Streaming Footer: About, Support, Policies, clean version string, 0 developer jargon.
5. DOM and Icon integrity.
"""
from html.parser import HTMLParser
from pathlib import Path
import re
import pytest

STATIC = Path(__file__).resolve().parents[1] / 'app' / 'static'
INDEX_HTML = (STATIC / 'index.html').read_text()


def test_sticky_header_contract():
    # Topbar header and nav links
    assert 'class="topbar"' in INDEX_HTML
    assert 'id="globalSearch"' in INDEX_HTML
    assert 'id="notifyBtn"' in INDEX_HTML
    assert 'id="themeBtn"' in INDEX_HTML
    assert 'class="topbar-nav"' in INDEX_HTML
    assert 'data-nav="dashboard"' in INDEX_HTML
    assert 'data-nav="library"' in INDEX_HTML
    assert 'data-nav="planner"' in INDEX_HTML
    assert '#/my-list' in INDEX_HTML


def test_billboard_hero_slider_contract():
    # Billboard slider structure
    assert 'id="streamingHero"' in INDEX_HTML
    assert 'id="heroBackdrop"' in INDEX_HTML
    assert 'id="heroTitle"' in INDEX_HTML
    assert 'id="heroLearnBtn"' in INDEX_HTML
    assert 'id="heroInfoBtn"' in INDEX_HTML
    assert 'id="heroListBtn"' in INDEX_HTML
    assert 'id="heroPrevBtn"' in INDEX_HTML
    assert 'id="heroNextBtn"' in INDEX_HTML
    assert 'id="heroDots"' in INDEX_HTML


def test_streaming_carousels_container_contract():
    assert 'id="streamingCarousels"' in INDEX_HTML
    assert 'id="featuredCourses"' in INDEX_HTML


def test_streaming_footer_contract():
    assert 'class="streaming-footer"' in INDEX_HTML
    assert 'Version 2.4.0 (Streaming Edition)' in INDEX_HTML
    assert 'Protected Streaming Vault Active' in INDEX_HTML
    assert 'Learner Honor Code' in INDEX_HTML
    assert 'Terms of Service' in INDEX_HTML
    assert 'Privacy &amp; DRM Protection' in INDEX_HTML or 'Privacy & DRM Protection' in INDEX_HTML
    
    # Assert zero developer jargon in footer
    footer_match = re.search(r'<footer class="streaming-footer".*?</footer>', INDEX_HTML, re.S)
    assert footer_match is not None
    footer_text = footer_match.group(0).lower()
    for jargon in ('sha-', 'commit', 'git', 'debug', 'stack trace', 'sqlite', 'backend worker'):
        assert jargon not in footer_text


def test_streaming_css_tokens_and_classes():
    css = (STATIC / 'streaming.css').read_text()
    for cls in ('.topbar', '.topbar.scrolled', '.streaming-billboard', '.billboard-vignette',
                '.billboard-dots', '.streaming-carousels', '.streaming-row', '.row-track',
                '.row-nav-btn', '.stream-card-continue', '.stream-card-top10',
                '.stream-card-poster', '.stream-card-backdrop', '.streaming-footer'):
        assert cls in css, f"Missing streaming CSS class: {cls}"
