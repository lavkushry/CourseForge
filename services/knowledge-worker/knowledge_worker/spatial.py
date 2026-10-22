"""Rank moments that are good candidates for a later spatial view.

Uses only artifacts the indexing pipeline already produced: timestamped
transcript segments, scene-change keyframes, OCR, optional vision captions,
and concept chapters. This module does not render 3D, meshes, or AR/VR assets
and does not call a model.

Minimal signals (each is optional; a missing signal scores 0 and never aborts):

1. on_screen_diagram — OCR text, a label-like layout, an OCR ``diagram`` tag,
   or a vision caption shows a diagram or architecture. On-screen evidence is
   preferred over narration.
2. spoken_architecture — transcript overlapping the moment describes structure
   (layers, flows, topology, components).
3. screen_text — OCR or a vision caption is present and is not only a code or
   command slide.
4. concept_agreement — token overlap between the concept graph (title and
   summary of concepts covering this time) and on-screen text (OCR and/or
   vision caption). Pairs are skipped when either side is missing. Transcript
   words are not treated as agreement.

Scoring, then ranked by confidence and start time::

    diagram = on_screen_diagram if that is > 0 else 0.70 if spoken else 0
    confidence = clamp01(
        0.55 * diagram
      + 0.30 * concept_agreement
      + 0.10 * screen_text
      + 0.05 * spoken_architecture
    )

Moments with no on-screen diagram and weak concept agreement are capped at
0.49 so a clearly described architecture can still appear, below a diagram.
Candidates below 0.40 are omitted.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, field
from typing import Any, Sequence


_STRONG_WORDS = re.compile(
    r"\b("
    r"diagrams?|architectures?|topolog(?:y|ies)|flowcharts?|schematics?|"
    r"pipelines?|layers?|clusters?|nodes?|components?|"
    r"upstream|downstream|microservices?|"
    r"control plane|data plane|request path|data flow|system design|"
    r"load balancers?"
    r")\b",
    re.IGNORECASE,
)
_RELATIONAL = re.compile(
    r"\b("
    r"consists of|made up of|flows? into|talks to|connected to|"
    r"sits between|between the|in front of|behind the|"
    r"three tiers?|multi-tier|n-tier"
    r")\b",
    re.IGNORECASE,
)
_ARROW = re.compile(r"(?:->|=>|→|←)")
_AGENDA = re.compile(
    r"\b(agenda|overview|summary|objectives|questions|homework|outline|welcome)\b",
    re.IGNORECASE,
)
_TOKEN = re.compile(r"[a-z0-9]{3,}")
_VISUAL_SPLIT = re.compile(r"\n+Visual explanation:\s*", re.IGNORECASE)
_STOP = frozenset(
    """
    a an the of and or to in on for with is are was were this that from by as at
    into it its be we you how what when where which who your our their them then
    than not can will just about over under after before out off all any some such
    """.split()
)

_MIN_CONFIDENCE = 0.40
_SPEECH_CAP = 0.49
_MAX_CANDIDATES = 40


@dataclass(frozen=True)
class SpatialCandidate:
    start_ms: int
    end_ms: int
    confidence: float
    reason: str
    keyframe_ordinal: int | None
    keyframe_id: str
    keyframe_path: str
    keyframe_time_ms: int | None
    ocr_snippet: str
    vision_snippet: str
    concept_ids: tuple[str, ...]
    on_screen_diagram: float
    spoken_architecture: float
    screen_text: float
    concept_agreement: float

    def as_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "ordinal": 0,
            "start_ms": self.start_ms,
            "end_ms": self.end_ms,
            "confidence": self.confidence,
            "reason": self.reason,
            "ocr_snippet": self.ocr_snippet,
            "vision_snippet": self.vision_snippet,
            "concept_ids": list(self.concept_ids),
            "signals": {
                "on_screen_diagram": self.on_screen_diagram,
                "spoken_architecture": self.spoken_architecture,
                "screen_text": self.screen_text,
                "concept_agreement": self.concept_agreement,
            },
        }
        if self.keyframe_id:
            payload["keyframe_id"] = self.keyframe_id
        if self.keyframe_ordinal is not None:
            payload["keyframe_ordinal"] = self.keyframe_ordinal
        return payload


@dataclass
class _Frame:
    ordinal: int
    time_ms: int
    path: str
    keyframe_id: str
    ocr_text: str
    ocr_tags: tuple[str, ...]
    vision_caption: str


@dataclass
class _Concept:
    concept_id: str
    ordinal: int
    title: str
    summary: str
    start_ms: int
    end_ms: int
    tokens: set[str] = field(default_factory=set)


@dataclass
class _Segment:
    start_ms: int
    end_ms: int
    text: str


def _ms(item: dict[str, Any], *ms_keys: str, sec_keys: tuple[str, ...] = ()) -> int:
    for key in ms_keys:
        if item.get(key) is not None:
            return max(0, int(item[key]))
    for key in sec_keys:
        if item.get(key) is not None:
            return max(0, int(float(item[key]) * 1000))
    return 0


def _tokens(text: str) -> set[str]:
    return {tok for tok in _TOKEN.findall(text.lower()) if tok not in _STOP}


def _snippet(text: str, limit: int = 240) -> str:
    flat = " ".join(text.split())
    if len(flat) <= limit:
        return flat
    return flat[: limit - 1].rstrip() + "…"


def _has_structure(text: str) -> bool:
    return bool(text and (_STRONG_WORDS.search(text) or _RELATIONAL.search(text)))


def _label_layout(text: str) -> bool:
    if not text or (_AGENDA.search(text) and not _has_structure(text)):
        return False
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    short = [ln for ln in lines if 1 <= len(ln.split()) <= 4 and len(ln) <= 32]
    return len(lines) >= 4 and len(short) >= 3


def _split_screen(raw: str) -> tuple[str, str]:
    """Separate academy-style 'Visual explanation:' captions from OCR text."""
    if not raw:
        return "", ""
    parts = _VISUAL_SPLIT.split(raw, maxsplit=1)
    ocr = parts[0]
    ocr = re.sub(r"^On-screen OCR:\s*", "", ocr, count=1, flags=re.IGNORECASE).strip()
    caption = parts[1].strip() if len(parts) > 1 else ""
    return ocr, caption


def _frames(keyframes: Sequence[dict[str, Any]] | None) -> list[_Frame]:
    frames: list[_Frame] = []
    for ordinal, raw in enumerate(keyframes or []):
        if not isinstance(raw, dict):
            continue
        ocr = raw.get("ocr") if isinstance(raw.get("ocr"), dict) else {}
        ocr_text = str(ocr.get("text") or raw.get("ocr_text") or raw.get("text") or "")
        caption = str(raw.get("vision_caption") or raw.get("caption") or "")
        if not caption:
            ocr_text, embedded = _split_screen(ocr_text)
            caption = embedded
        else:
            ocr_text, _ = _split_screen(ocr_text)
        tags = ocr.get("tags") or raw.get("tags") or []
        tag_tuple = tuple(str(tag) for tag in tags if str(tag).strip())
        frames.append(
            _Frame(
                ordinal=int(raw.get("ordinal", ordinal)),
                time_ms=_ms(raw, "time_ms", sec_keys=("start", "time")),
                path=str(raw.get("path") or raw.get("frame_path") or ""),
                keyframe_id=str(raw.get("id") or ""),
                ocr_text=ocr_text.strip(),
                ocr_tags=tag_tuple,
                vision_caption=caption.strip(),
            )
        )
    frames.sort(key=lambda frame: (frame.time_ms, frame.ordinal))
    return frames


def _concepts(concepts: Sequence[dict[str, Any]] | None) -> list[_Concept]:
    out: list[_Concept] = []
    for ordinal, raw in enumerate(concepts or []):
        if not isinstance(raw, dict):
            continue
        title = str(raw.get("title") or "").strip()
        summary = str(raw.get("summary") or "").strip()
        start_ms = _ms(raw, "start_ms", sec_keys=("start",))
        end_ms = _ms(raw, "end_ms", sec_keys=("end",))
        if end_ms < start_ms:
            end_ms = start_ms
        concept_ordinal = int(raw.get("ordinal", ordinal))
        concept_id = str(raw.get("id") or f"ordinal:{concept_ordinal}")
        out.append(
            _Concept(
                concept_id=concept_id,
                ordinal=concept_ordinal,
                title=title,
                summary=summary,
                start_ms=start_ms,
                end_ms=end_ms,
                tokens=_tokens(f"{title} {summary}"),
            )
        )
    return out


def _segments(segments: Sequence[dict[str, Any]] | None) -> list[_Segment]:
    out: list[_Segment] = []
    for raw in segments or []:
        if not isinstance(raw, dict):
            continue
        text = str(raw.get("text") or "").strip()
        if not text:
            continue
        start_ms = _ms(raw, "start_ms", sec_keys=("start",))
        end_ms = _ms(raw, "end_ms", sec_keys=("end",))
        if end_ms < start_ms:
            end_ms = start_ms
        out.append(_Segment(start_ms=start_ms, end_ms=end_ms, text=text))
    return out


def _screen_diagram(frame: _Frame | None) -> float:
    if frame is None:
        return 0.0
    if _has_structure(frame.vision_caption):
        return 1.0
    if _has_structure(frame.ocr_text) or "diagram" in frame.ocr_tags:
        return 1.0
    code_only = bool(set(frame.ocr_tags) & {"code", "command"}) and not _has_structure(frame.ocr_text)
    if code_only:
        return 0.0
    if _label_layout(frame.ocr_text) or _ARROW.search(frame.ocr_text) or _ARROW.search(frame.vision_caption):
        return 0.85
    return 0.0


def _usable_ocr(frame: _Frame | None, screen_diagram: float) -> str:
    if frame is None or not frame.ocr_text:
        return ""
    code_only = bool(set(frame.ocr_tags) & {"code", "command"}) and screen_diagram <= 0
    if code_only:
        return ""
    return frame.ocr_text


def _agreement(concept_tokens: set[str], ocr_text: str, vision: str) -> float:
    pairs: list[float] = []
    ocr_tokens = _tokens(ocr_text)
    vision_tokens = _tokens(vision)

    def coeff(left: set[str], right: set[str]) -> float:
        if not left or not right:
            return 0.0
        return len(left & right) / min(len(left), len(right))

    # Concept agreement is the concept graph against on-screen text.
    # OCR and a caption can match each other without matching the concept.
    if concept_tokens and ocr_tokens:
        pairs.append(coeff(concept_tokens, ocr_tokens))
    if concept_tokens and vision_tokens:
        pairs.append(coeff(concept_tokens, vision_tokens))
    if not pairs:
        return 0.0
    return sum(pairs) / len(pairs)


def _transcript_text(segments: Sequence[_Segment], start_ms: int, end_ms: int) -> str:
    parts: list[str] = []
    for seg in segments:
        if seg.end_ms <= start_ms or seg.start_ms >= end_ms:
            continue
        parts.append(seg.text)
    return " ".join(parts)


def _reason(title: str, ocr_snippet: str, vision_snippet: str, screen_diagram: float, agreement: float) -> str:
    named = f" “{title}”" if title else ""
    if screen_diagram > 0 and agreement >= 0.2 and title:
        text = (
            f"On-screen diagram agrees with concept{named}. "
            "A spatial view would show how these parts connect instead of a flat slide."
        )
    elif screen_diagram > 0 and vision_snippet:
        text = (
            f"The frame is described as a diagram{named}. "
            "A spatial view would make the named relationships easier to see."
        )
    elif screen_diagram > 0:
        label = ocr_snippet.split(" ")[0:8]
        hint = " ".join(label) if label else "the labels"
        text = (
            f"On-screen text looks like an architecture diagram ({hint}). "
            "A spatial view would place those labels in the structure they belong to."
        )
    elif title:
        text = (
            f"The lecture describes the structure of{named}. "
            "A spatial view would turn that description into something a student can look around."
        )
    else:
        text = (
            "The narration describes how parts relate. "
            "A spatial view would help a student see that structure."
        )
    if len(text) > 480:
        return text[:479].rstrip() + "…"
    return text


def _clamp01(value: float) -> float:
    if value < 0:
        return 0.0
    if value > 1:
        return 1.0
    return value


def _score_window(
    *,
    start_ms: int,
    end_ms: int,
    frame: _Frame | None,
    concepts: Sequence[_Concept],
    segments: Sequence[_Segment],
) -> SpatialCandidate | None:
    if end_ms < start_ms:
        end_ms = start_ms
    if end_ms == start_ms:
        end_ms = start_ms + 1000
    screen_diagram = _screen_diagram(frame)
    ocr_text = _usable_ocr(frame, screen_diagram)
    vision = frame.vision_caption if frame else ""
    spoken_flag = 1.0 if _has_structure(_transcript_text(segments, start_ms, end_ms)) else 0.0
    diagram = screen_diagram if screen_diagram > 0 else (0.70 if spoken_flag else 0.0)
    covering = [c for c in concepts if c.start_ms < end_ms and c.end_ms > start_ms]
    concept_tokens: set[str] = set()
    for concept in covering:
        concept_tokens |= concept.tokens
    agreement = _agreement(concept_tokens, ocr_text, vision)
    screen_flag = 1.0 if (ocr_text or vision) else 0.0
    confidence = _clamp01(0.55 * diagram + 0.30 * agreement + 0.10 * screen_flag + 0.05 * spoken_flag)
    on_screen_structure = screen_diagram > 0 or (screen_flag > 0 and agreement >= 0.45)
    if not on_screen_structure:
        confidence = min(confidence, _SPEECH_CAP)
    confidence = round(confidence, 4)
    if diagram <= 0 and agreement < 0.34:
        return None
    if confidence < _MIN_CONFIDENCE:
        return None
    concept_ids = tuple(concept.concept_id for concept in covering)
    title = ""
    if covering:
        title = max(covering, key=lambda concept: len(concept.tokens)).title
    ocr_snippet = _snippet(ocr_text)
    vision_snippet = _snippet(vision)
    cite_frame = frame is not None and (screen_diagram > 0 or bool(ocr_snippet) or bool(vision_snippet))
    return SpatialCandidate(
        start_ms=start_ms,
        end_ms=end_ms,
        confidence=confidence,
        reason=_reason(title, ocr_snippet, vision_snippet, screen_diagram, agreement),
        keyframe_ordinal=frame.ordinal if cite_frame else None,
        keyframe_id=frame.keyframe_id if cite_frame else "",
        keyframe_path=frame.path if frame else "",
        keyframe_time_ms=frame.time_ms if cite_frame else None,
        ocr_snippet=ocr_snippet,
        vision_snippet=vision_snippet,
        concept_ids=concept_ids,
        on_screen_diagram=round(screen_diagram, 4),
        spoken_architecture=spoken_flag,
        screen_text=screen_flag,
        concept_agreement=round(agreement, 4),
    )


def _keyframe_window(frame: _Frame, frames: Sequence[_Frame], concepts: Sequence[_Concept]) -> tuple[int, int]:
    """Keep the moment on this slide, clipped to the concept that contains it."""
    later = [other.time_ms for other in frames if other.time_ms > frame.time_ms]
    end_ms = frame.time_ms + 12_000
    if later:
        end_ms = min(end_ms, min(later))
    start_ms = frame.time_ms
    covering = [c for c in concepts if c.start_ms <= frame.time_ms <= c.end_ms]
    if covering:
        concept = min(covering, key=lambda item: (item.end_ms - item.start_ms, item.ordinal))
        start_ms = max(concept.start_ms, frame.time_ms - 15_000)
        end_ms = min(concept.end_ms, max(end_ms, frame.time_ms + 1000))
    end_ms = min(end_ms, start_ms + 45_000)
    if end_ms <= start_ms:
        end_ms = start_ms + 1000
    return start_ms, end_ms


def _overlap_ratio(left: SpatialCandidate, right: SpatialCandidate) -> float:
    start = max(left.start_ms, right.start_ms)
    end = min(left.end_ms, right.end_ms)
    if end <= start:
        return 0.0
    shorter = max(1, min(left.end_ms - left.start_ms, right.end_ms - right.start_ms))
    return (end - start) / shorter


def rank_spatial_candidates(
    segments: Sequence[dict[str, Any]] | None,
    keyframes: Sequence[dict[str, Any]] | None,
    concepts: Sequence[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Return a confidence-ranked candidate list.

    Missing OCR, vision captions, or concepts score as zero. Callers that run
    during indexing must catch unexpected errors so a bad artifact cannot fail
    the job.
    """
    frames = _frames(keyframes)
    concept_rows = _concepts(concepts)
    segment_rows = _segments(segments)
    found: list[SpatialCandidate] = []
    covered: set[str] = set()

    for frame in frames:
        start_ms, end_ms = _keyframe_window(frame, frames, concept_rows)
        candidate = _score_window(
            start_ms=start_ms,
            end_ms=end_ms,
            frame=frame,
            concepts=concept_rows,
            segments=segment_rows,
        )
        if candidate is None:
            continue
        found.append(candidate)
        for concept in concept_rows:
            if concept.start_ms < end_ms and concept.end_ms > start_ms:
                covered.add(concept.concept_id)

    for concept in concept_rows:
        if concept.concept_id in covered:
            continue
        start_ms = concept.start_ms
        end_ms = concept.end_ms if concept.end_ms > concept.start_ms else concept.start_ms + 1000
        if end_ms - start_ms > 45_000:
            end_ms = start_ms + 45_000
        inside = [frame for frame in frames if start_ms <= frame.time_ms <= end_ms]
        frame = max(inside, key=_screen_diagram) if inside else None
        candidate = _score_window(
            start_ms=start_ms,
            end_ms=end_ms,
            frame=frame,
            concepts=concept_rows,
            segments=segment_rows,
        )
        if candidate is not None:
            found.append(candidate)

    found.sort(key=lambda item: (-item.confidence, item.start_ms))
    kept: list[SpatialCandidate] = []
    for candidate in found:
        if any(_overlap_ratio(candidate, prior) >= 0.5 for prior in kept):
            continue
        kept.append(candidate)
        if len(kept) >= _MAX_CANDIDATES:
            break
    payload = []
    for ordinal, candidate in enumerate(kept):
        item = candidate.as_dict()
        item["ordinal"] = ordinal
        payload.append(item)
    return payload


def load_bundle(path: str) -> dict[str, Any]:
    with open(path, encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise ValueError("spatial bundle must be a JSON object")
    return data


def score_bundle(bundle: dict[str, Any]) -> dict[str, Any]:
    lesson_id = str(bundle.get("lesson_id") or bundle.get("video_id") or "")
    candidates = rank_spatial_candidates(
        bundle.get("segments") or [],
        bundle.get("keyframes") or [],
        bundle.get("concepts") or [],
    )
    return {"lesson_id": lesson_id, "candidates": candidates}


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Rank spatial-view candidates from existing lecture artifacts"
    )
    sub = parser.add_subparsers(dest="cmd", required=True)
    score = sub.add_parser("score", help="Score a local transcript/keyframe/concept JSON bundle")
    score.add_argument("bundle", help="Path to a lecture artifact JSON object")
    score.add_argument("-o", "--output", help="Write the ranked list to this path")
    args = parser.parse_args(list(argv) if argv is not None else None)
    if args.cmd == "score":
        result = score_bundle(load_bundle(args.bundle))
        encoded = json.dumps(result, indent=2, ensure_ascii=False)
        if args.output:
            with open(args.output, "w", encoding="utf-8") as handle:
                handle.write(encoded)
                handle.write("\n")
        else:
            sys.stdout.write(encoded)
            sys.stdout.write("\n")
        return 0
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
