from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path
from app import db, study, library


def setup(tmp_path, monkeypatch):
    root=tmp_path/'courses'; (root/'Data').mkdir(parents=True)
    (root/'Data'/'lesson.mp4').write_bytes(b'video')
    dbfile=tmp_path/'data'/'test.sqlite3'
    for mod in (db,library):
        monkeypatch.setattr(mod, 'settings', replace(db.settings, courses_dir=root, data_dir=dbfile.parent))
    db.init_db(dbfile)
    library.scan_courses(root, dbfile)
    return dbfile, db.fetch_videos(dbfile)[0]['id']


def test_learning_state_persists(tmp_path, monkeypatch):
    dbfile, vid=setup(tmp_path,monkeypatch)
    assert len(study.get_progress(path=dbfile))==1
    study.set_progress(vid,percent=42,position=65,path=dbfile)
    assert study.get_progress(path=dbfile)[0]['percent']==42
    study.set_progress(vid,percent=100,position=120,path=dbfile)
    assert study.get_progress(path=dbfile)[0]['completed']==1


def test_scheduler_intervals_and_failure():
    assert study.sm2(0,0,2.5,5)[:2]==(1,1)
    assert study.sm2(1,1,2.5,5)[:2]==(2,6)
    assert study.sm2(2,6,2.5,4)[:2]==(3,15)
    assert study.sm2(2,6,2.5,1)[:2]==(0,1)


def test_cards_due_and_grade(tmp_path,monkeypatch):
    dbfile,vid=setup(tmp_path,monkeypatch)
    cards=study.add_cards('Data',[{'video_id':vid,'question':'What does retry mean?','answer':'Try again','source_start':35}],path=dbfile)
    assert len(study.due_cards('Data',path=dbfile))==1
    output=study.grade_card(cards[0]['id'],5,path=dbfile,now=datetime.now(timezone.utc))
    assert output['interval_days']==1
    assert study.due_cards('Data',path=dbfile)==[]


def test_prevent_wrong_course_card(tmp_path,monkeypatch):
    dbfile,vid=setup(tmp_path,monkeypatch)
    import pytest
    with pytest.raises(ValueError):
        study.add_cards('Other',[{'video_id':vid,'question':'Some detailed question?','answer':'Answer'}],path=dbfile)
