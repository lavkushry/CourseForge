"""Tests for Stage 4: Title & Episode Details."""
from fastapi.testclient import TestClient
from pathlib import Path
from app.main import app

client = TestClient(app)
STATIC = Path(__file__).resolve().parents[1] / 'app' / 'static'


def test_course_detail_streaming_api_contract():
    """Verify GET /api/streaming/courses/{slug} returns complete streaming structure."""
    # Test with Azure course or first available course
    feed_res = client.get('/api/streaming/home-feed')
    assert feed_res.status_code == 200
    feed = feed_res.json()
    assert 'hero' in feed and len(feed['hero']) > 0

    slug = feed['hero'][0]['slug']
    res = client.get(f'/api/streaming/courses/{slug}')
    assert res.status_code == 200
    data = res.json()

    # 1. Course Metadata
    assert 'course' in data
    course = data['course']
    assert course['slug'] == slug
    assert 'title' in course
    assert 'instructor' in course
    assert 'category' in course
    assert 'synopsis' in course
    assert 'poster_url' in course
    assert 'backdrop_url' in course
    assert 'total_episodes' in course
    assert course['total_episodes'] > 0

    # 2. Seasons & Episodes
    assert 'seasons' in data
    assert len(data['seasons']) > 0
    season1 = data['seasons'][0]
    assert 'season_number' in season1
    assert 'title' in season1
    assert 'episodes_count' in season1
    assert 'episodes' in season1
    assert len(season1['episodes']) > 0

    ep1 = season1['episodes'][0]
    assert 'id' in ep1
    assert 'title' in ep1
    assert 'duration' in ep1
    assert 'thumbnail_url' in ep1
    assert 'deep_link' in ep1
    assert 'synopsis' in ep1
    assert f"#/lecture/{ep1['id']}" in ep1['deep_link']

    # 3. More Like This (Related courses)
    assert 'related' in data
    assert len(data['related']) <= 6
    if data['related']:
        rel = data['related'][0]
        assert 'title' in rel
        assert 'slug' in rel
        assert 'poster_url' in rel
        assert 'deep_link' in rel


def test_title_dialog_in_index_html():
    """Verify dialog element exists in index.html with correct ID."""
    html = (STATIC / 'index.html').read_text()
    assert 'id="titleDetailDialog"' in html
    assert '<dialog id="titleDetailDialog"' in html


def test_streaming_title_js_contract():
    """Verify JS controller implements title experience, tabs, and modal interactions."""
    js = (STATIC / 'streaming-title.js').read_text()
    assert 'openTitleModal' in js
    assert 'closeTitleModal' in js
    assert 'titleSeasonSelect' in js
    assert 'paneEpisodes' in js
    assert 'paneRelated' in js
    assert 'paneDetails' in js
    assert 'titlePlayCta' in js
    assert 'titleMyListBtn' in js
    assert 'titleShareBtn' in js
    assert 'CourseForgeTitle' in js


def test_streaming_title_css_classes():
    """Verify CSS has all Section 10 classes."""
    css = (STATIC / 'streaming.css').read_text()
    classes = [
        'streaming-title-dialog',
        'title-billboard',
        'title-main-heading',
        'title-meta-row',
        'title-cta-row',
        'title-play-cta',
        'title-mylist-cta',
        'title-share-cta',
        'title-dialog-body',
        'title-synopsis-section',
        'title-tabs-bar',
        'title-tab',
        'season-selector-bar',
        'season-select',
        'episodes-list',
        'episode-row',
        'episode-thumb-wrap',
        'episode-duration-badge',
        'more-like-this-grid',
        'related-course-card',
        'title-details-content'
    ]
    for cls in classes:
        assert f".{cls}" in css, f"Missing CSS class: .{cls}"
