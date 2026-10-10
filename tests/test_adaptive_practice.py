"""P1.6 end-to-end API coverage for roadmap-linked, verified practice."""
import json
from dataclasses import replace
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import db, labs, library, main, learning_paths, practice


def seed(tmp_path, monkeypatch):
    root = tmp_path / 'courses' / 'SQL'
    root.mkdir(parents=True)
    (root / 'intro.mp4').write_bytes(b'video sample')
    config = replace(db.settings, courses_dir=root.parent, data_dir=tmp_path / 'data')
    for target in (db, library, main, labs):
        monkeypatch.setattr(target, 'settings', config)
    db.init_db(config.db_path)
    library.scan_courses(root.parent, config.db_path)
    video = db.fetch_videos(config.db_path)[0]
    syllabus = {'course': 'SQL', 'source_fingerprint': 'source-stable', 'topics': [
        {'title': 'SQL joins', 'objectives': ['Understand SQL joins and relational queries'],
         'sources': [{'video_id': video['id'], 'video_title': video['title'], 'course': 'SQL', 'start': 35}]},
    ]}
    with db.connect(config.db_path) as conn:
        conn.execute('INSERT INTO syllabi VALUES (?,?,?,?)',
                     ('SQL', json.dumps(syllabus), db.utcnow(), 'source-stable'))
    path = learning_paths.generate(['SQL'], 'SQL interview preparation', db_path=config.db_path, use_ai=False)
    return config, path, video


def assessed(config, path, score):
    id = 'a' + str(score)
    with db.connect(config.db_path) as dbconn:
        dbconn.execute('INSERT INTO topic_assessments VALUES (?,?,?,?,?,?)',
                       (id, path['id'], path['steps'][0]['id'], 'fingerprint', '{}', db.utcnow()))
        dbconn.execute('INSERT INTO topic_assessment_attempts VALUES (?,?,?,?,?,?,?)',
                       ('t'+str(score), id, score, round(score/100*3), 3, '{}', db.utcnow()))


def result(passed):
    return {'passed': passed, 'checks': [
        {'passed': True, 'name': 'Valid SQL'},
        {'passed': passed, 'name': 'Correct output'},
    ]}


def test_recommendation_uses_actual_topics_and_mastery(tmp_path, monkeypatch):
    config, path, video = seed(tmp_path, monkeypatch)
    report = practice.recommend(path['id'], config.db_path)
    assert len(report['recommendations']) == 1
    entry = report['recommendations'][0]
    assert entry['lab_slug'] == 'sql-customer-revenue'
    assert entry['source']['video_id'] == video['id']
    assert entry['source']['start'] == 35
    assert entry['action'] == 'Assess the concept, then practice'
    assessed(config, path, 40)
    weak = practice.recommend(path['id'], config.db_path)['recommendations'][0]
    assert weak['assessment_score'] == 40
    assert weak['action'] == 'Practice weak concept'
    assert weak['priority'] > entry['priority']


def test_mastered_topic_is_not_falsely_flagged_weak(tmp_path, monkeypatch):
    config, path, _ = seed(tmp_path, monkeypatch)
    assessed(config, path, 100)
    suggestions = practice.recommend(path['id'], config.db_path)
    assert not suggestions['recommendations']
    assert path['steps'][0]['id'] in suggestions['topics_without_recommendations']
    assert learning_paths.get_path(path['id'], config.db_path)['completion_percent'] == 0


def test_linked_lab_session_and_append_only_attempt_history(tmp_path, monkeypatch):
    config, path, _ = seed(tmp_path, monkeypatch)
    assessed(config, path, 40)
    step = path['steps'][0]
    lab = practice.start_recommended(path['id'], step['id'], 'sql-customer-revenue', config.db_path)
    assert lab['practice_context']['step_id'] == step['id']
    failed = practice.record_verified_grade(lab['session_id'], result(False), config.db_path)
    assert failed['passed'] is False
    first = practice.recommend(path['id'], config.db_path)['recommendations'][0]
    assert first['action'] == 'Retry graded lab'
    assert first['lab_attempts'] == 1
    success = practice.record_verified_grade(lab['session_id'], result(True), config.db_path)
    assert success['passed'] is True
    attempts = practice.history(path['id'], db_path=config.db_path)
    assert len(attempts) == 2 and attempts[0]['passed'] and not attempts[1]['passed']
    assert attempts[0]['checks_total'] == 2
    updated = learning_paths.get_path(path['id'], config.db_path)
    assert updated['lab_attempts'] == 2
    assert updated['topics_with_passed_labs'] == 1
    assert updated['steps'][0]['practice']['passed_labs'] == ['sql-customer-revenue']
    assert updated['steps'][0]['completed'] is False
    assert practice.recommend(path['id'], config.db_path)['recommendations'][0]['action'] == 'Recheck the concept'


def test_refuse_unrelated_or_unknown_and_outdated_paths(tmp_path, monkeypatch):
    config, path, _ = seed(tmp_path, monkeypatch)
    sid = path['steps'][0]['id']
    with pytest.raises(practice.PracticeInputError, match='does not match'):
        practice.start_recommended(path['id'], sid, 'ansible-idempotent-web', config.db_path)
    with pytest.raises(practice.PracticeNotFound):
        practice.start_recommended(path['id'], sid, 'fake-lab', config.db_path)
    with pytest.raises(practice.PracticeNotFound):
        practice.start_recommended(path['id'], 'unknown', 'sql-customer-revenue', config.db_path)
    with db.connect(config.db_path) as conn:
        doc = json.loads(conn.execute('SELECT content_json FROM syllabi WHERE course=?', ('SQL',)).fetchone()[0])
        doc['source_fingerprint'] = 'changed'
        conn.execute('UPDATE syllabi SET content_json=? WHERE course=?', (json.dumps(doc), 'SQL'))
    with pytest.raises(practice.PracticeInputError, match='outdated'):
        practice.start_recommended(path['id'], sid, 'sql-customer-revenue', config.db_path)


def test_only_real_verified_grader_shapes_recorded(tmp_path, monkeypatch):
    config, path, _ = seed(tmp_path, monkeypatch)
    session = practice.start_recommended(path['id'], path['steps'][0]['id'], 'sql-customer-revenue', config.db_path)
    with pytest.raises(practice.PracticeInputError):
        practice.record_verified_grade(session['session_id'], {'passed': True, 'checks': []}, config.db_path)
    with pytest.raises(practice.PracticeInputError):
        practice.record_verified_grade(session['session_id'], {'passed': True, 'checks': [{'passed': 'yes'}]}, config.db_path)
    mismatch = practice.record_verified_grade(session['session_id'], {'passed': True, 'checks': [{'passed': False}]}, config.db_path)
    assert not mismatch['passed']
    assert practice.record_verified_grade('unlinked', result(True), config.db_path) is None


def test_api_recommend_launch_grade_read_history(tmp_path, monkeypatch):
    config, path, _ = seed(tmp_path, monkeypatch)
    monkeypatch.setattr(labs, '_offline_grading', lambda sid, slug: result(True))
    base = f'/api/learning-paths/{path["id"]}'
    step = path['steps'][0]['id']
    with TestClient(main.app) as client:
        api = client.get(base + '/practice-recommendations')
        assert api.status_code == 200 and len(api.json()['recommendations']) == 1
        assert client.get('/api/learning-paths/missing/practice-recommendations').status_code == 404
        assert client.get(base+'/practice-history?step_id=unknown').status_code == 404
        bad = client.post(base+f'/steps/{step}/practice/ansible-idempotent-web/start')
        assert bad.status_code == 409
        url = base+f'/steps/{step}/practice/sql-customer-revenue/start'
        assert client.post(url, headers={'Origin':'http://malicious.invalid'}).status_code == 403
        created = client.post(url)
        assert created.status_code == 201, created.text
        session = created.json()['session_id']
        graded = client.post(f'/api/lab-sessions/{session}/submit', json={'validate_in_kind':False})
        assert graded.status_code == 200, graded.text
        assert graded.json()['practice_attempt']['passed']
        timeline = client.get(base+'/practice-history').json()['attempts']
        assert len(timeline) == 1 and timeline[0]['session_id'] == session
        assert 'result_json' not in timeline[0]
        updated_path = client.get(base).json()
        assert updated_path['lab_attempts'] == 1
        assert updated_path['completed_steps'] == 0


def test_unlinked_lab_keeps_original_behavior(tmp_path, monkeypatch):
    config, path, _ = seed(tmp_path, monkeypatch)
    monkeypatch.setattr(labs, '_offline_grading', lambda sid, slug: result(True))
    with TestClient(main.app) as client:
        sid = client.post('/api/labs/sql-customer-revenue/start').json()['session_id']
        finished = client.post('/api/lab-sessions/'+sid+'/submit', json={}).json()
        assert finished['passed'] is True and 'practice_attempt' not in finished
        assert practice.history(path['id'], db_path=config.db_path) == []


def test_frontend_practice_contract_and_isolation():
    root = Path(__file__).parents[1]
    html = (root/'app/static/index.html').read_text()
    code = (root/'app/static/practice.js').read_text()
    services = (root/'app/static/services.js').read_text()
    for element in ('practicePathSelect', 'practiceRecommendations','practiceHistory','practiceRefreshBtn'):
        assert f'id="{element}"' in html
        assert f"$('#{element}')" in code
    assert 'practice.js' in html and 'practice.css' in html
    assert 'startRecommendedPractice' in services
    assert '--network=none' in (root/'app/labs.py').read_text()
