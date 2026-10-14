"""OCR on keyframes: Tesseract default, PaddleOCR optional."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol


_CODE_HINT = re.compile(
    r"(\{|\}|;|=>|:=|def\s+\w+|class\s+\w+|import\s+\w+|from\s+\w+\s+import|"
    r"function\s+\w+|const\s+\w+|let\s+\w+|var\s+\w+|#!/)",
    re.IGNORECASE,
)
_COMMAND_HINT = re.compile(
    r"^(\$|>|#)\s*\S+|\b(sudo|apt|yum|dnf|brew|pip|npm|docker|kubectl|git|curl|wget|ssh|chmod|chown|systemctl)\b",
    re.IGNORECASE | re.MULTILINE,
)
_SLIDE_HINT = re.compile(r"\b(agenda|overview|summary|objectives|chapter|module|lesson)\b", re.IGNORECASE)


@dataclass(frozen=True)
class OCRResult:
    text: str
    tags: list[str]
    confidence: float | None
    engine: str


class OCREngine(Protocol):
    def read(self, image_path: Path) -> OCRResult: ...


def tag_ocr_text(text: str) -> list[str]:
    tags: list[str] = []
    if _CODE_HINT.search(text):
        tags.append("code")
    if _COMMAND_HINT.search(text):
        tags.append("command")
    if _SLIDE_HINT.search(text) or (text.count("\n") >= 2 and len(text) < 400):
        tags.append("slide")
    if not tags and text.strip():
        tags.append("text")
    # Stable unique order.
    ordered = []
    for tag in ("code", "command", "slide", "diagram", "text"):
        if tag in tags and tag not in ordered:
            ordered.append(tag)
    return ordered


class TesseractOCR:
    def __init__(self, lang: str = "eng") -> None:
        import pytesseract  # noqa: F401

        self._lang = lang
        self._engine = "tesseract"

    def read(self, image_path: Path) -> OCRResult:
        import pytesseract
        from PIL import Image

        with Image.open(image_path) as img:
            data = pytesseract.image_to_data(img, lang=self._lang, output_type=pytesseract.Output.DICT)
            text = pytesseract.image_to_string(img, lang=self._lang).strip()
        confs = [float(c) for c in data.get("conf", []) if str(c).lstrip("-").isdigit() and float(c) >= 0]
        confidence = (sum(confs) / len(confs) / 100.0) if confs else None
        return OCRResult(text=text, tags=tag_ocr_text(text), confidence=confidence, engine=self._engine)


class PaddleOCREngine:
    def __init__(self) -> None:
        from paddleocr import PaddleOCR  # type: ignore

        # CPU-only; avoids GPU assumptions on arm64 workers.
        self._ocr = PaddleOCR(use_angle_cls=True, lang="en", show_log=False)
        self._engine = "paddleocr"

    def read(self, image_path: Path) -> OCRResult:
        raw = self._ocr.ocr(str(image_path), cls=True) or []
        lines: list[str] = []
        confs: list[float] = []
        for block in raw:
            for item in block or []:
                if not item or len(item) < 2:
                    continue
                payload = item[1]
                if not payload:
                    continue
                lines.append(str(payload[0]))
                if len(payload) > 1 and payload[1] is not None:
                    confs.append(float(payload[1]))
        text = "\n".join(line.strip() for line in lines if line.strip()).strip()
        confidence = (sum(confs) / len(confs)) if confs else None
        return OCRResult(text=text, tags=tag_ocr_text(text), confidence=confidence, engine=self._engine)


def build_ocr(engine: str = "tesseract", prefer: OCREngine | None = None) -> OCREngine:
    if prefer is not None:
        return prefer
    name = (engine or "tesseract").lower()
    if name == "paddle":
        try:
            return PaddleOCREngine()
        except Exception:
            return TesseractOCR()
    return TesseractOCR()
