"""Transcripts, scene-change keyframes and OCR; all processing stays on-device."""
import json
import logging
import re
import shutil
import subprocess
from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageOps

try:
    import pytesseract
except ImportError:
    pytesseract = None

from .chunking import make_chunk_id
from .config import settings

log = logging.getLogger(__name__)

# ContentDetector-style cut. eq(n,0) always keeps a frame so a static lecture still has one keyframe.
_SCENE_THRESHOLD = 0.30
_PTS_TIME = re.compile(r'\bn:\s*\d+\s+pts:\s*-?\d+\s+pts_time:([0-9]+(?:\.[0-9]+)?)')


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


def ocr_image(picture: Image.Image, label: str) -> str:
    """Read one frame. A missing binary or a single timeout returns empty text."""
    if pytesseract is None or not shutil.which('tesseract'):
        return ''
    try:
        return pytesseract.image_to_string(picture, config='--psm 11', timeout=30).strip()
    except Exception as exc:
        log.warning('OCR failed on %s (%s); continuing with an empty reading', label, type(exc).__name__)
        return ''


def scene_keyframes(video_path: Path, out_dir: Path, *, limit: int) -> list[tuple[float, Path]]:
    """Write scene-change JPEGs and pair each file with the showinfo PTS, in seconds."""
    out_dir.mkdir(parents=True, exist_ok=True)
    pattern = out_dir / 'scene_%06d.jpg'
    select = f"select='eq(n,0)+gt(scene,{_SCENE_THRESHOLD})',showinfo,scale=1280:-2:force_original_aspect_ratio=decrease"
    cmd = ['ffmpeg', '-hide_banner', '-nostdin', '-y', '-i', str(video_path),
           '-vf', select, '-fps_mode', 'vfr', '-q:v', '4', '-frames:v', str(max(1, limit)),
           str(pattern)]
    try:
        proc = subprocess.run(cmd, check=True, capture_output=True, text=True, timeout=3600)
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or '')[-400:].replace('\n', ' ')
        raise RuntimeError('Scene keyframe extraction failed: ' + detail) from exc
    pts = [round(float(match), 3) for match in _PTS_TIME.findall(proc.stderr or '')]
    files = sorted(out_dir.glob('scene_*.jpg'))
    if files and not pts:
        raise RuntimeError('Scene keyframes were written without PTS timestamps')
    if len(pts) != len(files):
        log.warning('scene PTS count %s does not match %s files for %s; keeping the aligned prefix',
                    len(pts), len(files), video_path.name)
    paired = list(zip(pts, files))
    if len(paired) > limit:
        if limit == 1:
            paired = paired[:1]
        else:
            step = (len(paired) - 1) / (limit - 1)
            paired = [paired[round(i * step)] for i in range(limit)]
    log.info('scene keyframes file=%s count=%s', video_path.name, len(paired))
    return paired


def extract_frames(video_path: Path, video_id: str) -> list[dict]:
    if settings.disable_frames:
        return []
    if not shutil.which('ffmpeg'):
        raise RuntimeError('ffmpeg not found; install ffmpeg or set DISABLE_FRAMES=1')
    base_dir = settings.data_dir / 'frames' / video_id
    base_dir.mkdir(parents=True, exist_ok=True)
    candidates = base_dir / 'candidates'
    if candidates.exists():
        shutil.rmtree(candidates)
    candidates.mkdir()
    if pytesseract is None or not shutil.which('tesseract'):
        log.warning('Tesseract unavailable. Keyframes are saved but on-screen text is not searchable.')
    try:
        selected = scene_keyframes(video_path, candidates, limit=settings.max_frames)
    except Exception:
        shutil.rmtree(candidates, ignore_errors=True)
        raise
    result: list[dict] = []
    previous_hash: int | None = None
    try:
        for time_sec, filepath in selected:
            with Image.open(filepath) as original:
                picture = original.convert('RGB')
                fingerprint = dhash(picture)
                if previous_hash is not None and (fingerprint ^ previous_hash).bit_count() < 10:
                    continue
                previous_hash = fingerprint
                text = ocr_image(picture, filepath.name)
                dest = base_dir / f'at_{int(time_sec * 1000):09d}.jpg'
                picture.save(dest, quality=82, optimize=True)
            idx = len(result)
            # The end is the same PTS until the player or a later keyframe supplies a range.
            result.append({'id': make_chunk_id(video_id, 'screen', time_sec, idx),
                           'video_id': video_id, 'kind': 'screen', 'start': time_sec,
                           'end': time_sec, 'text': text,
                           'frame_path': str(dest.relative_to(settings.data_dir))})
    finally:
        shutil.rmtree(candidates, ignore_errors=True)
    log.info('keyframes kept file=%s count=%s ocr_chars=%s', video_path.name, len(result),
             sum(len(frame['text']) for frame in result))
    return result
