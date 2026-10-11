"""Tests for Stage 6: User Library, PWA & Streaming-Grade Polish."""
import json
from pathlib import Path
from PIL import Image

STATIC = Path(__file__).resolve().parents[1] / 'app' / 'static'


def test_pwa_manifest_contract():
    """Verify manifest.webmanifest satisfies modern PWA installability requirements."""
    manifest_file = STATIC / 'manifest.webmanifest'
    assert manifest_file.exists(), "manifest.webmanifest is missing"
    data = json.loads(manifest_file.read_text())

    assert data.get('name') == 'CourseForge'
    assert data.get('short_name') == 'CourseForge'
    assert data.get('display') == 'standalone'
    assert data.get('start_url') == '/'
    assert data.get('theme_color') == '#0a0a0c'
    assert data.get('background_color') == '#0a0a0c'

    icons = data.get('icons', [])
    assert len(icons) >= 2, "Expected at least 192x192 and 512x512 icons"
    sizes = {i.get('sizes') for i in icons}
    assert '192x192' in sizes
    assert '512x512' in sizes


def test_pwa_icons_rendered_and_valid():
    """Verify PNG icon files are valid images with exact dimensions."""
    icon_192 = STATIC / 'icon-192.png'
    icon_512 = STATIC / 'icon-512.png'
    assert icon_192.exists(), "icon-192.png is missing"
    assert icon_512.exists(), "icon-512.png is missing"

    with Image.open(icon_192) as img:
        assert img.size == (192, 192)
        assert img.format == 'PNG'

    with Image.open(icon_512) as img:
        assert img.size == (512, 512)
        assert img.format == 'PNG'


def test_service_worker_contract():
    """Verify sw.js registers caching and handles fetch routing."""
    sw_file = STATIC / 'sw.js'
    assert sw_file.exists(), "sw.js is missing"
    sw_code = sw_file.read_text()
    assert 'addEventListener(\'install\'' in sw_code or 'addEventListener("install"' in sw_code
    assert 'addEventListener(\'activate\'' in sw_code or 'addEventListener("activate"' in sw_code
    assert 'addEventListener(\'fetch\'' in sw_code or 'addEventListener("fetch"' in sw_code


def test_index_html_pwa_and_history_nav():
    """Verify index.html contains PWA meta tags and navigation link to Watch History."""
    html = (STATIC / 'index.html').read_text()
    assert 'rel="manifest"' in html
    assert 'rel="apple-touch-icon"' in html
    assert 'href="#/history"' in html
    assert 'serviceWorker' in html


def test_watch_history_and_analytics_in_browse_js():
    """Verify streaming-browse.js implements renderHistoryView and CourseForgeBrowse export."""
    browse_js = (STATIC / 'streaming-browse.js').read_text()
    assert 'renderHistoryView' in browse_js
    assert '#/history' in browse_js
    assert 'history-clear-btn' in browse_js
    assert 'history-grid' in browse_js
    assert 'history-card' in browse_js


def test_streaming_analytics_api_contract():
    """Verify streaming analytics events and admin reporting in streaming.py."""
    from app import streaming
    assert hasattr(streaming, 'record_analytics_event')
    assert hasattr(streaming, 'get_streaming_analytics')
    assert hasattr(streaming, 'clear_watch_history')
    assert hasattr(streaming, 'get_watch_history')
