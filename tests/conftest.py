import os
os.environ.setdefault('PLAYER_LEASE_SECONDS', '30')
"""Catalog-dependent streaming contracts use disposable, deterministic records."""
from dataclasses import replace
import pytest


@pytest.fixture(autouse=True)
def streaming_catalog(request, tmp_path, monkeypatch):
    if request.module.__name__ not in ('test_stage1_streaming_foundations','test_stage4_title_and_episodes'):
        return
    from app import db, main, artwork, course_metadata
    config=replace(db.settings,data_dir=tmp_path/'data',courses_dir=tmp_path/'courses')
    for module in (db,main,artwork,course_metadata):monkeypatch.setattr(module,'settings',config)
    db.init_db()
    with db.connect() as conn:
        now=db.utcnow()
        for index,course in enumerate(('Deepak Data Engg','Cloud Fundamentals')):
            conn.execute('INSERT INTO videos(id,path,course,title,bytes,mtime_ns,status,duration,created_at) VALUES(?,?,?,?,?,?,?,120,?)',
                         (f'catalog-{index}',f'/fixture/{index}.mp4',course,'[001] Introduction',0,1,'done',now))
            conn.execute('INSERT INTO course_metadata VALUES(?,?,?,?,?,?,?)',
                         (course,course,'Example instructor','Engineering','[]',None,now))
            conn.execute('INSERT INTO course_publication VALUES(?,1,?,?)',(course,'Fixture course description',now))
