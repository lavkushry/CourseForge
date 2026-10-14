"""ASR adapters: faster-whisper preferred, whisper.cpp CLI fallback."""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol


@dataclass(frozen=True)
class WordStamp:
    start_ms: int
    end_ms: int
    text: str
    confidence: float | None = None


@dataclass(frozen=True)
class SegmentStamp:
    start_ms: int
    end_ms: int
    text: str


@dataclass(frozen=True)
class Transcript:
    engine: str
    words: list[WordStamp]
    segments: list[SegmentStamp]


class ASREngine(Protocol):
    def transcribe(self, media_path: Path) -> Transcript: ...


def _sec_to_ms(value: float) -> int:
    return max(0, int(round(float(value) * 1000)))


class FasterWhisperASR:
    """Wraps faster-whisper. Constructed only when the package is importable."""

    def __init__(self, model_size: str = "tiny", device: str = "cpu", compute_type: str = "int8") -> None:
        from faster_whisper import WhisperModel  # type: ignore

        self._model = WhisperModel(model_size, device=device, compute_type=compute_type)
        self._engine = f"faster-whisper:{model_size}"

    def transcribe(self, media_path: Path) -> Transcript:
        segments_iter, _info = self._model.transcribe(str(media_path), word_timestamps=True)
        words: list[WordStamp] = []
        segments: list[SegmentStamp] = []
        for seg in segments_iter:
            text = (seg.text or "").strip()
            if text:
                segments.append(
                    SegmentStamp(
                        start_ms=_sec_to_ms(seg.start),
                        end_ms=_sec_to_ms(seg.end),
                        text=text,
                    )
                )
            for word in seg.words or []:
                token = (word.word or "").strip()
                if not token:
                    continue
                conf = float(word.probability) if word.probability is not None else None
                words.append(
                    WordStamp(
                        start_ms=_sec_to_ms(word.start),
                        end_ms=_sec_to_ms(word.end),
                        text=token,
                        confidence=conf,
                    )
                )
        return Transcript(engine=self._engine, words=words, segments=segments)


class WhisperCppASR:
    """Subprocess fallback using whisper.cpp CLI JSON output."""

    def __init__(self, binary: str = "whisper-cli", model_path: str | None = None) -> None:
        self._binary = binary
        self._model_path = model_path
        if shutil.which(binary) is None:
            raise FileNotFoundError(f"whisper.cpp binary not found: {binary}")

    def transcribe(self, media_path: Path) -> Transcript:
        with tempfile.TemporaryDirectory(prefix="kw-whisper-") as tmp:
            out_base = Path(tmp) / "out"
            cmd = [self._binary, "-f", str(media_path), "-oj", "-of", str(out_base)]
            if self._model_path:
                cmd.extend(["-m", self._model_path])
            subprocess.run(cmd, check=True, capture_output=True, timeout=600)
            payload = json.loads((Path(str(out_base) + ".json")).read_text(encoding="utf-8"))
        words: list[WordStamp] = []
        segments: list[SegmentStamp] = []
        for seg in payload.get("transcription") or payload.get("segments") or []:
            text = str(seg.get("text") or "").strip()
            offsets = seg.get("offsets") or {}
            start_ms = int(offsets.get("from", _sec_to_ms(seg.get("start", 0))))
            end_ms = int(offsets.get("to", _sec_to_ms(seg.get("end", 0))))
            if text:
                segments.append(SegmentStamp(start_ms=start_ms, end_ms=end_ms, text=text))
            for word in seg.get("tokens") or seg.get("words") or []:
                token = str(word.get("text") or word.get("word") or "").strip()
                if not token:
                    continue
                w_off = word.get("offsets") or {}
                words.append(
                    WordStamp(
                        start_ms=int(w_off.get("from", start_ms)),
                        end_ms=int(w_off.get("to", end_ms)),
                        text=token,
                        confidence=None,
                    )
                )
        return Transcript(engine="whisper.cpp", words=words, segments=segments)


def build_asr(
    *,
    model_size: str = "tiny",
    device: str = "cpu",
    compute_type: str = "int8",
    whisper_cpp_bin: str = "whisper-cli",
    prefer: ASREngine | None = None,
) -> ASREngine:
    if prefer is not None:
        return prefer
    try:
        return FasterWhisperASR(model_size=model_size, device=device, compute_type=compute_type)
    except Exception:
        return WhisperCppASR(binary=whisper_cpp_bin)
