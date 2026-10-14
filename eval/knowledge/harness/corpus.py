"""Synthetic corpus loader for offline retrieval evaluation."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class CorpusChunk:
    chunk_id: str
    video_id: str
    start_ms: int
    end_ms: int
    text: str


@dataclass(frozen=True)
class Corpus:
    chunks: list[CorpusChunk]
    embedder: str
    embed_dim: int

    def for_video(self, video_id: str) -> list[CorpusChunk]:
        return [c for c in self.chunks if c.video_id == video_id]


def load_corpus(path: Path) -> Corpus:
    raw = json.loads(path.read_text(encoding="utf-8"))
    chunks = [
        CorpusChunk(
            chunk_id=str(item["chunk_id"]),
            video_id=str(item["video_id"]),
            start_ms=int(item["start_ms"]),
            end_ms=int(item["end_ms"]),
            text=str(item["text"]).strip(),
        )
        for item in raw["chunks"]
    ]
    if not chunks:
        raise ValueError(f"corpus {path} has no chunks")
    return Corpus(
        chunks=chunks,
        embedder=str(raw.get("embedder", "hash")),
        embed_dim=int(raw.get("embed_dim", 64)),
    )
