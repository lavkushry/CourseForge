"""Confidence gate for spatial assets (3D, AR, VR) built from lecture evidence.

A spatial asset is shown to a student only after this gate. High confidence can
be released automatically. Lower confidence is labeled or held. Missing signals
lower the score and never raise.
"""

from __future__ import annotations

import json
import re
from html import escape
from typing import Any, Mapping, Sequence
from urllib.parse import quote

# Weights sum to 1. Each missing signal contributes 0.
OCR_WEIGHT = 0.35
CAPTION_WEIGHT = 0.30
CONCEPT_WEIGHT = 0.20
KEYFRAME_WEIGHT = 0.15

# score >= RELEASE_THRESHOLD → release
# LABEL_THRESHOLD <= score < RELEASE_THRESHOLD → label
# score < LABEL_THRESHOLD, or no lecture id / source second → hold
RELEASE_THRESHOLD = 0.75
LABEL_THRESHOLD = 0.45

_TOKEN = re.compile(r"[a-z0-9]{3,}")
_VISUAL_SPLIT = re.compile(r"\n+Visual explanation:\s*", re.IGNORECASE)
_STOP = frozenset(
    """
    a an the of and or to in on for with is are was were this that these those
    from by as at into it its be we you your our their them then than not can
    will just about over under after before out off all any some such how what
    where which who but also more most when
    """.split()
)

_LABEL_TEXT = "AI-generated — verify against original lecture at {timestamp}"
_HOLD_TEXT = "Withheld — this spatial asset is not part of the lecture."
_SOURCE_LINK_TEXT = "Original lecture at {timestamp}"


def score_spatial_confidence(signals: Any = None) -> float:
    """Score how well a spatial asset is grounded in the source lecture.

    Each component is in ``[0, 1]``. A missing or unusable signal is ``0``
    and does not raise. Weights::

        score = 0.35 * ocr
              + 0.30 * caption_transcript
              + 0.20 * concept_support
              + 0.15 * keyframe

    ``ocr``
        OCR confidence. Numbers in ``[0, 1]`` are used as-is. Numbers in
        ``(1, 100]`` are percents. Anything else, including a missing value,
        is ``0``.

    ``caption_transcript``
        Share of vision-caption content words that also appear in the
        transcript. Either side missing is ``0``.

    ``concept_support``
        Share of the visual claim's content words that also appear in
        concept-graph node titles or summaries. The claim is the vision
        caption, or the OCR text when the caption has no content words.
        No claim or no concept nodes is ``0``.

    ``keyframe``
        ``1`` when a source keyframe has a non-empty path and a time
        ``>= 0``. A width or height that is present and ``<= 0`` is not a
        clear frame, so the signal is ``0``.

    Content words are lowercase ``[a-z0-9]{3,}`` tokens after hyphens are
    removed, minus a fixed stopword list. Components are rounded to 4
    decimal places, then combined. The weighted sum is clamped to ``[0, 1]``
    and rounded to 4 decimal places.

    Release, label, and hold thresholds live on ``gate_spatial_asset``:
    ``0.75`` releases, ``0.45`` labels, and anything lower is held.
    """
    parts = signal_components(signals)
    raw = (
        OCR_WEIGHT * parts["ocr"]
        + CAPTION_WEIGHT * parts["caption_transcript"]
        + CONCEPT_WEIGHT * parts["concept_support"]
        + KEYFRAME_WEIGHT * parts["keyframe"]
    )
    if raw < 0:
        raw = 0.0
    if raw > 1:
        raw = 1.0
    return _round4(raw)


def signal_components(signals: Any = None) -> dict[str, float]:
    """Return the four unweighted components in ``[0, 1]``. Never raises."""
    try:
        data = _mapping(signals)
        return {
            "ocr": _round4(_ocr_component(data.get("ocr_confidence"))),
            "caption_transcript": _round4(
                _overlap(_text(data.get("vision_caption")), _text(data.get("transcript")))
            ),
            "concept_support": _round4(_concept_component(data)),
            "keyframe": _round4(
                _keyframe_component(
                    data.get("keyframe_path"),
                    data.get("keyframe_time_ms"),
                    data.get("width"),
                    data.get("height"),
                )
            ),
        }
    except Exception:
        return {"ocr": 0.0, "caption_transcript": 0.0, "concept_support": 0.0, "keyframe": 0.0}


def gate_spatial_asset(
    asset: Any = None,
    *,
    lecture_id: str = "",
    segments: Sequence[Any] | None = None,
    keyframes: Sequence[Any] | None = None,
    concepts: Any = None,
) -> dict[str, Any]:
    """Decide whether a student may see one spatial asset.

    ``score >= 0.75`` with a lecture id and a source second → ``release``.
    The asset can be shown automatically. The student still gets a link back
    to that exact second.

    ``0.45 <= score < 0.75`` with a lecture id and a source second → ``label``.
    The asset can be opened, and this warning is required and not dismissible::

        AI-generated — verify against original lecture at {timestamp}

    ``score < 0.45``, a missing lecture id, or a missing source second →
    ``hold``. The student does not get the asset as part of the lecture.
    When the source second is known, the response still includes it.

    ``timestamp`` is the source second as ``m:ss`` (the knowledge-panel clock),
    not a nearby chapter boundary. ``source_href`` is
    ``#learning/{lecture_id}?t={second}``.
    """
    resolved = resolve_spatial_signals(
        asset,
        lecture_id=lecture_id,
        segments=segments,
        keyframes=keyframes,
        concepts=concepts,
    )
    parts = signal_components(resolved)
    score = score_spatial_confidence(resolved)
    lecture = str(resolved.get("lecture_id") or "").strip()
    second = _source_second(resolved.get("source_second"))
    decision = _decision(score, lecture, second)
    timestamp = format_source_timestamp(second) if second is not None else ""
    source_link = _SOURCE_LINK_TEXT.format(timestamp=timestamp) if timestamp else ""
    href = ""
    if lecture and second is not None:
        href = f"#learning/{quote(lecture, safe='')}?t={second}"
    kind = resolved.get("kind")
    asset_id = resolved.get("asset_id")
    return {
        "asset_id": asset_id if isinstance(asset_id, str) else "",
        "kind": kind if isinstance(kind, str) else "",
        "score": score,
        "decision": decision,
        "show_asset": decision in ("release", "label"),
        "warning_required": decision == "label",
        "dismissible": False,
        "student_text": _student_text(decision, timestamp),
        "lecture_id": lecture,
        "source_second": second,
        "timestamp": timestamp,
        "source_href": href,
        "source_link_text": source_link,
        "signals": parts,
    }


def resolve_spatial_signals(
    asset: Any = None,
    *,
    lecture_id: str = "",
    segments: Sequence[Any] | None = None,
    keyframes: Sequence[Any] | None = None,
    concepts: Any = None,
) -> dict[str, Any]:
    """Fill a score input from an asset plus indexed lecture artifacts.

    Explicit asset fields win. Missing OCR, caption, transcript, concepts,
    and keyframe fields stay missing. Candidate-ranking ``confidence`` is not
    OCR confidence. Never raises.
    """
    try:
        return _resolve(
            asset,
            lecture_id=lecture_id,
            segments=segments,
            keyframes=keyframes,
            concepts=concepts,
        )
    except Exception:
        fallback = lecture_id.strip() if isinstance(lecture_id, str) else ""
        return _empty_signals(fallback)


def collect_spatial_assets(payload: Any = None, keyframes: Sequence[Any] | None = None) -> list[dict[str, Any]]:
    """Read spatial assets off a job payload and keyframe ``spatial`` blocks."""
    found: list[dict[str, Any]] = []
    data = _payload_dict(payload)
    for key in ("spatial_candidates", "spatial_assets"):
        raw = data.get(key)
        if not isinstance(raw, list):
            continue
        for item in raw:
            if isinstance(item, dict):
                found.append(dict(item))
    for frame in _sequence(keyframes):
        if not isinstance(frame, dict):
            continue
        spatial = frame.get("spatial")
        if not isinstance(spatial, dict):
            continue
        item = dict(spatial)
        if "keyframe_ordinal" not in item and frame.get("ordinal") is not None:
            item["keyframe_ordinal"] = frame.get("ordinal")
        if "keyframe_path" not in item and frame.get("path"):
            item["keyframe_path"] = frame.get("path")
        if "keyframe_time_ms" not in item and frame.get("time_ms") is not None:
            item["keyframe_time_ms"] = frame.get("time_ms")
        if "width" not in item and frame.get("width") is not None:
            item["width"] = frame.get("width")
        if "height" not in item and frame.get("height") is not None:
            item["height"] = frame.get("height")
        found.append(item)
    return found


def format_source_timestamp(second: int | None) -> str:
    """Format a source second as ``m:ss``, matching the knowledge panel clock."""
    if second is None or second < 0:
        return ""
    minutes, secs = divmod(int(second), 60)
    return f"{minutes}:{secs:02d}"


def render_spatial_inspect_html(cases: Sequence[Mapping[str, Any]]) -> str:
    """Render a static page that shows release, label, and hold."""
    cards: list[str] = []
    for case in cases:
        if not isinstance(case, Mapping):
            continue
        decision = str(case.get("decision") or "")
        title = escape(str(case.get("title") or decision or "Spatial asset"))
        student = escape(str(case.get("student_text") or ""))
        href = escape(str(case.get("source_href") or ""), quote=True)
        link = escape(str(case.get("source_link_text") or "Original lecture"))
        score = escape(str(case.get("score")))
        kind = escape(str(case.get("kind") or "spatial"))
        lecture = escape(str(case.get("lecture_id") or ""))
        timestamp = escape(str(case.get("timestamp") or ""))
        warning = ""
        if decision == "label":
            warning = f'<p class="spatial-warning" role="alert">{student}</p>'
        if decision in ("release", "label"):
            asset = (
                f'<div class="spatial-asset" data-kind="{kind}">'
                f"<p>Spatial asset slot ({kind})</p>"
                f"<p>Shown only after the confidence gate.</p>"
                f"</div>"
            )
        else:
            asset = f'<p class="spatial-held" role="status">{student}</p>'
        link_html = f'<a class="spatial-source" href="{href}">{link}</a>' if href else ""
        cards.append(
            f'<article class="spatial-card" data-decision="{escape(decision)}">'
            f"<h2>{title}</h2>"
            f'<p class="spatial-meta">Decision {escape(decision)} · score {score}'
            f" · lecture {lecture} · {timestamp}</p>"
            f"{warning}{asset}{link_html}"
            f"</article>"
        )
    body = "\n".join(cards)
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Spatial confidence gate</title>
<style>
  body {{ margin: 0; font: 16px/1.45 system-ui, sans-serif; background: #090e19; color: #f4f6fb; }}
  main {{ max-width: 880px; margin: 0 auto; padding: 32px 20px 64px; }}
  h1 {{ font-size: 1.6rem; margin: 0 0 8px; }}
  .lede {{ color: #b7c0d4; margin: 0 0 24px; }}
  .spatial-card {{ background: #121a2b; border: 1px solid #2a3650; border-radius: 12px; padding: 16px 18px; margin: 0 0 16px; }}
  h2 {{ margin: 0 0 8px; font-size: 1.1rem; }}
  .spatial-meta {{ color: #b7c0d4; margin: 0 0 12px; }}
  .spatial-warning {{ background: #3a2a12; color: #ffd9a0; border: 1px solid #e0a050; border-radius: 8px; padding: 10px 12px; margin: 0 0 12px; }}
  .spatial-asset {{ border: 1px dashed #6d7c99; border-radius: 8px; padding: 16px; margin: 0 0 12px; }}
  .spatial-held {{ margin: 0 0 12px; color: #ffb4b4; }}
  a.spatial-source {{ color: #ffb088; }}
  #jump {{ min-height: 1.4em; color: #d5f5d8; }}
</style>
</head>
<body>
<main>
  <h1>Spatial confidence gate</h1>
  <p class="lede">High confidence is released. A lower score stays labeled, and a weak score is withheld. The source link returns to the lecture second.</p>
  {body}
  <p id="jump" aria-live="polite"></p>
</main>
<script>
  document.querySelectorAll('a.spatial-source').forEach((anchor) => {{
    anchor.addEventListener('click', (event) => {{
      event.preventDefault();
      const live = document.getElementById('jump');
      if (live) live.textContent = 'Returning to ' + anchor.getAttribute('href');
    }});
  }});
</script>
</body>
</html>
"""


def _empty_signals(lecture_id: str) -> dict[str, Any]:
    return {
        "lecture_id": lecture_id,
        "source_second": None,
        "ocr_confidence": None,
        "vision_caption": None,
        "ocr_text": None,
        "transcript": None,
        "concepts": [],
        "keyframe_path": None,
        "keyframe_time_ms": None,
        "width": None,
        "height": None,
        "kind": "",
        "asset_id": "",
    }


def _decision(score: float, lecture_id: str, source_second: int | None) -> str:
    if not lecture_id or source_second is None:
        return "hold"
    if score >= RELEASE_THRESHOLD:
        return "release"
    if score >= LABEL_THRESHOLD:
        return "label"
    return "hold"


def _student_text(decision: str, timestamp: str) -> str:
    if decision == "release":
        return _SOURCE_LINK_TEXT.format(timestamp=timestamp) if timestamp else ""
    if decision == "label":
        return _LABEL_TEXT.format(timestamp=timestamp)
    if timestamp:
        return f"{_HOLD_TEXT} {_SOURCE_LINK_TEXT.format(timestamp=timestamp)}"
    return _HOLD_TEXT


def _resolve(
    asset: Any,
    *,
    lecture_id: str,
    segments: Sequence[Any] | None,
    keyframes: Sequence[Any] | None,
    concepts: Any,
) -> dict[str, Any]:
    data = _mapping(asset)
    frame = _matched_keyframe(data, keyframes)
    lecture = _first_text(data.get("lecture_id"), data.get("lesson_id"), data.get("video_id"), lecture_id)
    source_second = _explicit_second(data)
    if source_second is None and frame is not None:
        source_second = _seconds_from_ms(frame.get("time_ms"))
        if source_second is None:
            source_second = _source_second(frame.get("start"))
    ocr_confidence = data.get("ocr_confidence") if "ocr_confidence" in data else _frame_ocr_confidence(frame)
    ocr_text = _explicit_text(data, "ocr_text", "ocr_snippet")
    if ocr_text is None:
        ocr_text = _frame_ocr_text(frame)
    caption = _explicit_text(data, "vision_caption", "vision_snippet", "caption")
    if caption is None:
        caption = _frame_caption(frame)
    if "transcript" in data:
        transcript = _text(data.get("transcript")) or None
    else:
        transcript = _transcript_for(segments, data, frame)
    if "concepts" in data:
        concept_source: Any = data.get("concepts")
    else:
        concept_source = concepts
    concept_nodes = _concept_nodes(concept_source, data.get("concept_ids"))
    if "keyframe_path" in data:
        path = _text(data.get("keyframe_path")) or None
    else:
        path = None
        if frame is not None:
            path = _text(frame.get("path")) or _text(frame.get("frame_path")) or None
    if "keyframe_time_ms" in data:
        frame_time = _number(data.get("keyframe_time_ms"))
    elif frame is not None and frame.get("time_ms") is not None:
        frame_time = _number(frame.get("time_ms"))
    elif frame is not None and frame.get("start") is not None:
        secs = _number(frame.get("start"))
        frame_time = None if secs is None else secs * 1000
    else:
        frame_time = None
    width = data.get("width") if "width" in data else (frame.get("width") if frame else None)
    height = data.get("height") if "height" in data else (frame.get("height") if frame else None)
    kind = data.get("kind") if isinstance(data.get("kind"), str) else ""
    raw_id = data.get("id") if isinstance(data.get("id"), str) else data.get("asset_id")
    return {
        "lecture_id": lecture,
        "source_second": source_second,
        "ocr_confidence": ocr_confidence,
        "vision_caption": caption,
        "ocr_text": ocr_text,
        "transcript": transcript,
        "concepts": concept_nodes,
        "keyframe_path": path,
        "keyframe_time_ms": frame_time,
        "width": width,
        "height": height,
        "kind": kind,
        "asset_id": raw_id if isinstance(raw_id, str) else "",
    }


def _matched_keyframe(asset: Mapping[str, Any], keyframes: Sequence[Any] | None) -> dict[str, Any] | None:
    frames = [frame for frame in _sequence(keyframes) if isinstance(frame, dict)]
    if not frames:
        return None
    ordinal = asset.get("keyframe_ordinal")
    if ordinal is not None:
        for frame in frames:
            if frame.get("ordinal") == ordinal:
                return frame
    wanted_id = asset.get("keyframe_id")
    if isinstance(wanted_id, str) and wanted_id:
        for frame in frames:
            if frame.get("id") == wanted_id or frame.get("keyframe_id") == wanted_id:
                return frame
    path = asset.get("keyframe_path")
    if isinstance(path, str) and path:
        for frame in frames:
            if frame.get("path") == path or frame.get("frame_path") == path:
                return frame
    return None


def _frame_ocr_confidence(frame: Mapping[str, Any] | None) -> Any:
    if not frame:
        return None
    ocr = frame.get("ocr")
    if isinstance(ocr, Mapping) and "confidence" in ocr:
        return ocr.get("confidence")
    return None


def _frame_ocr_text(frame: Mapping[str, Any] | None) -> str | None:
    if not frame:
        return None
    ocr = frame.get("ocr")
    if isinstance(ocr, Mapping) and _text(ocr.get("text")):
        ocr_text, _caption = _split_screen(_text(ocr.get("text")))
        return ocr_text or None
    raw = _text(frame.get("text"))
    if not raw:
        return None
    ocr_text, _caption = _split_screen(raw)
    return ocr_text or None


def _frame_caption(frame: Mapping[str, Any] | None) -> str | None:
    if not frame:
        return None
    for key in ("vision_caption", "vision_snippet", "caption"):
        if _text(frame.get(key)):
            return _text(frame.get(key))
    raw = _text(frame.get("text"))
    if raw and "visual explanation:" in raw.lower():
        _ocr, caption = _split_screen(raw)
        return caption or None
    ocr = frame.get("ocr")
    if isinstance(ocr, Mapping):
        ocr_raw = _text(ocr.get("text"))
        if ocr_raw and "visual explanation:" in ocr_raw.lower():
            _ocr, caption = _split_screen(ocr_raw)
            return caption or None
    return None


def _split_screen(raw: str) -> tuple[str, str]:
    parts = _VISUAL_SPLIT.split(raw, maxsplit=1)
    ocr = re.sub(r"^On-screen OCR:\s*", "", parts[0], count=1, flags=re.IGNORECASE).strip()
    caption = parts[1].strip() if len(parts) > 1 else ""
    return ocr, caption


def _transcript_for(
    segments: Sequence[Any] | None,
    asset: Mapping[str, Any],
    frame: Mapping[str, Any] | None,
) -> str | None:
    rows = [row for row in _sequence(segments) if isinstance(row, Mapping)]
    if not rows:
        return None
    start_ms = _number(asset.get("start_ms"))
    end_ms = _number(asset.get("end_ms"))
    if start_ms is None:
        start_ms = _seconds_to_ms(asset.get("start"))
    if end_ms is None:
        end_ms = _seconds_to_ms(asset.get("end"))
    if start_ms is None and frame is not None:
        start_ms = _number(frame.get("time_ms"))
        if start_ms is None:
            start_ms = _seconds_to_ms(frame.get("start"))
    if start_ms is None:
        second = _explicit_second(asset)
        if second is not None:
            start_ms = float(second * 1000)
    if start_ms is None:
        return None
    if end_ms is None:
        end_ms = start_ms
    window_start = start_ms - 15_000
    window_end = end_ms + 15_000
    parts: list[str] = []
    for row in rows:
        row_start = _number(row.get("start_ms"))
        row_end = _number(row.get("end_ms"))
        if row_start is None:
            row_start = _seconds_to_ms(row.get("start"))
        if row_end is None:
            row_end = _seconds_to_ms(row.get("end"))
        if row_start is None or row_end is None:
            continue
        if row_end < window_start or row_start > window_end:
            continue
        text = _text(row.get("text"))
        if text:
            parts.append(text)
    if not parts:
        return None
    return " ".join(parts)


def _concept_nodes(concepts: Any, concept_ids: Any) -> list[dict[str, str]]:
    nodes = _flatten_concepts(concepts)
    if not isinstance(concept_ids, (list, tuple)):
        return nodes
    ids = {str(item) for item in concept_ids if item is not None and str(item).strip()}
    if not ids:
        return nodes
    return [node for node in nodes if node.get("id") in ids]


def _flatten_concepts(concepts: Any) -> list[dict[str, str]]:
    if concepts is None:
        return []
    if isinstance(concepts, str):
        text = concepts.strip()
        return [{"id": "", "title": text, "summary": ""}] if text else []
    if isinstance(concepts, Mapping):
        nested = concepts.get("nodes")
        if nested is None:
            nested = concepts.get("concepts")
        nodes = _flatten_concepts(nested) if nested is not None else []
        title = _text(concepts.get("title"))
        summary = _text(concepts.get("summary"))
        if title or summary:
            node_id = concepts.get("id")
            nodes.append({"id": node_id if isinstance(node_id, str) else "", "title": title, "summary": summary})
        return nodes
    if isinstance(concepts, (list, tuple)):
        nodes: list[dict[str, str]] = []
        for item in concepts:
            nodes.extend(_flatten_concepts(item))
        return nodes
    return []


def _concept_component(data: Mapping[str, Any]) -> float:
    claim = _text(data.get("vision_caption"))
    if not _tokens(claim):
        claim = _text(data.get("ocr_text"))
    if not _tokens(claim):
        return 0.0
    nodes = _flatten_concepts(data.get("concepts"))
    if not nodes:
        return 0.0
    corpus_parts: list[str] = []
    for node in nodes:
        corpus_parts.append(node.get("title") or "")
        corpus_parts.append(node.get("summary") or "")
    return _overlap(claim, " ".join(corpus_parts))


def _overlap(claim: str, support: str) -> float:
    claim_tokens = _tokens(claim)
    support_tokens = _tokens(support)
    if not claim_tokens or not support_tokens:
        return 0.0
    return len(claim_tokens & support_tokens) / len(claim_tokens)


def _tokens(text: str) -> set[str]:
    if not text:
        return set()
    lowered = text.lower().replace("-", "")
    return {tok for tok in _TOKEN.findall(lowered) if tok not in _STOP}


def _ocr_component(value: Any) -> float:
    number = _number(value)
    if number is None or number < 0:
        return 0.0
    if number <= 1:
        return number
    if number <= 100:
        return number / 100.0
    return 0.0


def _keyframe_component(path: Any, time_ms: Any, width: Any, height: Any) -> float:
    if not isinstance(path, str) or not path.strip():
        return 0.0
    moment = _number(time_ms)
    if moment is None or moment < 0:
        return 0.0
    if width is not None:
        parsed = _number(width)
        if parsed is None or parsed <= 0:
            return 0.0
    if height is not None:
        parsed = _number(height)
        if parsed is None or parsed <= 0:
            return 0.0
    return 1.0


def _explicit_second(data: Mapping[str, Any]) -> int | None:
    if "source_second" in data or "sourceSecond" in data:
        return _source_second(data.get("source_second", data.get("sourceSecond")))
    if "time_ms" in data:
        return _seconds_from_ms(data.get("time_ms"))
    if "start_ms" in data:
        return _seconds_from_ms(data.get("start_ms"))
    if "start" in data:
        return _source_second(data.get("start"))
    return None


def _source_second(value: Any) -> int | None:
    number = _number(value)
    if number is None or number < 0:
        return None
    return int(number)


def _seconds_from_ms(value: Any) -> int | None:
    number = _number(value)
    if number is None or number < 0:
        return None
    return int(number // 1000)


def _seconds_to_ms(value: Any) -> float | None:
    number = _number(value)
    if number is None:
        return None
    return number * 1000


def _explicit_text(data: Mapping[str, Any], *keys: str) -> str | None:
    for key in keys:
        if key in data:
            return _text(data.get(key)) or None
    return None


def _first_text(*values: Any) -> str:
    for value in values:
        text = _text(value)
        if text:
            return text
    return ""


def _text(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    return ""


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        number = float(value)
    elif isinstance(value, str):
        try:
            number = float(value.strip())
        except ValueError:
            return None
    else:
        return None
    if number != number or number in (float("inf"), float("-inf")):
        return None
    return number


def _mapping(value: Any) -> dict[str, Any]:
    if isinstance(value, Mapping):
        return dict(value)
    return {}


def _sequence(value: Any) -> list[Any]:
    if value is None or isinstance(value, (str, bytes, Mapping)):
        return []
    try:
        return list(value)
    except TypeError:
        return []


def _payload_dict(payload: Any) -> dict[str, Any]:
    if isinstance(payload, Mapping):
        return dict(payload)
    if isinstance(payload, str):
        try:
            parsed = json.loads(payload)
        except json.JSONDecodeError:
            return {}
        return dict(parsed) if isinstance(parsed, Mapping) else {}
    return {}


def _round4(value: float) -> float:
    return round(float(value) + 1e-12, 4)
