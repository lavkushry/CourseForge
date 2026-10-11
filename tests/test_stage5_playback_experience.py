"""Tests for Stage 5: Playback Experience (Netflix Player)."""
from pathlib import Path

STATIC = Path(__file__).resolve().parents[1] / 'app' / 'static'


def test_player_studio_up_next_contract():
    """Verify player-studio.js implements Up Next 30s countdown and cancellation."""
    js = (STATIC / 'player-studio.js').read_text()
    assert 'checkUpNext' in js
    assert 'showUpNextCard' in js
    assert 'cancelNext' in js
    assert 'player-up-next-card' in js
    assert 'upNextWatchBtn' in js
    assert 'upNextCancelBtn' in js
    assert 'CourseForgeStudio' in js


def test_native_player_drawer_and_shortcuts_contract():
    """Verify native-player.js implements Episode Drawer and Netflix keyboard shortcuts."""
    js = (STATIC / 'native-player.js').read_text()
    assert 'player-episodes-drawer' in js
    assert 'toggleEpisodesDrawer' in js
    assert 'renderDrawerEpisodes' in js
    assert 'checkUpNext' in js

    # Shortcuts verification
    for key in ("'k'", "'j'", "'l'", "'arrowleft'", "'arrowright'", "'arrowup'", "'arrowdown'", "'m'", "'f'", "'c'", "'?'"):
        assert key in js.lower(), f"Missing shortcut handler for: {key}"


def test_player_css_stage5_classes():
    """Verify player.css contains Stage 5 styles for Up Next card and Episode Drawer."""
    css = (STATIC / 'player.css').read_text()
    classes = [
        'player-up-next-card',
        'up-next-thumb-wrap',
        'up-next-countdown-badge',
        'up-next-watch-btn',
        'up-next-cancel-btn',
        'player-episodes-drawer',
        'drawer-header',
        'drawer-list',
        'drawer-episode-item',
        'drawer-playing-indicator'
    ]
    for cls in classes:
        assert f".{cls}" in css, f"Missing CSS class in player.css: .{cls}"
