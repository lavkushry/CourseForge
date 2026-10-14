"""TextTiling-style semantic chaptering into concept segments."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Sequence

from knowledge_worker.embedder import Embedder, HashEmbedder, cosine


@dataclass(frozen=True)
class ConceptChapter:
    ordinal: int
    start_ms: int
    end_ms: int
    title: str
    summary: str


def _window_text(segments: Sequence[dict[str, Any]], start: int, end: int) -> str:
    return " ".join(str(segments[i].get("text", "")).strip() for i in range(start, end) if str(segments[i].get("text", "")).strip())


def _smooth(values: list[float], radius: int) -> list[float]:
    if radius <= 0 or len(values) <= 1:
        return list(values)
    out: list[float] = []
    for i in range(len(values)):
        lo = max(0, i - radius)
        hi = min(len(values), i + radius + 1)
        out.append(sum(values[lo:hi]) / (hi - lo))
    return out


def _title_from_text(text: str, limit: int = 48) -> str:
    words = text.split()
    if not words:
        return "Concept"
    title = " ".join(words[:8])
    if len(title) > limit:
        title = title[: limit - 1].rstrip() + "…"
    return title[0].upper() + title[1:] if title else "Concept"


def text_tiling_chapters(
    segments: Sequence[dict[str, Any]],
    embedder: Embedder | None = None,
    *,
    window: int = 2,
    smooth_radius: int = 1,
    min_chapter_segments: int = 1,
) -> list[ConceptChapter]:
    """Split transcript segments into concept chapters via embedding depth scores.

    Sliding left/right windows are embedded; cosine depth scores mark topic
    shifts; scores are smoothed and local maxima become boundaries.
    """
    segs = [s for s in segments if str(s.get("text", "")).strip()]
    if not segs:
        return []
    embedder = embedder or HashEmbedder()
    n = len(segs)
    if n == 1 or window < 1:
        return [
            ConceptChapter(
                ordinal=0,
                start_ms=int(segs[0]["start_ms"]),
                end_ms=int(segs[-1]["end_ms"]),
                title=_title_from_text(str(segs[0]["text"])),
                summary=str(segs[0]["text"])[:240],
            )
        ]

    # Gap i lies between segment i and i+1 (i from 0..n-2).
    depth = [0.0] * (n - 1)
    for i in range(n - 1):
        left_start = max(0, i - window + 1)
        left_end = i + 1
        right_start = i + 1
        right_end = min(n, i + 1 + window)
        left = _window_text(segs, left_start, left_end)
        right = _window_text(segs, right_start, right_end)
        if not left or not right:
            continue
        lv, rv = embedder.embed([left, right])
        # Depth score: how dissimilar neighbouring blocks are.
        depth[i] = 1.0 - cosine(lv, rv)

    smoothed = _smooth(depth, smooth_radius)
    if not smoothed:
        boundaries = []
    else:
        mean = sum(smoothed) / len(smoothed)
        std = math_std(smoothed)
        threshold = mean + 0.5 * std
        boundaries = []
        for i, score in enumerate(smoothed):
            left = smoothed[i - 1] if i > 0 else score
            right = smoothed[i + 1] if i + 1 < len(smoothed) else score
            if score >= threshold and score >= left and score >= right:
                boundaries.append(i)

    cuts = sorted({0, *[b + 1 for b in boundaries], n})
    # Merge cuts that would create too-short chapters.
    merged = [cuts[0]]
    for cut in cuts[1:]:
        if cut - merged[-1] < min_chapter_segments and cut != n:
            continue
        merged.append(cut)
    if merged[-1] != n:
        merged.append(n)

    chapters: list[ConceptChapter] = []
    for ordinal, (a, b) in enumerate(zip(merged, merged[1:])):
        block = segs[a:b]
        text = " ".join(str(s["text"]).strip() for s in block)
        chapters.append(
            ConceptChapter(
                ordinal=ordinal,
                start_ms=int(block[0]["start_ms"]),
                end_ms=int(block[-1]["end_ms"]),
                title=_title_from_text(text),
                summary=text[:240],
            )
        )
    return chapters


def math_std(values: Sequence[float]) -> float:
    if len(values) <= 1:
        return 0.0
    mean = sum(values) / len(values)
    var = sum((v - mean) ** 2 for v in values) / len(values)
    return var**0.5


def chapters_as_payload(chapters: Sequence[ConceptChapter]) -> list[dict[str, Any]]:
    return [
        {
            "ordinal": c.ordinal,
            "start_ms": c.start_ms,
            "end_ms": c.end_ms,
            "title": c.title,
            "summary": c.summary,
        }
        for c in chapters
    ]
