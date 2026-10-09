"""FFmpeg + SQLite integration test; model inference is mocked to avoid downloads."""
import shutil
import subprocess
from pathlib import Path
from dataclasses import replace
import pytest
from app import worker, db, library, extractor
from app.config import settings
from app.db import init_db, fetch_videos, claim_job, fetch_jobs, transcript_for_video
from app.library import scan_courses


@pytest.mark.skipif(not shutil.which('ffmpeg') or not shutil.which('ffprobe'), reason='ffmpeg required')
def test_real_video_processing_pipeline_with_fake_models(tmp_path, monkeypatch):
    courses=tmp_path/'courses';(courses/'Kubernetes').mkdir(parents=True)
    clip=courses/'Kubernetes'/'intro.mp4'
    subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','color=c=black:s=640x360:r=5',
                    '-t','11','-vf','drawtext=text=Kubernetes Pods:fontsize=38:fontcolor=white:x=40:y=40',
                    '-c:v','mpeg4','-y',str(clip)],check=True,timeout=30)
    data=tmp_path/'data'
    test_settings = replace(settings, courses_dir=courses, data_dir=data,
                            frame_interval=10, max_frames=10, disable_frames=False, enable_vision=False)
    for module in (worker, db, library, extractor):
        monkeypatch.setattr(module, 'settings', test_settings)
    monkeypatch.setattr(worker,'transcribe',lambda *_:([{'start':0,'end':5,'text':'Pods are the smallest deployable unit in Kubernetes.'}],'en'))
    captured=[]
    monkeypatch.setattr(worker,'index_video',lambda vid,chunks:captured.extend(chunks))
    init_db()
    assert scan_courses()['imported']==1
    job=claim_job()
    worker.process(job)
    video=fetch_videos()[0]
    assert video['status']=='done', video['error']
    assert 10.0 <= video['duration'] <= 12.0
    chunks=transcript_for_video(video['id'])
    assert any(c['kind']=='speech' for c in chunks)
    assert any(c['kind']=='screen' and c['frame_path'] for c in chunks)
    assert all(c['video_id']==video['id'] for c in captured)
    assert fetch_jobs()[0]['status']=='done'
