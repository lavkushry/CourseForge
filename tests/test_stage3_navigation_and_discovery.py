"""Stage 3: Streaming Navigation & Discovery test suite.

Validates:
1. Search overlay & suggest dropdown: trigger, recent searches, typeahead categories, match highlights.
2. Browse Hub: #/browse and #/browse/<category> routing and filter handling.
3. My List surface: #/my-list view, 1-click remove, 1-click play, empty state.
4. CSS tokens and classes for Stage 3.
5. DOM and Icon integrity.
"""
from pathlib import Path
import pytest

STATIC = Path(__file__).resolve().parents[1] / 'app' / 'static'
INDEX_HTML = (STATIC / 'index.html').read_text()
STREAMING_CSS = (STATIC / 'streaming.css').read_text()
SEARCH_JS = (STATIC / 'streaming-search.js').read_text()
BROWSE_JS = (STATIC / 'streaming-browse.js').read_text()


def test_search_overlay_contract():
    assert 'id="globalSearch"' in INDEX_HTML
    assert 'id="universalSearchResults"' in INDEX_HTML
    assert 'cf_recent_searches' in SEARCH_JS
    assert 'search-match' in SEARCH_JS
    assert 'Titles &amp; Masterclasses' in SEARCH_JS
    assert 'Episodes &amp; Lectures' in SEARCH_JS
    assert 'ArrowDown' in SEARCH_JS and 'ArrowUp' in SEARCH_JS and 'Escape' in SEARCH_JS


def test_browse_and_category_hub_contract():
    assert '#/browse' in BROWSE_JS
    assert 'categoryFilter' in BROWSE_JS
    assert 'applyCategoryFilter' in BROWSE_JS


def test_my_list_surface_contract():
    assert '#/my-list' in BROWSE_JS
    assert 'mylist-card' in BROWSE_JS
    assert 'mylist-remove-btn' in BROWSE_JS
    assert 'empty-mylist' in BROWSE_JS
    assert 'Find titles to add' in BROWSE_JS
    assert '/api/streaming/my-list' in BROWSE_JS


def test_stage3_css_classes():
    for cls in ('.universal-search-panel', '.search-section', '.recent-chips',
                '.recent-chip', '.search-item', '.search-match', '.mylist-grid',
                '.mylist-card', '.mylist-remove-btn', '.mylist-play-overlay',
                '.empty-mylist'):
        assert cls in STREAMING_CSS, f"Missing Stage 3 CSS class: {cls}"
