"""Deterministic grounded answer + abstention mirroring Go Ask fallbacks."""

from __future__ import annotations

from dataclasses import dataclass

from knowledge_worker.retrieve import RankedHit

ABSTAIN_MESSAGE = "not covered in this video"


@dataclass(frozen=True)
class EvalAnswer:
    text: str
    abstained: bool
    citations: list[RankedHit]


def format_clock(ms: int) -> str:
    total = max(0, ms) // 1000
    return f"{total // 60}:{total % 60:02d}"


def grounded_answer(hits: list[RankedHit], *, supported: bool) -> EvalAnswer:
    """Build a cited answer from top hits, or abstain when unsupported."""
    if not supported or not hits:
        return EvalAnswer(text=ABSTAIN_MESSAGE, abstained=True, citations=[])
    lines = ["Based on the video:"]
    used = hits[:3]
    for hit in used:
        snippet = hit.text
        if len(snippet) > 180:
            snippet = snippet[:180] + "…"
        lines.append(f"- [{format_clock(hit.start_ms)}] {snippet}")
    return EvalAnswer(text="\n".join(lines), abstained=False, citations=used)


def cited_timestamps_ms(answer: str) -> list[int]:
    """Parse [m:ss] citation clocks from an answer into milliseconds."""
    import re

    out: list[int] = []
    for match in re.finditer(r"\[(\d{1,2}):(\d{2})\]", answer):
        minutes = int(match.group(1))
        seconds = int(match.group(2))
        out.append((minutes * 60 + seconds) * 1000)
    return out
