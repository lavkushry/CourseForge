#!/usr/bin/env python3
"""
Phase 2 CSS refactor: pretty-print, dedupe, tokenize, remap breakpoints,
strip unnecessary !important, and split style.css into modular files.
"""
from __future__ import annotations

import re
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STYLE = ROOT / "web/src/style.css"
OUT_DIR = ROOT / "web/src/styles"

# ── Color / spacing token maps ───────────────────────────────────────────────

COLOR_MAP = {
    # Exact hex (case-insensitive keys stored lowercase)
    "#0d0d0d": "var(--canvas)",
    "#0d0e12": "var(--bg)",
    "#16171d": "var(--panel)",
    "#202020": "var(--surface)",
    "#f5f4f2": "var(--text)",
    "#a4a7b0": "var(--muted)",
    "#ff7952": "var(--coral)",
    "#ff987b": "var(--coral-hover)",
    "#e54503": "var(--lms-accent)",
    "#10b981": "var(--success)",
    "#f59e0b": "var(--warn)",
    "#ef4444": "var(--danger)",
    # Common near-equivalents used as text/panel
    "#ffffff": "#fff",  # normalize; leave #fff as-is (not a token)
}

# Spacing literals → tokens (only exact common padding/gap values)
SPACE_MAP = {
    "4px": "var(--space-1)",
    "8px": "var(--space-2)",
    "12px": "var(--space-3)",
    "16px": "var(--space-4)",
    "20px": "var(--space-5)",
    "24px": "var(--space-6)",
    "28px": "var(--space-7)",
    "32px": "var(--space-8)",
    "36px": "var(--space-9)",
    "40px": "var(--space-10)",
}

SPACE_PROPS = {
    "gap",
    "row-gap",
    "column-gap",
    "padding",
    "padding-top",
    "padding-right",
    "padding-bottom",
    "padding-left",
    "margin",
    "margin-top",
    "margin-right",
    "margin-bottom",
    "margin-left",
}

# Breakpoint remaps (px int → px int)
MAX_WIDTH_MAP = {
    520: 640,
    640: 640,
    768: 640,
    800: 1024,
    850: 1024,
    860: 1024,
    900: 1024,
    960: 1024,
    1100: 1024,
    1024: 1024,
}
MIN_WIDTH_MAP = {
    901: 1025,  # complement of max 1024
    1600: 1440,
    1440: 1440,
    1024: 1024,
}

# Keep !important when selector/context matches these patterns
KEEP_IMPORTANT_SEL = re.compile(
    r"\[hidden\]|prefers-reduced-motion|::backdrop|"
    r"media-control|media-controller|:-webkit-|"
    r"\.theater\b|\.controls-locked\b|"
    r"\.academy-studio-mode\b|"
    r"\[aria-pressed|\.is-open\b|\.is-active\b|"
    r"\.lms-drawer-open\b|\.mobile-nav-open\b",
    re.I,
)


def strip_comments_keep_sections(css: str) -> str:
    """Remove comments except section banners (=======)."""
    out = []
    i = 0
    while i < len(css):
        if css.startswith("/*", i):
            end = css.find("*/", i + 2)
            if end < 0:
                break
            comment = css[i : end + 2]
            if "====" in comment or "Lesson learning" in comment:
                out.append("\n" + comment.strip() + "\n")
            i = end + 2
            continue
        out.append(css[i])
        i += 1
    return "".join(out)


def tokenize_css(css: str) -> list[str]:
    """Split into tokens preserving strings."""
    tokens: list[str] = []
    i = 0
    n = len(css)
    while i < n:
        c = css[i]
        if c in " \t\r\n":
            # collapse whitespace to single space outside strings
            j = i
            while j < n and css[j] in " \t\r\n":
                j += 1
            tokens.append(" ")
            i = j
            continue
        if c in "\"'":
            quote = c
            j = i + 1
            while j < n:
                if css[j] == "\\":
                    j += 2
                    continue
                if css[j] == quote:
                    j += 1
                    break
                j += 1
            tokens.append(css[i:j])
            i = j
            continue
        if css.startswith("/*", i):
            end = css.find("*/", i + 2)
            if end < 0:
                tokens.append(css[i:])
                break
            tokens.append(css[i : end + 2])
            i = end + 2
            continue
        if c in "{}:;":
            tokens.append(c)
            i += 1
            continue
        j = i + 1
        while j < n and css[j] not in " \t\r\n{}:;\"'/" and not css.startswith("/*", j):
            j += 1
        # allow / in urls etc — if we stopped at /, check comment
        tokens.append(css[i:j])
        i = j
    return tokens


class Node:
    __slots__ = ("kind", "prelude", "children", "decls", "raw")

    def __init__(self, kind: str, prelude: str = ""):
        self.kind = kind  # rule | at-rule | comment | decls-only
        self.prelude = prelude
        self.children: list[Node] = []
        self.decls: list[tuple[str, str, bool]] = []  # prop, value, important
        self.raw = ""


def parse_stylesheet(css: str) -> list[Node]:
    """Brace-aware stylesheet parser."""
    nodes: list[Node] = []
    i = 0
    n = len(css)

    def skip_ws(pos: int) -> int:
        while pos < n and css[pos] in " \t\r\n":
            pos += 1
        return pos

    def parse_decls(block: str) -> list[tuple[str, str, bool]]:
        decls: list[tuple[str, str, bool]] = []
        # respect strings and parentheses
        parts: list[str] = []
        buf = []
        depth = 0
        in_str = None
        k = 0
        while k < len(block):
            ch = block[k]
            if in_str:
                buf.append(ch)
                if ch == "\\" and k + 1 < len(block):
                    buf.append(block[k + 1])
                    k += 2
                    continue
                if ch == in_str:
                    in_str = None
                k += 1
                continue
            if ch in "\"'":
                in_str = ch
                buf.append(ch)
                k += 1
                continue
            if ch == "(":
                depth += 1
                buf.append(ch)
                k += 1
                continue
            if ch == ")":
                depth = max(0, depth - 1)
                buf.append(ch)
                k += 1
                continue
            if ch == ";" and depth == 0:
                parts.append("".join(buf))
                buf = []
                k += 1
                continue
            buf.append(ch)
            k += 1
        if buf:
            parts.append("".join(buf))
        for part in parts:
            part = part.strip()
            if not part or ":" not in part:
                continue
            prop, _, val = part.partition(":")
            prop = prop.strip()
            val = val.strip()
            if not prop:
                continue
            imp = False
            if val.endswith("!important"):
                imp = True
                val = val[: -len("!important")].rstrip()
            elif "!important" in val:
                imp = True
                val = re.sub(r"\s*!important\s*", "", val).strip()
            decls.append((prop, val, imp))
        return decls

    def read_until_brace(pos: int) -> tuple[str, int]:
        start = pos
        in_str = None
        while pos < n:
            ch = css[pos]
            if in_str:
                if ch == "\\" and pos + 1 < n:
                    pos += 2
                    continue
                if ch == in_str:
                    in_str = None
                pos += 1
                continue
            if ch in "\"'":
                in_str = ch
                pos += 1
                continue
            if css.startswith("/*", pos):
                end = css.find("*/", pos + 2)
                pos = n if end < 0 else end + 2
                continue
            if ch == "{":
                return css[start:pos].strip(), pos
            if ch == "}":
                return css[start:pos].strip(), pos
            pos += 1
        return css[start:pos].strip(), pos

    def read_block(pos: int) -> tuple[str, int]:
        assert css[pos] == "{"
        pos += 1
        start = pos
        depth = 1
        in_str = None
        while pos < n and depth:
            ch = css[pos]
            if in_str:
                if ch == "\\" and pos + 1 < n:
                    pos += 2
                    continue
                if ch == in_str:
                    in_str = None
                pos += 1
                continue
            if ch in "\"'":
                in_str = ch
                pos += 1
                continue
            if css.startswith("/*", pos):
                end = css.find("*/", pos + 2)
                pos = n if end < 0 else end + 2
                continue
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    return css[start:pos], pos + 1
            pos += 1
        return css[start:pos], pos

    def parse_block_contents(block: str) -> list[Node]:
        """Parse contents that may mix decls and nested rules (for @media)."""
        # Detect if block is mostly declarations or nested rules by scanning for `{`
        # Heuristic: if any `{` outside strings → nested rules (at-rule body)
        has_nested = False
        in_str = None
        p = 0
        while p < len(block):
            ch = block[p]
            if in_str:
                if ch == "\\" and p + 1 < len(block):
                    p += 2
                    continue
                if ch == in_str:
                    in_str = None
                p += 1
                continue
            if ch in "\"'":
                in_str = ch
            elif block.startswith("/*", p):
                end = block.find("*/", p + 2)
                p = len(block) if end < 0 else end + 2
                continue
            elif ch == "{":
                has_nested = True
                break
            p += 1

        if not has_nested:
            node = Node("decls-only")
            node.decls = parse_decls(block)
            return [node] if node.decls else []

        # Nested: recursively parse as stylesheet fragment
        # Temporarily wrap — reuse outer parser on fragment
        return parse_stylesheet(block)

    while i < n:
        i = skip_ws(i)
        if i >= n:
            break
        if css.startswith("/*", i):
            end = css.find("*/", i + 2)
            if end < 0:
                break
            comment = css[i : end + 2].strip()
            node = Node("comment")
            node.raw = comment
            nodes.append(node)
            i = end + 2
            continue

        prelude, brace_pos = read_until_brace(i)
        if brace_pos >= n or css[brace_pos] != "{":
            # dangling text
            break

        block, next_pos = read_block(brace_pos)
        if prelude.startswith("@"):
            node = Node("at-rule", prelude)
            # @keyframes and @media / @supports
            if prelude.startswith("@keyframes") or prelude.startswith("@-webkit-keyframes"):
                # keep raw pretty later — store children as keyframe selectors
                node.children = parse_block_contents(block)
            elif prelude.startswith("@media") or prelude.startswith("@supports"):
                node.children = parse_block_contents(block)
            else:
                # @font-face etc — decls
                node.decls = parse_decls(block)
            nodes.append(node)
        else:
            node = Node("rule", prelude)
            node.decls = parse_decls(block)
            nodes.append(node)
        i = next_pos

    return nodes


def remap_media_prelude(prelude: str) -> str:
    def repl_max(m: re.Match) -> str:
        px = int(m.group(1))
        return f"max-width: {MAX_WIDTH_MAP.get(px, px)}px"

    def repl_min(m: re.Match) -> str:
        px = int(m.group(1))
        return f"min-width: {MIN_WIDTH_MAP.get(px, px)}px"

    out = re.sub(r"max-width:\s*(\d+)px", repl_max, prelude)
    out = re.sub(r"min-width:\s*(\d+)px", repl_min, out)
    return out


def replace_colors(value: str) -> str:
    def repl(m: re.Match) -> str:
        raw = m.group(0)
        key = raw.lower()
        if key in COLOR_MAP:
            return COLOR_MAP[key]
        # normalize long white
        if key in ("#ffffff",):
            return "#fff"
        # burnt orange variants already mapped
        return raw

    return re.sub(r"#[0-9a-fA-F]{3,8}\b", repl, value)


def replace_spacing(prop: str, value: str) -> str:
    if prop not in SPACE_PROPS:
        return value
    # Only replace standalone px tokens that are exact scale matches
    def repl(m: re.Match) -> str:
        tok = m.group(0)
        return SPACE_MAP.get(tok, tok)

    return re.sub(r"\b\d+px\b", repl, value)


def format_decls(decls: list[tuple[str, str, bool]], indent: str = "  ") -> str:
    lines = []
    for prop, val, imp in decls:
        suffix = " !important" if imp else ""
        lines.append(f"{indent}{prop}: {val}{suffix};")
    return "\n".join(lines)


def format_nodes(nodes: list[Node], indent: int = 0) -> str:
    pad = "  " * indent
    chunks: list[str] = []
    for node in nodes:
        if node.kind == "comment":
            chunks.append(f"{pad}{node.raw}")
            continue
        if node.kind == "decls-only":
            # used inside keyframes
            chunks.append(format_decls(node.decls, pad))
            continue
        if node.kind == "rule":
            body = format_decls(node.decls, pad + "  ")
            chunks.append(f"{pad}{node.prelude} {{\n{body}\n{pad}}}")
            continue
        if node.kind == "at-rule":
            # If children are decls-only single, or nested rules
            if node.decls and not node.children:
                body = format_decls(node.decls, pad + "  ")
                chunks.append(f"{pad}{node.prelude} {{\n{body}\n{pad}}}")
            else:
                inner_parts: list[str] = []
                for child in node.children:
                    if child.kind == "decls-only":
                        # keyframe step or malformed — treat as raw decls under at-rule
                        # Actually for @media with only decls mixed — shouldn't happen
                        inner_parts.append(format_decls(child.decls, pad + "  "))
                    elif child.kind == "rule":
                        body = format_decls(child.decls, pad + "    ")
                        inner_parts.append(f"{pad}  {child.prelude} {{\n{body}\n{pad}  }}")
                    elif child.kind == "comment":
                        inner_parts.append(f"{pad}  {child.raw}")
                    elif child.kind == "at-rule":
                        inner_parts.append(format_nodes([child], indent + 1))
                    else:
                        inner_parts.append(format_nodes([child], indent + 1))
                inner = "\n\n".join(p for p in inner_parts if p.strip())
                chunks.append(f"{pad}{node.prelude} {{\n{inner}\n{pad}}}")
    return "\n\n".join(chunks)


def walk_transform(nodes: list[Node], media: str = "") -> None:
    for node in nodes:
        if node.kind == "at-rule":
            node.prelude = remap_media_prelude(node.prelude)
            walk_transform(node.children, node.prelude)
            for i, (prop, val, imp) in enumerate(node.decls):
                val = replace_colors(val)
                val = replace_spacing(prop, val)
                node.decls[i] = (prop, val, imp)
            continue
        if node.kind == "rule":
            for i, (prop, val, imp) in enumerate(node.decls):
                val = replace_colors(val)
                val = replace_spacing(prop, val)
                node.decls[i] = (prop, val, imp)
            continue
        if node.kind == "decls-only":
            for i, (prop, val, imp) in enumerate(node.decls):
                val = replace_colors(val)
                val = replace_spacing(prop, val)
                node.decls[i] = (prop, val, imp)


def merge_duplicate_rules(nodes: list[Node]) -> list[Node]:
    """Merge consecutive same-selector rules and later overrides of same selector at same level.
    Last property wins. Strip !important when safe.
    """
    # Separate comments / at-rules as barriers; merge rules within segments
    result: list[Node] = []
    bucket: dict[str, Node] = {}
    order: list[str] = []

    def flush():
        nonlocal bucket, order
        for key in order:
            result.append(bucket[key])
        bucket = {}
        order = []

    for node in nodes:
        if node.kind == "comment":
            flush()
            result.append(node)
            continue
        if node.kind == "at-rule":
            flush()
            node.children = merge_duplicate_rules(node.children)
            # Also merge decls-only siblings inside at-rule already handled
            result.append(node)
            continue
        if node.kind != "rule":
            flush()
            result.append(node)
            continue

        key = re.sub(r"\s+", " ", node.prelude.strip())
        if key not in bucket:
            bucket[key] = node
            order.append(key)
            # normalize prelude
            bucket[key].prelude = key
        else:
            # merge decls — later wins per property
            existing = {p: (v, i) for p, v, i in bucket[key].decls}
            for prop, val, imp in node.decls:
                existing[prop] = (val, imp)
            bucket[key].decls = [(p, v, i) for p, (v, i) in existing.items()]

    flush()

    # Second pass: strip !important when selector doesn't need it
    def strip_imp(nlist: list[Node]) -> None:
        for n in nlist:
            if n.kind == "at-rule":
                keep_ctx = bool(KEEP_IMPORTANT_SEL.search(n.prelude))
                strip_imp(n.children)
                if not keep_ctx:
                    n.decls = [(p, v, False) if not KEEP_IMPORTANT_SEL.search(p + v) else (p, v, i) for p, v, i in n.decls]
                continue
            if n.kind == "rule":
                keep = bool(KEEP_IMPORTANT_SEL.search(n.prelude))
                if keep:
                    continue
                new_decls = []
                for prop, val, imp in n.decls:
                    if not imp:
                        new_decls.append((prop, val, False))
                        continue
                    # Keep for display:none on [hidden]-like, or explicit keep props
                    if prop == "display" and val.strip() == "none":
                        # keep if selector involves hidden or utility hide
                        if "hidden" in n.prelude or "[hidden]" in n.prelude:
                            new_decls.append((prop, val, True))
                        else:
                            new_decls.append((prop, val, False))
                    elif prop in ("scroll-behavior", "transition", "animation", "animation-duration"):
                        # only keep inside reduced motion (handled via at-rule)
                        new_decls.append((prop, val, False))
                    else:
                        new_decls.append((prop, val, False))
                n.decls = new_decls
            elif n.kind == "decls-only":
                n.decls = [(p, v, False) for p, v, _ in n.decls]

    strip_imp(result)
    return result


SECTION_ROUTING = [
    # (regex on comment text, target relative path under styles/)
    (r"AI Tutor Experience|AI TUTOR", "pages/tutor.css"),
    (r"Certificates", "pages/certificates.css"),
    (r"Learning Roadmaps|Paths", "pages/paths.css"),
    (r"Admin Dashboard|ADMIN CONSOLE|STUDENT COURSE ACCESS", "pages/admin.css"),
    (r"Netflix|Streaming Carousels|Cinematic Home|WATCH HISTORY|CONTINUE WATCHING|HERO|Top 10", "pages/catalog.css"),
    (r"Learning Studio Study Rail|STUDY RAIL|Zen Study|CLASSROOM|PLAYER|PLAYER META|Up Next|Theater", "pages/classroom.css"),
    (r"Course Detail|Syllabus", "pages/course-detail.css"),
    (r"Library Controls", "pages/library.css"),
    (r"Today's Plan|Pomodoro|DAILY PLAN|Calendar Strip|Focus Timer|Habits|WEEKLY CALENDAR|Planning", "pages/planning.css"),
    (r"Spaced Review|Flashcards", "pages/reviews.css"),
    (r"Labs Workspace|LABS", "pages/labs.css"),
    (r"SETTINGS|Preferences", "pages/settings.css"),
    (r"OMNI-SEARCH|SEARCH", "pages/search.css"),
    (r"UNIVERSITY LMS|ACADEMY STUDIO|MOBILE & TABLET|MOBILE VIEWPORT|lms-|Bottom Fixed", "pages/lms-shell.css"),
    (r"COMPREHENSIVE UI POLISH|STANDARDIZED INTERACTIVE|UNIFIED ALIGNED|DRIBBBLE 27155177 LMS THUMBNAILS", "components/polish.css"),
    (r"Guest Curriculum|Auth tabs|Login", "pages/login.css"),
    (r"Scalable inline SVG|icons", "components/icons.css"),
    (r"Dynamic AI Roadmap|Retention", "pages/admin.css"),
]


def route_section(comment: str) -> str | None:
    for pat, dest in SECTION_ROUTING:
        if re.search(pat, comment, re.I):
            return dest
    return None


LAYOUT_PRIMITIVES = """
/* Shared layout primitives */
.container {
  width: min(100% - 2 * var(--space-4), 1440px);
  margin-inline: auto;
}

.stack {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.stack-sm { gap: var(--space-2); }
.stack-lg { gap: var(--space-6); }

.cluster {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
}

.grid {
  display: grid;
  gap: var(--space-6);
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 280px), 1fr));
}

.grid-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.grid-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }

@media (max-width: 1024px) {
  .grid-3 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

@media (max-width: 640px) {
  .container {
    width: min(100% - 2 * var(--space-4), 1440px);
  }

  .grid-2,
  .grid-3 {
    grid-template-columns: minmax(0, 1fr);
  }
}
"""


def classify_base_rule(prelude: str) -> str:
    """Route early non-section rules into base/layout/components."""
    s = prelude.lower()
    if re.match(r"^(:root|html|body|\*|button|input|select|textarea|a|h[1-6]|p|kbd|\[hidden\])", s):
        return "base.css"
    if any(k in s for k in (".workspace", ".site-header", ".primary-navigation", ".account", ".brand", ".section-heading", ".classroom-grid", ".lesson-column")):
        return "layout.css"
    if any(k in s for k in (".button", ".text-button", ".notice", ".eyebrow", ".muted", ".list-button")):
        return "components/buttons.css"
    if any(k in s for k in (".course-card", ".course-grid", ".course-art", ".art-", ".cover-", ".catalog", ".featured", ".hero-", ".continue-", ".watch-progress", ".course-skeleton", ".empty-", ".footer")):
        return "components/cards.css"
    if any(k in s for k in (".login-", "#login",)):
        return "pages/login.css"
    if any(k in s for k in (".classroom", ".player-", ".lesson-", ".ownership", ".watermark", "media-", ".theater", ".materials", ".episode-", ".notes", "#note", ".course-enrollment", ".unlock-", ".controls-locked", ".next-countdown", ".shortcuts", ".autoplay")):
        return "pages/classroom.css"
    if any(k in s for k in (".learning-", ".quiz-", ".review-", ".learned-", ".feedback-")):
        return "pages/learning.css"
    if "@keyframes" in s or prelude.startswith("@keyframes"):
        return "base.css"
    if prelude.startswith("@media"):
        return "layout.css"
    return "components/misc.css"


def main() -> None:
    raw = STYLE.read_text()
    # Drop the tokens import; style.css will re-import everything
    raw = re.sub(r"^@import\s+['\"]\./styles/tokens\.css['\"];\s*", "", raw)

    print("Parsing…")
    nodes = parse_stylesheet(raw)
    print(f"  top-level nodes: {len(nodes)}")

    print("Transforming colors/spacing/breakpoints…")
    walk_transform(nodes)

    print("Merging duplicates & stripping !important…")
    nodes = merge_duplicate_rules(nodes)

    # Count remaining !important
    def count_imp(nlist: list[Node]) -> int:
        c = 0
        for n in nlist:
            c += sum(1 for _, _, i in n.decls if i)
            c += count_imp(n.children)
        return c

    print(f"  !important remaining: {count_imp(nodes)}")

    # Split into files
    files: dict[str, list[Node]] = defaultdict(list)
    current_dest = "base.css"

    for node in nodes:
        if node.kind == "comment":
            routed = route_section(node.raw)
            if routed:
                current_dest = routed
            files[current_dest].append(node)
            continue

        if node.kind == "at-rule" and node.prelude.startswith("@media"):
            # Keep media with whatever section we're in; early media → layout
            if current_dest == "base.css":
                files["layout.css"].append(node)
            else:
                files[current_dest].append(node)
            continue

        if current_dest == "base.css" and node.kind == "rule":
            dest = classify_base_rule(node.prelude)
            files[dest].append(node)
            continue

        if current_dest == "base.css" and node.kind == "at-rule":
            files["base.css"].append(node)
            continue

        files[current_dest].append(node)

    # Write layout primitives into layout.css head
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "components").mkdir(exist_ok=True)
    (OUT_DIR / "pages").mkdir(exist_ok=True)

    # themes.css: extract theme/accent component overrides if present in nodes classified elsewhere
    # Also copy light/accent component rules into themes by scanning formatted output later.

    import_order = [
        "tokens.css",
        "themes.css",
        "base.css",
        "layout.css",
        "components/buttons.css",
        "components/cards.css",
        "components/forms.css",
        "components/icons.css",
        "components/polish.css",
        "components/misc.css",
        "pages/login.css",
        "pages/catalog.css",
        "pages/classroom.css",
        "pages/learning.css",
        "pages/course-detail.css",
        "pages/library.css",
        "pages/planning.css",
        "pages/reviews.css",
        "pages/labs.css",
        "pages/settings.css",
        "pages/search.css",
        "pages/tutor.css",
        "pages/certificates.css",
        "pages/paths.css",
        "pages/admin.css",
        "pages/lms-shell.css",
    ]

    # Pull theme-related rules into themes.css
    theme_nodes: list[Node] = []
    for dest, nlist in list(files.items()):
        keep: list[Node] = []
        for n in nlist:
            if n.kind == "rule" and ("data-theme" in n.prelude or "data-accent" in n.prelude):
                theme_nodes.append(n)
            else:
                keep.append(n)
        files[dest] = keep
    files["themes.css"] = theme_nodes

    # Ensure forms.css exists (may be empty → add shared form alignment)
    if "components/forms.css" not in files or not files["components/forms.css"]:
        files["components/forms.css"] = []

    written = []
    for rel in import_order:
        if rel == "tokens.css":
            continue  # already exists
        path = OUT_DIR / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        nodes_for = files.get(rel, [])
        content = format_nodes(nodes_for)
        if rel == "layout.css":
            content = LAYOUT_PRIMITIVES.strip() + "\n\n" + content
        if rel == "components/forms.css":
            forms_extra = """
/* Unified form control alignment */
.stack > label,
.learning-field,
.catalog-search label,
.settings-field,
.planning-field {
  display: grid;
  gap: var(--space-2);
}

input:not([type="checkbox"]):not([type="radio"]):not([type="range"]),
select,
textarea {
  min-height: 44px;
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--bg);
  color: var(--text);
}

textarea {
  min-height: 96px;
  resize: vertical;
}
""".strip()
            content = forms_extra + ("\n\n" + content if content.strip() else "\n")
        if rel == "themes.css":
            header = "/* Component-level theme / accent overrides (tokens live in tokens.css) */\n\n"
            content = header + content
        path.write_text(content.rstrip() + "\n")
        written.append(rel)
        imps = content.count("!important")
        print(f"  wrote {rel}: {len(content.splitlines())} lines, {imps} !important")

    # style.css becomes import barrel
    imports = "\n".join(f"@import './styles/{rel}';" for rel in import_order)
    STYLE.write_text(imports + "\n")
    print("Updated style.css import barrel")

    # Summary stats
    total_imp = 0
    total_hex = 0
    total_lines = 0
    for rel in import_order:
        p = OUT_DIR / rel
        if not p.exists():
            continue
        t = p.read_text()
        total_imp += t.count("!important")
        total_hex += len(re.findall(r"#[0-9a-fA-F]{3,8}\b", t))
        total_lines += len(t.splitlines())
    print(f"TOTAL lines={total_lines} !important={total_imp} hex={total_hex}")


if __name__ == "__main__":
    main()
