"""Multimodal chunk builder (transcript + nearby OCR)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Sequence


@dataclass(frozen=True)
class MultimodalChunk:
    ordinal: int
    start_ms: int
    end_ms: int
    text: str
    source: str  # transcript | ocr | multimodal


def build_multimodal_chunks(
    segments: Sequence[dict[str, Any]],
    keyframes: Sequence[dict[str, Any]] | None = None,
    *,
    ocr_window_ms: int = 15_000,
) -> list[MultimodalChunk]:
    """Merge transcript segments with OCR text from temporally nearby keyframes."""
    keyframes = list(keyframes or [])
    chunks: list[MultimodalChunk] = []
    ordinal = 0

    for seg in segments:
        text = str(seg.get("text", "")).strip()
        if not text:
            continue
        start_ms = int(seg["start_ms"])
        end_ms = int(seg["end_ms"])
        ocr_bits: list[str] = []
        for kf in keyframes:
            ocr = kf.get("ocr") or {}
            ocr_text = str(ocr.get("text", "")).strip()
            if not ocr_text:
                continue
            t = int(kf.get("time_ms", 0))
            if start_ms - ocr_window_ms <= t <= end_ms + ocr_window_ms:
                ocr_bits.append(ocr_text)
        if ocr_bits:
            # Deduplicate while preserving order.
            seen: set[str] = set()
            unique = []
            for bit in ocr_bits:
                if bit not in seen:
                    seen.add(bit)
                    unique.append(bit)
            merged = text + "\nOCR: " + " | ".join(unique)
            source = "multimodal"
        else:
            merged = text
            source = "transcript"
        chunks.append(
            MultimodalChunk(
                ordinal=ordinal,
                start_ms=start_ms,
                end_ms=end_ms,
                text=merged[:8000],
                source=source,
            )
        )
        ordinal += 1

    # Standalone OCR chunks that never landed near a segment.
    covered = {c.text for c in chunks}
    for kf in keyframes:
        ocr = kf.get("ocr") or {}
        ocr_text = str(ocr.get("text", "")).strip()
        if not ocr_text:
            continue
        candidate = f"OCR: {ocr_text}"[:8000]
        if any(ocr_text in c.text for c in chunks):
            continue
        if candidate in covered:
            continue
        t = int(kf.get("time_ms", 0))
        chunks.append(
            MultimodalChunk(
                ordinal=ordinal,
                start_ms=t,
                end_ms=t,
                text=candidate,
                source="ocr",
            )
        )
        ordinal += 1

    return chunks


def chunks_as_payload(chunks: Sequence[MultimodalChunk]) -> list[dict[str, Any]]:
    return [
        {
            "ordinal": c.ordinal,
            "start_ms": c.start_ms,
            "end_ms": c.end_ms,
            "text": c.text,
            "source": c.source,
        }
        for c in chunks
    ]
