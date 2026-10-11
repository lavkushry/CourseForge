import json
from datetime import datetime, timezone
import pytest
from fastapi.testclient import TestClient

from app import db, retention, engagement
from tests.test_academy import academy_env


def test_quiz_generation_and_scoring(academy_env):
    _, _, _, student, _ = academy_env
    client, user = student()

    # 1. Fetch Quiz for the fixture's 'lecture' video
    resp = client.get('/api/videos/lecture/quiz')
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert 'quiz_id' in data
    assert 'questions' in data
    assert len(data['questions']) >= 3
    for q in data['questions']:
        assert 'id' in q
        assert 'question' in q
        assert len(q['options']) == 4
        # Public projection does NOT expose answer key
        assert 'correct_index' not in q
        assert 'explanation' not in q

    quiz_id = data['quiz_id']

    # 2. Submit wrong answers (fail -> friendly retry suggested)
    with db.connect() as conn:
        row = conn.execute('SELECT questions_json FROM lesson_quizzes WHERE id=?', (quiz_id,)).fetchone()
        q_raw = json.loads(row['questions_json'])
        wrong_answers = {q['id']: (q['correct_index'] + 1) % 4 for q in q_raw}
        correct_answers = {q['id']: q['correct_index'] for q in q_raw}

    fail_resp = client.post(
        '/api/videos/lecture/quiz/attempts',
        json={'quiz_id': quiz_id, 'answers': wrong_answers}
    )
    assert fail_resp.status_code == 201, fail_resp.text
    fail_data = fail_resp.json()
    assert fail_data['passed'] is False
    assert fail_data['score'] == 0
    assert 'suggested_review' in fail_data
    assert len(fail_data['suggested_review']) > 0

    # 3. Submit correct answers (pass -> Learned ✓ state)
    pass_resp = client.post(
        '/api/videos/lecture/quiz/attempts',
        json={'quiz_id': quiz_id, 'answers': correct_answers}
    )
    assert pass_resp.status_code == 201, pass_resp.text
    pass_data = pass_resp.json()
    assert pass_data['passed'] is True
    assert pass_data['score'] == 100
    assert pass_data['correct_count'] == len(correct_answers)

    # 4. Check status on quiz fetch
    status_resp = client.get('/api/videos/lecture/quiz')
    assert status_resp.status_code == 200
    assert status_resp.json()['status']['passed'] is True
    assert status_resp.json()['status']['last_score'] == 100


def test_review_session_completion_and_habits(academy_env):
    _, _, _, student, _ = academy_env
    client, user = student()

    resp = client.post(
        '/api/reviews/complete',
        json={'course': 'SQL', 'cards_count': 5}
    )
    assert resp.status_code == 201, resp.text
    data = resp.json()
    assert data['status'] == 'completed'
    assert data['habit_credited'] is True
    assert data['cards_reviewed'] == 5


def test_course_certificate_flow(academy_env):
    config, _, admin_client, student, _ = academy_env
    client, user = student()

    # 1. Incomplete course -> Not yet eligible
    resp = client.get('/api/courses/SQL/certificate')
    assert resp.status_code == 200
    assert resp.json().get('eligible') is False or resp.json().get('issued') is False

    # 2. Complete the single lecture in course 'SQL'
    now = datetime.now(timezone.utc).isoformat()
    with db.connect() as conn:
        conn.execute(
            'INSERT OR REPLACE INTO video_progress(user_id, video_id, percent, position, completed, updated_at) VALUES(?,?,100,120,1,?)',
            (user['id'], 'lecture', now)
        )
        conn.commit()

    # Pass the quiz
    q = retention.get_or_create_quiz('lecture', count=3)
    with db.connect() as conn:
        row = conn.execute('SELECT questions_json FROM lesson_quizzes WHERE id=?', (q['quiz_id'],)).fetchone()
        q_raw = json.loads(row['questions_json'])
        correct_answers = {item['id']: item['correct_index'] for item in q_raw}
    
    pass_res = client.post(
        '/api/videos/lecture/quiz/attempts',
        json={'quiz_id': q['quiz_id'], 'answers': correct_answers}
    )
    assert pass_res.status_code == 201

    # 3. Now request certificate -> Successfully issued!
    cert_resp = client.get('/api/courses/SQL/certificate')
    assert cert_resp.status_code == 200, cert_resp.text
    cert_data = cert_resp.json()
    assert cert_data.get('issued') is True
    code = cert_data['verification_code']
    assert code.startswith('CF-')

    # 4. Public verification API (logged out visitor)
    public_client = TestClient(client.app, base_url='https://testserver')
    v_resp = public_client.get(f'/api/certificates/verify/{code}')
    assert v_resp.status_code == 200
    v_data = v_resp.json()
    assert v_data['valid'] is True
    assert v_data['course'] == 'SQL'
    assert v_data['student_name'] == user['name']

    # 5. Public HTML verification page (logged out visitor)
    html_resp = public_client.get(f'/verify/{code}')
    assert html_resp.status_code == 200
    assert 'text/html' in html_resp.headers['content-type']
    assert user['name'] in html_resp.text
    assert 'SQL' in html_resp.text
    assert code in html_resp.text

    # 6. Invalid verification code -> 404
    bad_resp = public_client.get('/verify/CF-UNKNOWN-1234')
    assert bad_resp.status_code == 404


def test_admin_engagement_retention_metrics(academy_env):
    _, _, admin_client, student, _ = academy_env
    client, user = student()

    # Complete a quiz attempt and a review session
    q = retention.get_or_create_quiz('lecture', count=3)
    with db.connect() as conn:
        row = conn.execute('SELECT questions_json FROM lesson_quizzes WHERE id=?', (q['quiz_id'],)).fetchone()
        q_raw = json.loads(row['questions_json'])
        correct_answers = {item['id']: item['correct_index'] for item in q_raw}
    client.post('/api/videos/lecture/quiz/attempts', json={'quiz_id': q['quiz_id'], 'answers': correct_answers})
    client.post('/api/reviews/complete', json={'course': 'SQL', 'cards_count': 3})

    # Fetch admin overview report
    admin_rep = admin_client.get('/api/admin/overview').json()
    eng = admin_rep['engagement']
    assert 'quiz_pass_rate' in eng
    assert eng['quiz_pass_rate'] == 100.0
    assert eng['quizzes_taken'] >= 1
    assert eng['review_session_completion'] >= 1
