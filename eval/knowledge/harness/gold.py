"""Gold-set loader for Living Video Knowledge evaluation."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable


@dataclass(frozen=True)
class GoldExample:
    """One labeled question against a video.

    JSONL fields (required): question, video_id, expected_timestamps_ms, answerable.
    Optional: id, relevant_chunk_ids, gold_claims.
    """

    id: str
    question: str
    video_id: str
    expected_timestamps_ms: list[int]
    answerable: bool
    relevant_chunk_ids: list[str] = field(default_factory=list)
    gold_claims: list[str] = field(default_factory=list)

    @classmethod
    def from_dict(cls, raw: dict[str, Any], *, line_no: int) -> GoldExample:
        question = str(raw.get("question", "")).strip()
        video_id = str(raw.get("video_id", "")).strip()
        if not question or not video_id:
            raise ValueError(f"gold line {line_no}: question and video_id are required")
        if "answerable" not in raw:
            raise ValueError(f"gold line {line_no}: answerable flag is required")
        timestamps = raw.get("expected_timestamps_ms")
        if timestamps is None:
            timestamps = raw.get("expected_timestamps", [])
        if not isinstance(timestamps, list):
            raise ValueError(f"gold line {line_no}: expected_timestamps_ms must be a list")
        example_id = str(raw.get("id") or f"line-{line_no}")
        relevant = raw.get("relevant_chunk_ids") or []
        claims = raw.get("gold_claims") or []
        return cls(
            id=example_id,
            question=question,
            video_id=video_id,
            expected_timestamps_ms=[int(t) for t in timestamps],
            answerable=bool(raw["answerable"]),
            relevant_chunk_ids=[str(x) for x in relevant],
            gold_claims=[str(x) for x in claims],
        )


def load_gold_file(path: Path) -> list[GoldExample]:
    examples: list[GoldExample] = []
    with path.open(encoding="utf-8") as fh:
        for line_no, line in enumerate(fh, start=1):
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            raw = json.loads(line)
            if not isinstance(raw, dict):
                raise ValueError(f"{path}:{line_no}: expected JSON object")
            examples.append(GoldExample.from_dict(raw, line_no=line_no))
    return examples


def load_gold_dir(directory: Path) -> list[GoldExample]:
    paths = sorted(directory.glob("*.jsonl"))
    if not paths:
        raise FileNotFoundError(f"no *.jsonl gold files under {directory}")
    out: list[GoldExample] = []
    for path in paths:
        out.extend(load_gold_file(path))
    return out


def iter_answerable(examples: Iterable[GoldExample]) -> list[GoldExample]:
    return [e for e in examples if e.answerable]
