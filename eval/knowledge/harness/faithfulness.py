"""RAGAS-style faithfulness: claim support via judge model interface.

Production may plug in an LLM judge. CI uses the deterministic lexical fallback
so evaluation never downloads models or calls remote APIs.
"""

from __future__ import annotations

import re
from typing import Protocol, Sequence, runtime_checkable

_TOKEN = re.compile(r"[a-z0-9]+", re.I)
_CITATION = re.compile(r"\[\d{1,2}:\d{2}\]")


@runtime_checkable
class FaithfulnessJudge(Protocol):
    """Judge whether a claim is supported by retrieved context passages."""

    name: str

    def is_supported(self, claim: str, contexts: Sequence[str]) -> bool: ...


class LexicalFaithfulnessJudge:
    """Deterministic token-overlap fallback (no model downloads)."""

    name = "lexical"

    def __init__(self, *, min_overlap: float = 0.35) -> None:
        self.min_overlap = min_overlap

    def is_supported(self, claim: str, contexts: Sequence[str]) -> bool:
        claim_tokens = set(_TOKEN.findall(claim.lower()))
        if len(claim_tokens) < 2:
            return False
        context_tokens: set[str] = set()
        for ctx in contexts:
            context_tokens.update(_TOKEN.findall(ctx.lower()))
        if not context_tokens:
            return False
        overlap = len(claim_tokens & context_tokens) / len(claim_tokens)
        return overlap >= self.min_overlap


def extract_claims(answer: str) -> list[str]:
    """Split an answer into claim-like sentences, stripping citation markers."""
    text = _CITATION.sub("", answer)
    text = text.replace("Based on the video:", " ")
    parts = re.split(r"[\n;.]+", text)
    claims: list[str] = []
    for part in parts:
        cleaned = part.strip(" -•\t")
        if len(cleaned) < 12:
            continue
        if cleaned.lower() in {"not covered in this video"}:
            continue
        claims.append(cleaned)
    return claims


def faithfulness_score(
    answer: str,
    contexts: Sequence[str],
    judge: FaithfulnessJudge | None = None,
) -> float:
    """Fraction of extracted claims supported by context (1.0 if no claims / abstain)."""
    judge = judge or LexicalFaithfulnessJudge()
    stripped = answer.strip().lower()
    if not stripped or stripped == "not covered in this video":
        return 1.0
    claims = extract_claims(answer)
    if not claims:
        # Citation-only or too short: treat as unsupported if no context overlap at all.
        return 1.0 if any(c.strip() for c in contexts) else 0.0
    supported = sum(1 for c in claims if judge.is_supported(c, contexts))
    return supported / len(claims)
