"""Time-aware transcript chunking and repeat-slide detection helpers."""
import hashlib
import uuid


def make_chunk_id(video_id: str, kind: str, start: float, ordinal: int) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f'courseforge:{video_id}:{kind}:{start:.3f}:{ordinal}'))


def video_id_for_path(path: str) -> str:
    return hashlib.sha256(path.encode('utf-8')).hexdigest()[:24]


def transcript_chunks(video_id: str, segments: list[dict], max_chars: int = 1050,
                      max_seconds: int = 120, overlap: int = 2) -> list[dict]:
    """Group transcript segments, carrying up to N earlier segments into next chunk."""
    if not segments:
        return []
    result: list[dict] = []
    active: list[dict] = []

    def emit(items: list[dict]):
        if not items:
            return
        text = ' '.join(str(s.get('text', '')).strip() for s in items).strip()
        if text:
            idx = len(result)
            result.append({
                'id': make_chunk_id(video_id, 'speech', float(items[0]['start']), idx),
                'video_id': video_id, 'kind': 'speech',
                'start': float(items[0]['start']), 'end': float(items[-1]['end']),
                'text': text, 'frame_path': None,
            })

    for segment in segments:
        if not str(segment.get('text', '')).strip():
            continue
        if active:
            prospective_len = sum(len(str(s['text'])) + 1 for s in active) + len(str(segment['text']))
            duration = float(segment['end']) - float(active[0]['start'])
            if prospective_len > max_chars or duration > max_seconds:
                emit(active)
                # Do not carry so much overlap that it defeats the size/time limit.
                active = active[-overlap:] if overlap > 0 else []
                while active and (sum(len(str(s['text'])) + 1 for s in active) + len(str(segment['text'])) > max_chars
                                  or float(segment['end']) - float(active[0]['start']) > max_seconds):
                    active = active[1:]
        active.append(segment)
    emit(active)
    return result
