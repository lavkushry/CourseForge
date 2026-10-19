"""Stage isolation for the lecture learning object. Models are not downloaded."""
import shutil
import subprocess
from dataclasses import replace
from pathlib import Path

import pytest
from PIL import Image, ImageDraw, ImageFont

from app import db, extractor, library, worker
from app.config import settings
from app.db import claim_job, fetch_jobs, fetch_videos, init_db, keyword_search, transcript_for_video
from app.extractor import ocr_image, scene_keyframes
from app.learning_object import assemble, persist
from app.library import scan_courses
from app.study import due_cards


def test_concepts_quiz_cards_and_checkpoints_quote_the_source():
    segments = [
        {'start': 0, 'end': 12, 'text': 'Pods are the smallest deployable unit in Kubernetes.'},
        {'start': 40, 'end': 55, 'text': 'A Service gives Pods a stable network name and port.'},
    ]
    frames = [{'start': 40, 'end': 40, 'text': 'kubectl get pods'}]
    built = assemble('vid', segments, frames)
    titles = {item['title'] for item in built['concepts']}
    assert 'Pods Kubernetes' in titles or any('Pods' in title and 'Kubernetes' in title for title in titles)
    assert any('Service' in item['title'] for item in built['concepts'])
    assert built['quizzes']
    for question in built['quizzes']:
        correct = question['options'][question['correct_index']]
        assert correct in {item['summary'][:180] for item in built['concepts']}
        assert question['source_start'] >= 0
    assert len(built['flashcards']) == len(built['concepts'])
    assert built['flashcards'][0]['source_start'] == built['concepts'][0]['start']
    starts = [item['start'] for item in built['checkpoints']]
    assert starts == sorted(starts)
    assert all(right - left >= 15 for left, right in zip(starts, starts[1:]))


def test_ocr_image_isolates_engine_errors(monkeypatch):
    class Broken:
        def image_to_string(self, *_args, **_kwargs):
            raise RuntimeError('timeout')

    monkeypatch.setattr(extractor, 'pytesseract', Broken())
    monkeypatch.setattr(extractor.shutil, 'which', lambda name: '/usr/bin/tesseract' if name == 'tesseract' else None)
    assert ocr_image(Image.new('RGB', (16, 16)), 'frame') == ''


@pytest.mark.skipif(not shutil.which('tesseract'), reason='tesseract required')
def test_tesseract_reads_a_synthetic_slide():
    image = Image.new('RGB', (900, 220), 'white')
    draw = ImageDraw.Draw(image)
    font_path = Path('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')
    font = ImageFont.truetype(str(font_path), 64) if font_path.is_file() else None
    draw.text((20, 60), 'Kubernetes Pods', fill='black', font=font)
    text = ocr_image(image, 'slide')
    assert 'Kubernetes' in text or 'Pods' in text


@pytest.mark.skipif(not shutil.which('ffmpeg'), reason='ffmpeg required')
def test_scene_keyframes_use_exact_pts(tmp_path):
    clip = tmp_path / 'cut.mp4'
    subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:d=2:r=10',
                    '-f', 'lavfi', '-i', 'color=c=white:s=320x180:d=2:r=10',
                    '-filter_complex', '[0][1]concat=n=2:v=1:a=0', '-c:v', 'mpeg4', '-y', str(clip)],
                   check=True, timeout=30)
    paired = scene_keyframes(clip, tmp_path / 'frames', limit=8)
    pts = [item[0] for item in paired]
    assert pts[0] == pytest.approx(0, abs=0.05)
    assert any(abs(stamp - 2.0) < 0.15 for stamp in pts[1:])
    assert all(isinstance(stamp, float) for stamp in pts)


def _queue(tmp_path, monkeypatch):
    courses = tmp_path / 'courses' / 'Kubernetes'
    courses.mkdir(parents=True)
    clip = courses / 'intro.mp4'
    subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=navy:s=160x90:d=1:r=5',
                    '-c:v', 'mpeg4', '-y', str(clip)], check=True, timeout=30)
    cfg = replace(settings, courses_dir=courses.parent, data_dir=tmp_path / 'data', enable_vision=True)
    for module in (worker, db, library, extractor):
        monkeypatch.setattr(module, 'settings', cfg)
    init_db()
    assert scan_courses()['imported'] == 1
    return claim_job()


@pytest.mark.skipif(not shutil.which('ffmpeg'), reason='ffmpeg required')
def test_vision_and_embedding_failures_keep_a_done_lecture(tmp_path, monkeypatch):
    job = _queue(tmp_path, monkeypatch)
    monkeypatch.setattr(worker, 'transcribe', lambda *_: ([{'start': 0, 'end': 4, 'text': 'Pods are the smallest deployable unit in Kubernetes.'}], 'en'))
    monkeypatch.setattr(worker, 'extract_frames', lambda *_: [{
        'id': 'screen1', 'video_id': job['video_id'], 'kind': 'screen', 'start': 1.5, 'end': 1.5,
        'text': 'kubectl get pods', 'frame_path': None,
    }])
    monkeypatch.setattr(worker, 'enrich_frames', lambda frames: (_ for _ in ()).throw(TimeoutError('vision timed out')))
    monkeypatch.setattr(worker, 'index_video', lambda *_: (_ for _ in ()).throw(RuntimeError('qdrant down')))
    worker.process(job)
    video = fetch_videos()[0]
    assert video['status'] == 'done', video['error']
    chunks = transcript_for_video(video['id'])
    kinds = {chunk['kind'] for chunk in chunks}
    assert {'speech', 'screen', 'concept', 'flashcard', 'checkpoint'} <= kinds
    assert any(chunk['start'] == 1.5 and 'kubectl get pods' in chunk['text'] for chunk in chunks)
    found = keyword_search('Kubernetes', video_id=video['id'])
    assert found
    with db.connect() as conn:
        quiz = conn.execute('SELECT questions_json FROM lesson_quizzes WHERE video_id=?', (video['id'],)).fetchone()
        cards = conn.execute('SELECT question, source_start FROM lesson_flashcards WHERE video_id=?', (video['id'],)).fetchall()
    assert quiz
    assert cards
    assert any(card['source_start'] == 0 for card in cards)
    due = due_cards()
    assert any(card['video_id'] == video['id'] for card in due)
    job_row = fetch_jobs()[0]
    assert job_row['status'] == 'done'
    assert 'partial' in job_row['stage'].lower()
    assert 'vision' in job_row['stage'].lower() or 'Embedding' in job_row['stage']


@pytest.mark.skipif(not shutil.which('ffmpeg'), reason='ffmpeg required')
def test_whisper_failure_still_indexes_ocr(tmp_path, monkeypatch):
    job = _queue(tmp_path, monkeypatch)
    monkeypatch.setattr(worker, 'transcribe', lambda *_: (_ for _ in ()).throw(RuntimeError('faster-whisper missing')))
    monkeypatch.setattr(worker, 'extract_frames', lambda *_: [{
        'id': 'screen1', 'video_id': job['video_id'], 'kind': 'screen', 'start': 2.0, 'end': 2.0,
        'text': 'Service stable network name', 'frame_path': None,
    }])
    monkeypatch.setattr(worker, 'enrich_frames', lambda frames: frames)
    monkeypatch.setattr(worker, 'index_video', lambda *_: None)
    worker.process(job)
    video = fetch_videos()[0]
    assert video['status'] == 'done', video['error']
    chunks = transcript_for_video(video['id'])
    assert any(chunk['kind'] == 'screen' and 'Service' in chunk['text'] for chunk in chunks)
    assert any(chunk['kind'] == 'concept' for chunk in chunks)
    assert not any(chunk['kind'] == 'speech' for chunk in chunks)


@pytest.mark.skipif(not shutil.which('ffmpeg'), reason='ffmpeg required')
def test_total_source_failure_marks_the_lecture_failed(tmp_path, monkeypatch):
    job = _queue(tmp_path, monkeypatch)
    monkeypatch.setattr(worker, 'transcribe', lambda *_: (_ for _ in ()).throw(RuntimeError('whisper missing')))
    monkeypatch.setattr(worker, 'extract_frames', lambda *_: (_ for _ in ()).throw(RuntimeError('ffmpeg missing')))
    monkeypatch.setattr(worker, 'index_video', lambda *_: None)
    worker.process(job)
    video = fetch_videos()[0]
    assert video['status'] == 'failed'
    assert 'No learning object' in (video['error'] or '')


@pytest.mark.skipif(not shutil.which('ffmpeg'), reason='ffmpeg required')
def test_previous_quiz_survives_when_both_sources_fail(tmp_path, monkeypatch):
    job = _queue(tmp_path, monkeypatch)
    video = fetch_videos()[0]
    built = assemble(video['id'], [{'start': 1, 'end': 3, 'text': 'Pods are the smallest deployable unit in Kubernetes.'}], [])
    persist(video, built, [{'stage': 'seed', 'status': 'ok'}], source_ready=True)
    monkeypatch.setattr(worker, 'transcribe', lambda *_: (_ for _ in ()).throw(RuntimeError('whisper missing')))
    monkeypatch.setattr(worker, 'extract_frames', lambda *_: (_ for _ in ()).throw(RuntimeError('ffmpeg missing')))
    monkeypatch.setattr(worker, 'index_video', lambda *_: None)
    worker.process(job)
    video = fetch_videos()[0]
    assert video['status'] == 'done', video['error']
    with db.connect() as conn:
        row = conn.execute('SELECT questions_json FROM lesson_quizzes WHERE video_id=?', (video['id'],)).fetchone()
    assert row and 'Pods' in row['questions_json']
