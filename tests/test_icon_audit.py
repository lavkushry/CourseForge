"""Test suite gate for icon system consistency and zero emoji in UI."""
import pytest
from pathlib import Path
from scripts.audit_icons import extract_sprite_symbols, audit_icon_references, audit_emojis_in_ui

STATIC = Path(__file__).resolve().parents[1] / 'app' / 'static'
INDEX_HTML = STATIC / 'index.html'


def test_svg_sprite_contains_consistent_outline_symbols():
    symbols = extract_sprite_symbols(INDEX_HTML)
    assert len(symbols) >= 30, f"Expected at least 30 SVG icons, got {len(symbols)}"
    # Verify core symbols are present
    required_core = {
        'i-grid', 'i-book', 'i-clock', 'i-cards', 'i-spark', 'i-settings',
        'i-play', 'i-pause', 'i-code', 'i-search', 'i-bell', 'i-sun',
        'i-moon', 'i-monitor', 'i-chevron', 'i-arrow', 'i-arrow-left',
        'i-upload', 'i-download', 'i-check', 'i-check-circle', 'i-close',
        'i-refresh', 'i-filter', 'i-menu', 'i-local', 'i-cloud', 'i-shield',
        'i-user', 'i-users', 'i-folder', 'i-file', 'i-pdf', 'i-notebook',
        'i-slides', 'i-dataset', 'i-archive', 'i-paperclip', 'i-theater',
        'i-fullscreen', 'i-volume', 'i-volume-mute', 'i-replay-10', 'i-forward-10',
        'i-lock', 'i-unlock', 'i-speed', 'i-bookmark', 'i-flame', 'i-trophy',
        'i-certificate', 'i-trash', 'i-edit', 'i-eye', 'i-eye-off'
    }
    missing = required_core - symbols
    assert not missing, f"Missing required SVG sprite symbols: {missing}"


def test_no_unmapped_icon_references_in_ui():
    symbols = extract_sprite_symbols(INDEX_HTML)
    violations = audit_icon_references(symbols)
    assert not violations, "Unmapped icon references found:\n" + "\n".join(violations)


def test_zero_emojis_used_as_ui_icons():
    violations = audit_emojis_in_ui()
    assert not violations, "Emoji UI violations found:\n" + "\n".join(violations)
