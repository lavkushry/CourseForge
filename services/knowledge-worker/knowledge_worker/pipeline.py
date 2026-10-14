"""Orchestrates ASR → scenes → OCR and builds the Go ingest payload."""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from knowledge_worker.asr import ASREngine, Transcript
from knowledge_worker.ocr import OCREngine
from knowledge_worker.scenes import SceneDetector, SceneResult

log = logging.getLogger(__name__)


@dataclass
class IngestBundle:
    asr_engine: str
    scene_engine: str
    ocr_engine: str
    words: list[dict[str, Any]]
    segments: list[dict[str, Any]]
    keyframes: list[dict[str, Any]]

    def as_payload(self) -> dict[str, Any]:
        return {
            "asr_engine": self.asr_engine,
            "scene_engine": self.scene_engine,
            "ocr_engine": self.ocr_engine,
            "words": self.words,
            "segments": self.segments,
            "keyframes": self.keyframes,
        }


def resolve_media_path(payload: dict[str, Any] | str | None, media_root: Path) -> Path:
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except json.JSONDecodeError:
            payload = {}
    payload = payload or {}
    raw = (
        payload.get("source_path")
        or payload.get("media_path")
        or payload.get("path")
        or ""
    )
    if not raw:
        raise ValueError("job payload missing source_path")
    path = Path(str(raw))
    if not path.is_absolute():
        path = (media_root / path).resolve()
    else:
        path = path.resolve()
    if not path.is_file():
        raise FileNotFoundError(f"media not found: {path}")
    return path


def run_ingest(
    media_path: Path,
    work_dir: Path,
    *,
    asr: ASREngine,
    scenes: SceneDetector,
    ocr: OCREngine,
) -> IngestBundle:
    work_dir.mkdir(parents=True, exist_ok=True)
    transcript: Transcript = asr.transcribe(media_path)
    scene_dir = work_dir / "keyframes"
    scene_result: SceneResult = scenes.detect(media_path, scene_dir)

    words = [
        {
            "ordinal": i,
            "start_ms": w.start_ms,
            "end_ms": w.end_ms,
            "text": w.text,
            **({"confidence": w.confidence} if w.confidence is not None else {}),
        }
        for i, w in enumerate(transcript.words)
    ]
    segments = [
        {
            "ordinal": i,
            "start_ms": s.start_ms,
            "end_ms": s.end_ms,
            "text": s.text,
        }
        for i, s in enumerate(transcript.segments)
    ]

    keyframes: list[dict[str, Any]] = []
    ocr_engine_name = ""
    for i, kf in enumerate(scene_result.keyframes):
        hit = ocr.read(kf.path)
        ocr_engine_name = hit.engine or ocr_engine_name
        entry: dict[str, Any] = {
            "ordinal": i,
            "time_ms": kf.time_ms,
            "path": str(kf.path),
            "width": kf.width,
            "height": kf.height,
        }
        if hit.text.strip():
            ocr_payload: dict[str, Any] = {
                "text": hit.text.strip()[:16000],
                "tags": hit.tags,
            }
            if hit.confidence is not None:
                ocr_payload["confidence"] = hit.confidence
            entry["ocr"] = ocr_payload
        keyframes.append(entry)

    return IngestBundle(
        asr_engine=transcript.engine,
        scene_engine=scene_result.engine,
        ocr_engine=ocr_engine_name or "none",
        words=words,
        segments=segments,
        keyframes=keyframes,
    )
