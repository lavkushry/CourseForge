"""Run exactly one worker process. Durable queue resumes after worker crashes.

Each lecture stage is isolated. A vision timeout, a missing OCR binary, or an
embedding outage is logged and the remaining stages still run. The lecture is
marked done when any searchable or derived learning object exists.
"""
import argparse
import logging
import time
from pathlib import Path

from .chunking import transcript_chunks
from .config import settings
from .db import (init_db, claim_job, stage, finish_job, fetch_video, replace_chunks,
                 resume_interrupted, transcript_for_video)
from .extractor import transcribe, extract_frames, video_duration
from .learning_object import assemble, checkpoints_for, learning_chunks, persist, write_stages
from .vectorstore import index_video
from .vision import enrich_frames

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
log = logging.getLogger(__name__)


def _stage(job_id: int, name: str, fn, stages: list[dict]):
    stage(job_id, name)
    log.info('stage start name=%s job=%s', name, job_id)
    try:
        value = fn()
    except Exception as exc:
        log.exception('stage failed name=%s job=%s error=%s', name, job_id, type(exc).__name__)
        stages.append({'stage': name, 'status': 'failed', 'error': f'{type(exc).__name__}: {exc}'[:300]})
        return None
    log.info('stage ok name=%s job=%s', name, job_id)
    stages.append({'stage': name, 'status': 'ok'})
    return value


def process(job: dict) -> None:
    job_id, vid = job['id'], job['video_id']
    video = fetch_video(vid)
    if not video:
        finish_job(job_id, vid, 'Video metadata missing')
        return
    path = Path(video['path'])
    try:
        # Detect replaced/deleted source before trusting cached results.
        if not path.is_file() or not path.resolve().is_relative_to(settings.courses_dir):
            raise RuntimeError('Source video no longer exists inside COURSES_DIR')
        stat = path.stat()
        if stat.st_size != video['bytes'] or stat.st_mtime_ns != video['mtime_ns']:
            raise RuntimeError('Video changed during import. Run Scan Library again.')
    except Exception as exc:
        log.exception('Job %s rejected before indexing', job_id)
        finish_job(job_id, vid, str(exc))
        return

    stages: list[dict] = []
    duration = _stage(job_id, 'Probing video', lambda: video_duration(path), stages)
    transcribed = _stage(job_id, 'Transcribing audio (Whisper)', lambda: transcribe(path, vid), stages)
    segments, language = transcribed if transcribed else ([], None)
    frames = _stage(job_id, 'Extracting scene keyframes and OCR', lambda: extract_frames(path, vid), stages)
    frames = list(frames or [])
    enriched = _stage(job_id, 'Understanding slide and code diagrams (vision)',
                      lambda: enrich_frames(frames), stages)
    if enriched is not None:
        frames = enriched
    speech = transcript_chunks(vid, segments or [])
    built = _stage(job_id, 'Extracting concepts, quizzes, flashcards and checkpoints',
                   lambda: assemble(vid, segments or [], frames), stages)
    built = built or {'concepts': [], 'quizzes': [], 'flashcards': [], 'checkpoints': []}
    source_ready = any(item['stage'] in ('Transcribing audio (Whisper)', 'Extracting scene keyframes and OCR')
                       and item['status'] == 'ok' for item in stages)
    assembled = any(item['stage'] == 'Extracting concepts, quizzes, flashcards and checkpoints'
                    and item['status'] == 'ok' for item in stages)
    _stage(job_id, 'Saving the learning object',
           lambda: persist(video, built, stages, source_ready=source_ready and assembled), stages)
    chunks = speech + frames + learning_chunks(vid, built)
    if chunks:
        _stage(job_id, 'Saving searchable transcript', lambda: replace_chunks(vid, chunks), stages)
    else:
        log.info('stage skipped name=Saving searchable transcript job=%s reason=no chunks', job_id)
    _stage(job_id, f'Embedding {sum(bool(str(c.get("text") or "").strip()) for c in chunks)} chunks',
           lambda: index_video(video, chunks), stages)

    write_stages(vid, stages)
    failed = [item['stage'] for item in stages if item['status'] == 'failed']
    searchable = any(str(chunk.get('text') or '').strip() for chunk in chunks)
    derived = bool(built['concepts'] or built['quizzes'] or built['flashcards'] or built['checkpoints'])
    saved_chunks = any(item['stage'] == 'Saving searchable transcript' and item['status'] == 'ok' for item in stages)
    prior = bool(transcript_for_video(vid) or checkpoints_for(vid))
    produced = searchable or derived or saved_chunks or prior
    measured = duration if isinstance(duration, (int, float)) else None
    if produced:
        finish_job(job_id, vid, language=language, duration=measured)
        if failed:
            stage(job_id, ('Completed with partial results: ' + ', '.join(failed))[:120])
            log.warning('lecture partial video=%s failed_stages=%s chunks=%s', vid, failed, len(chunks))
        else:
            log.info('Indexed %s: %s transcript pieces, %s frames, %s concepts',
                     path.name, len(segments or []), len(frames), len(built['concepts']))
        return
    reason = 'No learning object could be produced.'
    if failed:
        reason += ' Failed stages: ' + ', '.join(failed)
    log.error('lecture failed video=%s stages=%s', vid, failed)
    finish_job(job_id, vid, reason[:2000])


def main():
    parser = argparse.ArgumentParser(description='Single-worker local course importer')
    parser.add_argument('--once', action='store_true', help='Process one queued video then exit')
    parser.add_argument('--poll', type=float, default=3.0, help='Seconds between queue checks')
    args = parser.parse_args()
    init_db()
    recovered = resume_interrupted()
    if recovered:
        log.info('Recovered %s interrupted job(s)', recovered)
    log.info('Worker started. Watching %s', settings.courses_dir)
    while True:
        job = claim_job()
        if job:
            process(job)
        elif args.once:
            break
        else:
            time.sleep(max(0.5, args.poll))
        if args.once:
            break


if __name__ == '__main__':
    main()
