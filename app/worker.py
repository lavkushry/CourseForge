"""Run exactly one worker process. Durable queue resumes after worker crashes."""
import argparse
import logging
import time
from pathlib import Path

from .chunking import transcript_chunks
from .config import settings
from .db import (init_db, claim_job, stage, finish_job, fetch_video, replace_chunks,
                 resume_interrupted)
from .extractor import transcribe, extract_frames, video_duration
from .vectorstore import index_video
from .vision import enrich_frames

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
log = logging.getLogger(__name__)


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
        stage(job_id, 'Probing video')
        duration = video_duration(path)
        # The transcript cache is reused only if its file fingerprint and model match.
        stage(job_id, 'Transcribing audio (Whisper)')
        segments, language = transcribe(path, vid)
        stage(job_id, 'Extracting slides and OCR')
        frames = extract_frames(path, vid)
        stage(job_id, 'Understanding slide and code diagrams (vision)')
        frames = enrich_frames(frames)
        chunks = transcript_chunks(vid, segments) + frames
        stage(job_id, f'Embedding {sum(bool(c["text"].strip()) for c in chunks)} chunks')
        index_video(video, chunks)
        replace_chunks(vid, chunks)
        finish_job(job_id, vid, language=language, duration=duration)
        log.info('Indexed %s: %s transcript pieces, %s frames', path.name, len(segments), len(frames))
    except Exception as exc:
        log.exception('Job %s failed', job_id)
        finish_job(job_id, vid, str(exc))


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
