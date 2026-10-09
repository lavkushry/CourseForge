from pathlib import Path
from app.db import (init_db, fetch_videos, fetch_jobs, claim_job, finish_job,
                    queue_video, replace_chunks, keyword_search, transcript_for_video)
from app.library import scan_courses


def test_import_scan_and_worker_queue(tmp_path: Path):
    root=tmp_path/'courses'; root.mkdir()
    sub=root/'Kubernetes';sub.mkdir()
    video=sub/'01 - pods.mp4';video.write_bytes(b'fake video bytes')
    database=tmp_path/'data'/'test.db';init_db(database)
    first=scan_courses(root, database)
    assert first == {'found':1,'imported':1,'changed':0,'unchanged':0}
    assert scan_courses(root,database)['unchanged']==1
    videos=fetch_videos(database)
    assert videos[0]['course']=='Kubernetes'
    job=claim_job(database)
    assert job is not None and job['video_id']==videos[0]['id']
    assert claim_job(database) is None
    finish_job(job['id'],job['video_id'],language='en',duration=43,path=database)
    assert fetch_videos(database)[0]['status']=='done'
    assert queue_video(job['video_id'], database) is True
    assert queue_video(job['video_id'], database) is False
    video.write_bytes(b'new fake video bytes')
    # While reindex is queued, scan does not append another job.
    assert scan_courses(root,database)['imported']==0
    assert len(fetch_jobs(database))==2


def test_fts_and_chunk_storage(tmp_path: Path):
    root=tmp_path/'courses';root.mkdir()
    (root/'lecture.mp4').write_bytes(b'test')
    db=tmp_path/'cf.db';init_db(db)
    scan_courses(root,db)
    video=fetch_videos(db)[0]
    record={'id':'chunk-123','video_id':video['id'],'kind':'speech','start':4.0,'end':9.0,
            'text':'Kubernetes pods schedule containers','frame_path':None}
    replace_chunks(video['id'],[record],db)
    hits=keyword_search('Kubernetes',video_id=video['id'],path=db)
    assert len(hits)==1 and hits[0]['title']=='lecture'
    assert transcript_for_video(video['id'],db)[0]['start']==4.0
    replace_chunks(video['id'],[],db)
    assert not keyword_search('Kubernetes',path=db)


def test_symlink_cannot_escape_courses(tmp_path: Path):
    base=tmp_path/'courses';base.mkdir()
    external=tmp_path/'outside.mp4';external.write_bytes(b'video')
    (base/'sneaky.mp4').symlink_to(external)
    db=tmp_path/'test.sqlite';init_db(db)
    assert scan_courses(base,db)['found']==0
