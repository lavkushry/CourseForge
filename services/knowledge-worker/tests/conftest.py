from __future__ import annotations

import json
from pathlib import Path

import pytest
from PIL import Image, ImageDraw

from knowledge_worker.asr import SegmentStamp, Transcript, WordStamp
from knowledge_worker.ocr import OCRResult
from knowledge_worker.scenes import Keyframe, SceneResult

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture
def fixtures_dir() -> Path:
    return FIXTURES


@pytest.fixture
def tiny_media(tmp_path: Path) -> Path:
    """Tiny placeholder media file (not a real video; engines are mocked)."""
    path = tmp_path / "tiny.mp4"
    path.write_bytes(b"FAKEVIDEO")
    return path


@pytest.fixture
def tiny_frame(tmp_path: Path) -> Path:
    path = tmp_path / "frame.jpg"
    img = Image.new("RGB", (64, 36), color=(32, 32, 32))
    draw = ImageDraw.Draw(img)
    draw.text((4, 10), "sudo apt update", fill=(240, 240, 240))
    img.save(path, format="JPEG")
    return path


class MockASR:
    def __init__(self, fixtures_dir: Path) -> None:
        data = json.loads((fixtures_dir / "tiny_transcript.json").read_text(encoding="utf-8"))
        self._data = data

    def transcribe(self, media_path: Path) -> Transcript:
        words = [
            WordStamp(
                start_ms=w["start_ms"],
                end_ms=w["end_ms"],
                text=w["text"],
                confidence=w.get("confidence"),
            )
            for w in self._data["words"]
        ]
        segments = [
            SegmentStamp(start_ms=s["start_ms"], end_ms=s["end_ms"], text=s["text"])
            for s in self._data["segments"]
        ]
        return Transcript(engine=self._data["engine"], words=words, segments=segments)


class MockScenes:
    def __init__(self, frame: Path) -> None:
        self._frame = frame

    def detect(self, media_path: Path, out_dir: Path) -> SceneResult:
        out_dir.mkdir(parents=True, exist_ok=True)
        target = out_dir / "frame_000.jpg"
        target.write_bytes(self._frame.read_bytes())
        return SceneResult(
            engine="mock-scenedetect",
            keyframes=[Keyframe(time_ms=100, path=target, width=64, height=36)],
        )


class MockOCR:
    def read(self, image_path: Path) -> OCRResult:
        return OCRResult(
            text="sudo apt update",
            tags=["command", "code"],
            confidence=0.88,
            engine="mock-tesseract",
        )
