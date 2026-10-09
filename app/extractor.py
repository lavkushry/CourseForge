"""Transcripts, sampled screenshots and OCR; all processing stays on-device."""
import json
import logging
import math
import shutil
import subprocess
from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageOps

from .chunking import make_chunk_id
from .config import settings

log = logging.getLogger(__name__)


def video_duration(path: Path) -> float:
    cmd = ['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
           '-of', 'default=noprint_wrappers=1:nokey=1', str(path)]
    res = subprocess.run(cmd, check=True, capture_output=True, text=True, timeout=60)
    return float(res.stdout.strip())


@lru_cache(maxsize=1)
def whisper_model():
    from faster_whisper import WhisperModel
    return WhisperModel(settings.whisper_model, device=settings.whisper_device,
                        compute_type=settings.whisper_compute_type)


def transcribe(video_path: Path, video_id: str) -> tuple[list[dict], str | None]:
    transcript_path = settings.data_dir / 'transcripts' / f'{video_id}.json'
    transcript_path.parent.mkdir(parents=True, exist_ok=True)
    # Reuse persisted transcription if the file was already processed and unchanged.
    # The worker deletes this cache on a detected file change/reindex request.
    fingerprint = {'source_bytes': video_path.stat().st_size,
                   'source_mtime_ns': video_path.stat().st_mtime_ns,
                   'whisper_model': settings.whisper_model}
    if transcript_path.exists():
        try:
            data = json.loads(transcript_path.read_text(encoding='utf-8'))
            if all(data.get(k) == v for k, v in fingerprint.items()):
                return data['segments'], data.get('language')
        except (ValueError, KeyError, TypeError):
            pass
    segments_raw, info = whisper_model().transcribe(
        str(video_path), vad_filter=True, beam_size=3, condition_on_previous_text=False)
    segments = [{'start': round(float(s.start), 2), 'end': round(float(s.end), 2),
                 'text': s.text.strip()} for s in segments_raw if s.text.strip()]
    payload = {'language': info.language, 'segments': segments, **fingerprint}
    temp = transcript_path.with_suffix('.tmp')
    temp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')
    temp.replace(transcript_path)
    return segments, info.language


def dhash(image: Image.Image) -> int:
    mini = ImageOps.grayscale(image).resize((9, 8))
    pixels = list(mini.tobytes())
    value = 0
    for y in range(8):
        for x in range(8):
            value = (value << 1) | int(pixels[y * 9 + x] > pixels[y * 9 + x + 1])
    return value


def extract_frames(video_path: Path, video_id: str) -> list[dict]:
    if settings.disable_frames:
        return []
    if not shutil.which('ffmpeg'):
        raise RuntimeError('ffmpeg not found; install ffmpeg or set DISABLE_FRAMES=1')
    base_dir = settings.data_dir / 'frames' / video_id
    base_dir.mkdir(parents=True, exist_ok=True)
    # We use scene samples at a fixed interval. Timestamp is approximate (interval * sample index).
    # OCR is run only on sufficiently changed frames; this is not pixel-accurate video analysis.
    candidates = base_dir / 'candidates'
    if candidates.exists():
        shutil.rmtree(candidates)
    candidates.mkdir()
    # Space samples across the full lecture and cap work before decoding frames.
    interval = max(settings.frame_interval, math.ceil(video_duration(video_path) / settings.max_frames))
    vf = f'fps=1/{interval},scale=1280:-2:force_original_aspect_ratio=decrease'
    cmd = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', str(video_path),
           '-vf', vf, '-q:v', '4', str(candidates / 'sample_%06d.jpg')]
    try:
        subprocess.run(cmd, check=True, capture_output=True, text=True, timeout=3600)
    except subprocess.CalledProcessError as exc:
        raise RuntimeError('Frame extraction failed: ' + exc.stderr[-1200:]) from exc
    files = sorted(candidates.glob('*.jpg'))
    # Keep a secondary cap to handle rounding differences in the fps filter.
    if len(files) > settings.max_frames:
        count = settings.max_frames
        step = (len(files) - 1) / max(1, count - 1)
        selected = [(round(i * step), files[round(i * step)]) for i in range(count)]
    else:
        selected = list(enumerate(files))
    has_ocr = bool(shutil.which('tesseract'))
    if not has_ocr:
        log.warning('Tesseract unavailable. Frame images saved but code/slide text is NOT searchable.')
    result: list[dict] = []
    previous_hash: int | None = None
    for original_index, filepath in selected:
        with Image.open(filepath) as original:
            picture = original.convert('RGB')
            fingerprint = dhash(picture)
            if previous_hash is not None and (fingerprint ^ previous_hash).bit_count() < 10:
                continue
            previous_hash = fingerprint
            text = ''
            if has_ocr:
                import pytesseract
                try:
                    text = pytesseract.image_to_string(picture, config='--psm 11').strip()
                except Exception as exc:
                    log.warning('OCR failed on %s: %s', filepath, exc)
            time_sec = float(original_index * interval)
            dest = base_dir / f'at_{int(time_sec):07d}.jpg'
            picture.save(dest, quality=82, optimize=True)
        idx = len(result)
        # Image always accessible in UI. Only recognized text is searchable via vectors.
        result.append({'id': make_chunk_id(video_id, 'screen', time_sec, idx),
                       'video_id': video_id, 'kind': 'screen', 'start': time_sec,
                       'end': time_sec + interval, 'text': text,
                       'frame_path': str(dest.relative_to(settings.data_dir))})
    shutil.rmtree(candidates, ignore_errors=True)
    return result
