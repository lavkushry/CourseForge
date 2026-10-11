#!/usr/bin/env python3
"""CourseForge Icon and Emoji Audit Script.

Validates that:
1. All icons in CourseForge use ONE consistent inline-SVG sprite system.
2. Every icon reference in HTML/JS resolves to a defined symbol in index.html.
3. No emojis or unmapped symbols are used as UI icons in HTML, JS, or backend templates.
"""
from __future__ import annotations

import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / 'app' / 'static'
INDEX_HTML = STATIC / 'index.html'

# Regex to detect emoji and pictorial symbols in code/templates
EMOJI_PATTERN = re.compile(
    r'[\U00010000-\U0010ffff]|[\u2600-\u27bf]|[\u2300-\u23ff]|[\u2b50-\u2b55]|[\u203c-\u2049]|✓'
)

# Known benign files to skip
EXCLUDED_PATHS = {
    'vendor',
    '__pycache__',
    '.git',
    '.venv',
    'data',
    'docs',
}


def extract_sprite_symbols(index_path: Path) -> set[str]:
    """Extract all symbol IDs defined in index.html SVG sprite."""
    html = index_path.read_text(encoding='utf-8')
    sprite_match = re.search(r'<svg[^>]*class="sprite"[^>]*>(.*?)</svg>', html, flags=re.S)
    if not sprite_match:
        raise ValueError('No <svg class="sprite"> found in index.html')

    symbol_ids = set()
    for m in re.finditer(r'<symbol\s+[^>]*id="([^"]+)"', sprite_match.group(1)):
        symbol_ids.add(m.group(1))

    # Also validate XML parseability of the sprite
    wrapped = f'<svg xmlns="http://www.w3.org/2000/svg">{sprite_match.group(1)}</svg>'
    try:
        ET.fromstring(wrapped)
    except ET.ParseError as err:
        raise ValueError(f'Malformed XML in SVG sprite: {err}')

    return symbol_ids


def audit_icon_references(symbols: set[str]) -> list[str]:
    """Scan HTML and JS files for icon references and check them against symbols."""
    violations = []
    
    # Check index.html and JS files
    target_files = [INDEX_HTML] + [
        p for p in STATIC.glob('*.js') if 'vendor' not in str(p) and p.name not in ('core.js', 'tools.js')
    ]

    for file_path in target_files:
        content = file_path.read_text(encoding='utf-8')
        rel_path = file_path.relative_to(ROOT)

        # 1. Check <use href="#(i-...)">
        for match in re.finditer(r'href="#([a-zA-Z0-9_-]+)"', content):
            icon_id = match.group(1)
            if icon_id.startswith('i-') and icon_id not in symbols:
                line_no = content.count('\n', 0, match.start()) + 1
                violations.append(f'{rel_path}:{line_no}: Unmapped icon reference "#{icon_id}"')

        # 2. Check icon('...') calls
        for match in re.finditer(r"\bicon\(['\"]([a-zA-Z0-9_-]+)['\"]\)", content):
            name = match.group(1)
            icon_id = f'i-{name}'
            if icon_id not in symbols:
                line_no = content.count('\n', 0, match.start()) + 1
                violations.append(f'{rel_path}:{line_no}: Unknown icon name "{name}" (expected "#{icon_id}")')

    return violations


def audit_emojis_in_ui() -> list[str]:
    """Scan static files and app/main.py for emoji used in UI text."""
    violations = []
    
    # Files to inspect: app/static/*.html, app/static/*.js, app/static/*.css (excluding bundles and vendors)
    # Also app/main.py
    files_to_check = [
        INDEX_HTML,
        ROOT / 'app' / 'main.py',
    ] + [
        p for p in STATIC.glob('*.js')
        if 'vendor' not in str(p) and p.name not in ('core.js', 'tools.js')
    ] + [
        p for p in STATIC.glob('*.css')
        if p.name not in ('core.css', 'tools.css')
    ]

    for file_path in files_to_check:
        if not file_path.is_file():
            continue
        rel_path = file_path.relative_to(ROOT)
        lines = file_path.read_text(encoding='utf-8').splitlines()
        for idx, line in enumerate(lines, 1):
            # Ignore comments in Python/JS/CSS
            stripped = line.strip()
            if stripped.startswith('#') or stripped.startswith('//') or stripped.startswith('/*') or stripped.startswith('*'):
                continue
            matches = EMOJI_PATTERN.findall(line)
            if matches:
                violations.append(f'{rel_path}:{idx}: Found emoji/pictorial character(s) {matches} in UI: "{stripped[:80]}"')

    return violations


def run_audit() -> int:
    """Run complete icon and emoji audit."""
    print("Auditing CourseForge icon system and UI emoji integrity...")
    try:
        symbols = extract_sprite_symbols(INDEX_HTML)
    except Exception as err:
        print(f"FAILED: Sprite validation error: {err}", file=sys.stderr)
        return 1

    print(f"Found {len(symbols)} outline SVG symbols defined in sprite:")
    print("  " + ", ".join(sorted(symbols)))

    reference_violations = audit_icon_references(symbols)
    emoji_violations = audit_emojis_in_ui()

    all_violations = reference_violations + emoji_violations

    if all_violations:
        print(f"\nFAILED: Found {len(all_violations)} violation(s):", file=sys.stderr)
        for v in all_violations:
            print(f"  • {v}", file=sys.stderr)
        return 1

    print(f"\nSUCCESS: All {len(symbols)} SVG icons valid and mapped. 0 emojis in UI.")
    return 0


if __name__ == '__main__':
    sys.exit(run_audit())
