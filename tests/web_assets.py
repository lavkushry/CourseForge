from pathlib import Path

STATIC = Path(__file__).resolve().parents[1] / 'app/static'


def assert_tool_shipped(name):
    assert '/static/core.js?' in (STATIC / 'index.html').read_text()
    assert '/static/tools.js?' in (STATIC / 'loaders.js').read_text()
    assert '/static/tools.css?' in (STATIC / 'loaders.js').read_text()
    for extension in ('js', 'css'):
        source = (STATIC / f'{name}.{extension}').read_text()
        assert source in (STATIC / f'tools.{extension}').read_text(), f'Stale {name} bundle'
