"""Fail the build when shipped UI sources bypass tokens or canonical components."""
from __future__ import annotations
import ast
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
EMOJI = re.compile(r'[\U00010000-\U0010ffff]|[\u2600-\u27bf]|[\u2300-\u23ff]|[\u2b50-\u2b55]|✓')


def bundle_sources(root: Path) -> dict[str, list[str]]:
    tree=ast.parse((root/'scripts/build_web_assets.py').read_text())
    return next(ast.literal_eval(node.value) for node in tree.body
                if isinstance(node,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='groups' for t in node.targets))


def scan_css(source: str, filename: str) -> list[str]:
    if filename=='tokens.css':return []
    source=re.sub(r'/\*.*?\*/','',source,flags=re.S)
    issues=[]
    for rule in re.finditer(r'([^{}]+)\{([^{}]*)\}',source):
        for declaration in rule[2].split(';'):
            if ':' not in declaration:continue
            prop,value=declaration.split(':',1)
            if re.search(r'#[\da-fA-F]{3,8}\b|\brgba?\(|(?<![\w.-])(?:\d+(?:\.\d+)?|\.\d+)(?:px|rem)\b',value):
                issues.append(f'{filename}: {prop.strip()} uses a literal outside tokens: {value.strip()}')
    return issues


def scan_markup(source: str, filename: str) -> list[str]:
    issues=[]
    if EMOJI.search(source):issues.append(f'{filename}: emoji bypasses the SVG icon system')
    if re.search(r'\.style\.cssText\s*=',source):issues.append(f'{filename}: static cssText bypasses components')
    if re.search(r'\.style\.(?:color|backgroundColor|background|padding\w*|margin\w*|fontSize|border\w*)\s*=',source):
        issues.append(f'{filename}: direct cosmetic style assignment bypasses tokens')
    for match in re.finditer(r'\bstyle=["\']([^"\']*)["\']',source):
        value=match[1]
        # These are data, not presentation: measured progress and remote artwork.
        if not re.fullmatch(r'\s*(?:width:\s*\$\{[^}]+\}%;?\s*|--title-artwork:\s*url\(.*)',value):
            issues.append(f'{filename}: inline presentation bypasses components: {value[:100]}')
    return issues


def audit(root: Path=ROOT, *, bundles: bool=True) -> list[str]:
    groups=bundle_sources(root);static=root/'app/static';issues=[]
    sources=set(name for files in groups.values() for name in files)
    for name in sorted(sources|{'index.html'}):
        raw=(static/name).read_text()
        issues+=scan_css(raw,name) if name.endswith('.css') else scan_markup(raw,name)
    css='\n'.join((static/name).read_text() for name in sources if name.endswith('.css'))
    definitions=set(re.findall(r'(--[\w-]+)\s*:',css))
    references=set(re.findall(r'var\((--[\w-]+)',css))
    issues += [f'Undefined token: {name}' for name in sorted(references-definitions) if not name.startswith('--media-')]
    if 'components.js' not in groups['core.js'] or any('components.css' not in groups[k] for k in ('core.css','tools.css')):
        issues.append('Canonical components are absent from a shipped bundle')
    if bundles:
        for name,files in groups.items():
            expected='\n'.join(f'/* {f} */\n{(static/f).read_text()}' for f in files)
            if (static/name).read_text()!=expected:issues.append(f'{name}: stale bundle; rebuild before release')
    return issues


def evaluate_evidence(folder: Path, baseline: Path=ROOT/'docs/ui-evidence/stage-1/manifest.json') -> list[str]:
    """Require the entire populated view matrix and its saved geometry to pass."""
    try:
        manifest=json.loads((folder/'manifest.json').read_text())
        before=json.loads(baseline.read_text())
        records=json.loads((folder/'measurements.json').read_text())
    except (OSError,ValueError) as error:
        return ['UI evidence cannot be read: '+str(error)]
    required={(view,width) for view in before['views'] for width in (320,390,768,1366,1920)}
    actual={(record['view'],record['width']) for record in records}
    issues=[]
    if actual!=required or len(records)!=len(required):issues.append('UI evidence must cover every baseline view at all five widths exactly once')
    if manifest.get('failures'):issues.append('UI capture has failures')
    if manifest.get('screenshots')!=len(records):issues.append('UI manifest count does not match the saved records')
    for record in records:
        label=f"{record['view']} at {record['width']}px"
        geometry=record['geometry']
        for key in ('overflow','clipped','gridFailures','unmapped','badIcons'):
            if key not in geometry or geometry[key]:issues.append(f'{label}: {key} did not pass')
        if geometry['documentWidth']>record['width']+1:issues.append(f'{label}: document overflows')
        if record.get('page_errors'):issues.append(f'{label}: uncaught browser errors')
        screenshot=folder/record['screenshot']
        if not screenshot.is_file() or screenshot.read_bytes()[:8]!=b'\x89PNG\r\n\x1a\n':issues.append(f'{label}: missing PNG evidence')
    return issues


def main() -> int:
    issues=audit()
    for issue in issues:print('BLOCK: '+issue)
    print(f'UI SOURCE AUDIT: {len(issues)} violation(s)')
    return bool(issues)


if __name__=='__main__':raise SystemExit(main())
