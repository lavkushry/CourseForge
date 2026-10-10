"""Run one academy worker per database: python -m app.academy_worker."""
import argparse
import fcntl
import json
import logging
import time
from .config import settings
from .db import connect,init_db,learner_id,learner_courses,utcnow
from . import labs,practice,assessments,learning_paths,reviews,syllabus,tutor
from .academy import learning_event

log=logging.getLogger(__name__)


def perform(kind: str,payload: dict):
    if kind=='ask':return tutor.ask(**payload)
    if kind=='reviews':return reviews.generate_cards(**payload)
    if kind=='path':return learning_paths.generate(**payload)
    if kind=='assessment':return assessments.create(**payload)
    if kind=='syllabus':return syllabus.generate(**payload)
    if kind=='lab':
        result=labs.submit_lab(payload['session_id'],kind=payload.get('kind',False))
        linked=practice.record_verified_grade(payload['session_id'],result)
        if linked:result['practice_attempt']=linked
        return result
    raise ValueError('Unknown task kind')


def process_one() -> bool:
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        row=db.execute("SELECT * FROM task_queue WHERE status='queued' ORDER BY created_at,rowid LIMIT 1").fetchone()
        if not row:return False
        db.execute("UPDATE task_queue SET status='running',updated_at=? WHERE id=?",(utcnow(),row['id']))
        user=db.execute('SELECT * FROM users WHERE id=?',(row['user_id'],)).fetchone()
        allowed=None if user and user['role']=='admin' else frozenset(r['course'] for r in db.execute('''SELECT e.course
            FROM enrollments e JOIN course_publication p ON p.course=e.course WHERE e.user_id=? AND p.published=1''',(row['user_id'],)))
    uid_token=learner_id.set(row['user_id']);course_token=learner_courses.set(allowed)
    try:
        if not user or user['suspended'] or not user['verified']:raise ValueError('Account unavailable')
        payload=json.loads(row['payload'])
        from .db import fetch_video,course_allowed
        courses=[payload['course']] if payload.get('course') else payload.get('courses',[])
        if any(not course_allowed(c) for c in courses):raise ValueError('Course enrollment changed')
        if payload.get('video_id') and not fetch_video(payload['video_id']):raise ValueError('Lecture access changed')
        result=perform(row['kind'],payload)
        with connect() as db:
            current=db.execute('SELECT suspended FROM users WHERE id=?',(row['user_id'],)).fetchone()
            if not current or current['suspended']:raise ValueError('Account unavailable')
            db.execute("UPDATE task_queue SET status='done',result=?,updated_at=? WHERE id=?",(json.dumps(result),utcnow(),row['id']))
        learning_event(row['user_id'],row['kind']+'_finished',payload.get('video_id'))
    except Exception:
        log.exception('Academy task %s failed',row['id'])
        with connect() as db:db.execute("UPDATE task_queue SET status='failed',error=?,updated_at=? WHERE id=?",
            ('This task could not finish. Check course access and service availability, then retry.',utcnow(),row['id']))
    finally:
        learner_id.reset(uid_token);learner_courses.reset(course_token)
    return True


def main():
    parser=argparse.ArgumentParser(description='Bounded academy AI and lab worker')
    parser.add_argument('--once',action='store_true');args=parser.parse_args()
    init_db()
    # Kernel lock enforces the one-worker resource bound across processes.
    with (settings.data_dir/'academy-worker.lock').open('w') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:raise SystemExit('An academy worker is already running')
        with connect() as db:db.execute("UPDATE task_queue SET status='failed',error='Worker interrupted. Please retry.',updated_at=? WHERE status='running'",(utcnow(),))
        while True:
            worked=process_one()
            if args.once:return
            if not worked:time.sleep(1)


if __name__=='__main__':
    logging.basicConfig(level=logging.INFO)
    main()
