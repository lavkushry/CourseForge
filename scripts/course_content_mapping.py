#!/usr/bin/env python3
"""Authoritative course → video / materials mapping helpers.

Videos belong in lessons + lesson_providers.
Study/document companions belong in materials only.
Claim ownership is course-scoped via claim_prefix (and documented aliases).
"""
from __future__ import annotations

import hashlib
import re
from typing import Any

DOC_EXTENSIONS = (
    ".pdf",
    ".txt",
    ".zip",
    ".rar",
    ".7z",
    ".csv",
    ".sql",
    ".py",
    ".ipynb",
    ".jpg",
    ".jpeg",
    ".png",
    ".webp",
    ".md",
    ".docx",
    ".pptx",
    ".html",
    ".mhtml",
    ".parquet",
    ".xlsx",
    ".tar",
    ".gz",
)

MATERIAL_KINDS = frozenset({"study", "document", "material", "doc"})
VIDEO_KINDS = frozenset({"video", "lecture", "lesson"})

# Extra accepted prefixes when curricula claim_prefix alone is too narrow.
CLAIM_PREFIX_ALIASES: dict[str, tuple[str, ...]] = {
    "Azure Data Bricks by Sameer Sir Durgasoft": (
        "sameer-azure-",
        "sameer-azure-databricks-",
        "sameer-adb-",
        "adb-sameer-",
    ),
    "NeetCode System Design Course": ("neetcode-sd-", "neetcode-sysdesign-"),
    "Sanket Singh Top Coding Interview Problem": ("sanket-algo-", "sanket-topcoding-"),
    "Scaler DSA and System Design": ("scaler-dsa-sd-", "scaler-dsa-"),
    "Parakram 2.0 GATE 2026 Batch F (Hinglish) - Computer Science": (
        "pw-parakram-gate-cs-",
        "pw-parakram-gate-",
    ),
    "CampusX Data Science Interview Preparation": (
        "campusx-ds-interview-",
        "campusx-interview-",
    ),
    "Campus X DSMP (Data Science Mentorship Program)": (
        "campusx-dsmp-2026-",
        "campusx-dsmp-",
    ),
    "Sanket Elite 1.0": (
        "sanket-elite-",
    ),
    "Harkirat 100x combined bootcamp Coursedost": ("harkirat-100x-", "harkirat-"),
    "Deepak Data Engg": ("mission-ade-",),
    "Advanced Agentic AI And Gen AI By Prudhvi Sir Nareshit 2026": ("agentic-genai-",),
    "Vizuara AI - Production AI Agents Bootcamp 2026": (
        "vizuara-prod-agents-",
        "vizuara-ai-agents-bootcamp-",
    ),
}


def material_id(course_key: str, filename: str) -> str:
    token = f"{course_key}:{filename}".encode()
    return f"mat_{hashlib.sha1(token).hexdigest()[:16]}"


def lesson_id_for(course_key: str, idx: Any, msg_id: Any = None, existing: str | None = None) -> str:
    if existing:
        return existing
    token = f"{course_key}:{idx}:{msg_id or ''}".encode()
    return f"v_{hashlib.sha1(token).hexdigest()[:12]}"


def _endswith_doc(name: str | None) -> bool:
    if not name:
        return False
    lower = name.lower()
    return any(lower.endswith(ext) for ext in DOC_EXTENSIONS)


def is_document_claim(claim_name: str | None) -> bool:
    if not claim_name:
        return False
    if "-doc-" in claim_name or claim_name.endswith("-doc") or "-res-" in claim_name:
        return True
    if claim_name.startswith("codebasics-de-2026-") and (
        claim_name.endswith("-txt") or claim_name.endswith("-tx")
    ):
        return True
    if claim_name == "sanket-sd2-2026-357-notes":
        return True
    return False


def is_material_item(item: dict[str, Any]) -> bool:
    kind = str(item.get("kind") or "").strip().lower()
    if is_document_claim(item.get("claim_name")):
        return True
    if _endswith_doc(item.get("clean_filename")) or _endswith_doc(item.get("orig_filename")):
        return True
    if kind in MATERIAL_KINDS:
        return True
    if kind in VIDEO_KINDS:
        return False
    return False


def is_video_item(item: dict[str, Any]) -> bool:
    if is_material_item(item):
        return False
    kind = str(item.get("kind") or "").strip().lower()
    if kind in VIDEO_KINDS:
        return True
    if kind in MATERIAL_KINDS:
        return False
    # Default unknown kinds with video-like names to video only when not docs.
    return bool(item.get("claim_name") or item.get("clean_filename") or item.get("title"))


def course_prefixes(course_key: str, claim_prefix: str | None = None) -> tuple[str, ...]:
    prefixes: list[str] = []
    if claim_prefix:
        prefixes.append(claim_prefix)
        if not claim_prefix.endswith("-"):
            prefixes.append(claim_prefix + "-")
    for alias in CLAIM_PREFIX_ALIASES.get(course_key, ()):
        if alias not in prefixes:
            prefixes.append(alias)
    # Stable unique order, longest first for matching.
    uniq = []
    seen = set()
    for p in prefixes:
        if p and p not in seen:
            seen.add(p)
            uniq.append(p)
    uniq.sort(key=len, reverse=True)
    return tuple(uniq)


def claim_belongs_to_course(
    claim_name: str | None,
    course_key: str,
    claim_prefix: str | None = None,
    prefixes: tuple[str, ...] | None = None,
) -> bool:
    if not claim_name:
        return False
    allowed = prefixes if prefixes is not None else course_prefixes(course_key, claim_prefix)
    if not allowed:
        # No prefix configured: reject cross-course only when another explicit
        # prefix set is supplied by the caller.
        return True
    return any(claim_name.startswith(p) for p in allowed)


def material_type_for(filename: str) -> str:
    ext = ""
    if "." in filename:
        ext = "." + filename.rsplit(".", 1)[-1].lower()
    if ext == ".pdf":
        return "PDF Document"
    if ext in (".zip", ".rar", ".7z", ".tar", ".gz"):
        return "Code Archive"
    if ext in (".html", ".mhtml", ".docx", ".txt", ".md"):
        return "Lecture Notes"
    if ext == ".ipynb":
        return "Jupyter Notebook"
    if ext in (".py", ".sql", ".sh", ".json"):
        return "Source Code"
    if ext in (".csv", ".parquet", ".xlsx"):
        return "Dataset"
    if ext in (".jpg", ".png", ".jpeg", ".webp"):
        return "Slide Image"
    if ext in (".pptx",):
        return "Slides"
    return "Resource"


def index_docs_manifest(docs_manifest: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Map lookup keys → doc entry for course-qualified and basename access."""
    out: dict[str, dict[str, Any]] = {}
    for key, entry in docs_manifest.items():
        if not isinstance(entry, dict):
            continue
        course = entry.get("course") or ""
        name = entry.get("name") or ""
        basename = name.split("/")[-1] if name else ""
        key_base = str(key).split("/")[-1]
        candidates = {
            str(key),
            str(key).lower(),
            name,
            name.lower() if name else "",
            basename,
            basename.lower() if basename else "",
            key_base,
            key_base.lower(),
        }
        if course and basename:
            candidates.add(f"{course}/{basename}")
            candidates.add(f"{course}/{basename}".lower())
        if course and name:
            candidates.add(f"{course}/{name}")
        for cand in candidates:
            if cand and cand not in out:
                out[cand] = entry
    return out


def resolve_doc_claim(
    course_key: str,
    item: dict[str, Any],
    docs_index: dict[str, dict[str, Any]],
    claim_prefix: str | None = None,
) -> tuple[str, str] | None:
    """Return (claim_name, claim_id) for a material item when course-owned."""
    filenames = [
        item.get("clean_filename") or "",
        item.get("orig_filename") or "",
        item.get("title") or "",
    ]
    for raw in filenames:
        if not raw:
            continue
        for cand in (
            raw,
            raw.lower(),
            f"{course_key}/{raw}",
            f"{course_key}/{raw}".lower(),
            raw.split("/")[-1],
            raw.split("/")[-1].lower(),
        ):
            entry = docs_index.get(cand)
            if not entry:
                continue
            entry_course = entry.get("course") or ""
            if entry_course and entry_course != course_key:
                continue
            cname = entry.get("claim_name") or ""
            cid = entry.get("claim_id") or ""
            if not cname or not cid:
                continue
            if not claim_belongs_to_course(cname, course_key, claim_prefix):
                continue
            return cname, cid

    # Keep existing claim only when it is already a course-owned document claim.
    cname = item.get("claim_name") or ""
    cid = item.get("claim_id") or ""
    if cname and cid and is_document_claim(cname) and claim_belongs_to_course(cname, course_key, claim_prefix):
        return cname, cid
    return None


def repair_curricula_item(
    course: dict[str, Any],
    item: dict[str, Any],
    *,
    docs_index: dict[str, dict[str, Any]],
    video_ids: set[str],
    video_claims: set[str],
) -> dict[str, Any]:
    """Return a cleaned copy of one curricula item."""
    out = dict(item)
    course_key = course["course_key"]
    claim_prefix = course.get("claim_prefix")

    if is_material_item(out):
        out["kind"] = "study"
        resolved = resolve_doc_claim(course_key, out, docs_index, claim_prefix)
        stolen = False
        cname = out.get("claim_name") or ""
        if cname in video_claims or (cname and not is_document_claim(cname)):
            stolen = True
        if cname and not claim_belongs_to_course(cname, course_key, claim_prefix):
            stolen = True
        if resolved:
            out["claim_name"], out["claim_id"] = resolved
            out.pop("video_url", None)
            out.pop("stream_url", None)
        elif stolen:
            out.pop("claim_name", None)
            out.pop("claim_id", None)
            out.pop("video_url", None)
            out.pop("stream_url", None)

        filename = out.get("clean_filename") or out.get("orig_filename") or out.get("title") or "material"
        mid = material_id(course_key, filename)
        # Never let study items reuse a video lesson id.
        if out.get("video_id") in video_ids or not out.get("video_id"):
            out["material_id"] = mid
            out.pop("video_id", None)
        else:
            out["material_id"] = out.get("material_id") or mid
            # Keep orphan study-only ids as material_id, drop lesson semantics.
            out.pop("video_id", None)
        return out

    # Video path
    out["kind"] = "video"
    cname = out.get("claim_name") or ""
    if is_document_claim(cname) or (
        cname and not claim_belongs_to_course(cname, course_key, claim_prefix)
    ):
        out.pop("claim_name", None)
        out.pop("claim_id", None)
        out.pop("video_url", None)
        out.pop("stream_url", None)
    idx = out.get("idx")
    out["video_id"] = lesson_id_for(course_key, idx, out.get("msg_id"), out.get("video_id"))
    return out


def repair_course_items(
    course: dict[str, Any],
    docs_index: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    items = list(course.get("items") or [])
    video_ids = {
        str(i.get("video_id"))
        for i in items
        if is_video_item(i) and i.get("video_id")
    }
    video_claims = {
        str(i.get("claim_name"))
        for i in items
        if is_video_item(i) and i.get("claim_name")
    }
    repaired = [
        repair_curricula_item(
            course,
            item,
            docs_index=docs_index,
            video_ids=video_ids,
            video_claims=video_claims,
        )
        for item in items
    ]
    return repaired


def partition_items(items: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    videos: list[dict[str, Any]] = []
    materials: list[dict[str, Any]] = []
    for item in items:
        if is_material_item(item):
            materials.append(item)
        elif is_video_item(item):
            videos.append(item)
    return videos, materials


def detect_cross_course_contamination(
    curricula: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Find claim_ids attached to more than one course after classification."""
    owners: dict[str, set[str]] = {}
    meta: dict[str, dict[str, Any]] = {}
    for course in curricula:
        ck = course["course_key"]
        for item in course.get("items") or []:
            cid = item.get("claim_id")
            if not cid:
                continue
            owners.setdefault(cid, set()).add(ck)
            meta[cid] = {
                "claim_id": cid,
                "claim_name": item.get("claim_name"),
                "kind": item.get("kind"),
            }
    findings = []
    for cid, courses in owners.items():
        if len(courses) > 1:
            findings.append({**meta[cid], "courses": sorted(courses)})
    return findings


def normalize_relative_path(course_key: str, filename: str) -> str:
    name = filename.replace("\\", "/").split("/")[-1]
    return f"courses/{course_key}/{name}"


VIDEO_EXTENSIONS = frozenset({".mp4", ".m4v", ".mkv", ".webm", ".mov", ".ts"})


def is_material_filename(filename: str | None) -> bool:
    """True when basename looks like a companion document (not a video / junk)."""
    if not filename:
        return False
    name = filename.replace("\\", "/").split("/")[-1]
    if not name or name.startswith("._") or name.startswith("."):
        return False
    lower = name.lower()
    if any(lower.endswith(ext) for ext in VIDEO_EXTENSIONS):
        return False
    # Truncated video titles sometimes land in materials without a real extension
    # (e.g. "...-mp4 mp4 Batch Name....mp").
    if lower.endswith(".mp") or " mp4 " in f" {lower} " or lower.endswith("-mp4"):
        return False
    return _endswith_doc(name)


def resolve_material_relative_path(
    course_key: str,
    filename: str,
    *,
    root: str | None = None,
    preferred: str | None = None,
) -> str:
    """Pick a path relative to CF_ARTIFACT_ROOT that actually exists when possible.

    Search order:
      1. preferred (if it resolves under root)
      2. courses/<course>/<file>
      3. data/materials/<course>/<file>
      4. materials/<course>/<file>
      5. normalize_relative_path fallback (courses/...)
    """
    from pathlib import Path

    name = filename.replace("\\", "/").split("/")[-1]
    base = Path(root) if root else Path(__file__).resolve().parents[1]
    candidates: list[str] = []
    if preferred:
        pref = preferred.replace("\\", "/").lstrip("/")
        # Historic bug: generators wrote under data/materials but DB stored materials/...
        if pref.startswith("materials/") and not pref.startswith("data/materials/"):
            candidates.append(f"data/{pref}")
        candidates.append(pref)
        if pref.startswith("data/materials/"):
            candidates.append(pref[len("data/") :])
    candidates.extend(
        [
            f"courses/{course_key}/{name}",
            f"data/materials/{course_key}/{name}",
            f"materials/{course_key}/{name}",
        ]
    )
    seen: set[str] = set()
    for rel in candidates:
        if not rel or rel in seen:
            continue
        seen.add(rel)
        if (base / rel).is_file():
            return rel
    return normalize_relative_path(course_key, name)


_WEEK_RE = re.compile(r"\bweek\s*0*(\d+)\b", re.I)
_MODULE_RE = re.compile(r"\bmodule\s*0*(\d+)\b", re.I)
_BRACKET_IDX_RE = re.compile(r"^\[(\d+)\]")


def _norm_section(value: str | None) -> str:
    return re.sub(r"\s+", " ", (value or "").strip().lower())


def infer_material_placement(
    *,
    filename: str,
    title: str | None = None,
    module_title: str | None = None,
    preferred_lesson_id: str | None = None,
    lessons: list[dict[str, Any]] | None = None,
) -> tuple[str, str | None, str]:
    """Return (scope, lesson_id, section_title) for a material.

    Preference:
      1. preferred_lesson_id when it exists in ``lessons``
      2. section match via Module/Week number or topic substring
      3. course scope (visible on every lesson in the Go player)
    """
    lessons = lessons or []
    lesson_ids = {str(l.get("id")) for l in lessons if l.get("id")}
    if preferred_lesson_id and str(preferred_lesson_id) in lesson_ids:
        hit = next(l for l in lessons if str(l.get("id")) == str(preferred_lesson_id))
        return "lesson", str(preferred_lesson_id), str(hit.get("section_title") or "")

    hay = f"{module_title or ''} {title or ''} {filename}"
    sections = []
    for lesson in lessons:
        sec = str(lesson.get("section_title") or "").strip()
        if sec and sec not in sections:
            sections.append(sec)

    week_m = _WEEK_RE.search(hay) or re.search(r"week\s*0*(\d+)", hay, re.I)
    module_m = _MODULE_RE.search(hay)
    if week_m:
        week_n = int(week_m.group(1))
        week_pat = re.compile(rf"(?<![0-9])0*{week_n}(?![0-9])")
        for sec in sections:
            sm = _WEEK_RE.search(sec) or re.search(r"week\s*0*(\d+)", sec, re.I)
            if sm and int(sm.group(1)) == week_n:
                return "section", None, sec
            # TrendyTech style: "Module 01: Week 01 — ..." (digit-bounded)
            if re.search(r"week\s*", sec, re.I) and week_pat.search(
                re.split(r"week\s*", sec, maxsplit=1, flags=re.I)[-1]
            ):
                return "section", None, sec
    if module_m:
        mod_n = int(module_m.group(1))
        for sec in sections:
            sm = _MODULE_RE.search(sec)
            if sm and int(sm.group(1)) == mod_n:
                return "section", None, sec

    # Topic after "Module NN - " in generated companion filenames.
    topic = None
    tm = re.search(r"Module\s*0*\d+\s*[-:–—]\s*(.+?)(?:\.(?:pdf|zip|txt|pptx?|docx?))?$", filename, re.I)
    if tm:
        topic = tm.group(1).strip()
    if topic:
        topic_n = _norm_section(topic)
        for sec in sections:
            sec_n = _norm_section(sec)
            if topic_n == sec_n or topic_n in sec_n or sec_n in topic_n:
                return "section", None, sec

    if module_title:
        mod_n = _norm_section(module_title)
        for sec in sections:
            sec_n = _norm_section(sec)
            if mod_n == sec_n or mod_n in sec_n or sec_n in mod_n:
                return "section", None, sec

    # Do not keep orphan single-lesson dumps: course scope makes companions
    # available across the classroom study rail / materials browser.
    return "course", None, (module_title or "")


_SLUG_RE = re.compile(r"[^a-z0-9]+")


def make_slug(value: str) -> str:
    slug = _SLUG_RE.sub("-", value.lower()).strip("-")
    return re.sub(r"-+", "-", slug)
