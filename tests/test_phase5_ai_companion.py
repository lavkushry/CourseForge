"""Phase 5 acceptance tests: Proactive AI companion, timestamp citations,
search the moment, ready-made briefs, auto quizzes & admin approval, adaptive review,
smart resume, mock interview prep, teacher insights, placement diagnostic, and Hinglish guardrails."""
import json
import pytest
from fastapi.testclient import TestClient

from app import main, db, tutor, companion
from tests.test_academy import academy_env, PASSWORD


def test_phase5_timestamp_grounded_tutor_and_offline_fallback(academy_env, monkeypatch):
    """Criterion 24 & 33: Every answer cites exact lesson and timestamp; honest fallback if offline or no evidence."""
    config, admin, admin_client, student, _ = academy_env
    c, u = student('tutor_learner@courseforge.test')

    # 1. No evidence found: honestly states so
    monkeypatch.setattr(tutor, 'retrieve', lambda *a, **kw: [])
    out_empty = tutor.ask('What is quantum cryptography in this course?')
    assert out_empty['sources'] == []
    assert 'not covered' in out_empty['answer'].lower() or 'could not find' in out_empty['answer'].lower()

    # 2. Evidence present with simulated offline model: returns graceful synthesis with clickable timestamp link
    sample_evidence = [{
        'chunk_id': 'chunk_1',
        'video_id': 'lecture',
        'course': 'SQL',
        'title': 'SQL joins',
        'kind': 'speech',
        'start': 25.0,
        'end': 90.0,
        'text': 'Inner joins return rows when there is a match in both tables based on join condition.',
        'frame_path': None,
        'score': 0.9,
    }]
    monkeypatch.setattr(tutor, 'retrieve', lambda *a, **kw: sample_evidence)
    # Simulate Ollama offline by raising ConnectionError in httpx
    import httpx
    def mock_post(*a, **kw):
        raise httpx.ConnectError('Connection refused to Ollama')
    monkeypatch.setattr(httpx.Client, 'post', mock_post)

    out = tutor.ask('How do inner joins work?')
    assert out['sources'] != []
    # Must include markdown link in exact format [Watch MM:SS in Title](#learning/video_id?t=seconds)
    assert '[Watch 0:25 in SQL joins](#learning/lecture?t=25)' in out['answer']

    # 3. Hinglish query support
    hinglish_out = tutor.ask('SQL joins kya hota hai aur kaise kaam karta hai?')
    assert '[Watch 0:25 in SQL joins](#learning/lecture?t=25)' in hinglish_out['answer']

    # 4. Check ai_tutor_logs table recorded query
    with db.connect() as conn:
        logs = conn.execute('SELECT * FROM ai_tutor_logs ORDER BY created_at DESC').fetchall()
        assert len(logs) >= 1
        assert logs[0]['video_id'] is None or logs[0]['video_id'] == 'lecture' or logs[0]['course'] is not None


def test_phase5_search_the_moment(academy_env):
    """Criterion 25: Universal search returns transcript moments with jump timestamps."""
    config, admin, admin_client, student, _ = academy_env
    c, u = student('moment_searcher@courseforge.test')

    # Search for "joins" which is in chunks of the fixture
    res = c.get('/api/search?q=joins')
    assert res.status_code == 200
    data = res.json()
    assert 'moments' in data
    assert len(data['moments']) >= 1
    m = data['moments'][0]
    assert m['video_id'] == 'lecture'
    assert m['start'] == 25.0
    assert m['time_label'] == '0:25'
    assert 'Inner joins' in m['text']
    assert m['action_url'] == '#learning/lecture?t=25'


def test_phase5_lesson_briefs(academy_env):
    """Criterion 26: Ready-made 5-bullet lesson briefs from transcripts; empty state if missing."""
    config, admin, admin_client, student, _ = academy_env
    c, u = student('brief_student@courseforge.test')

    # 1. Lesson with transcripts ('lecture')
    res = c.get('/api/videos/lecture/brief')
    assert res.status_code == 200
    data = res.json()
    assert data['available'] is True
    assert len(data['bullets']) == 5
    assert len(data['prerequisites']) > 10
    assert len(data['outcome']) > 10

    # 2. Lesson without transcripts ('lecture_empty' in SQL)
    with db.connect() as conn:
        conn.execute('''INSERT OR REPLACE INTO videos(id, path, course, title, bytes, mtime_ns, status, duration, created_at)
                        VALUES('lecture_empty', 'SQL/empty.mp4', 'SQL', 'SQL empty', 0, 1, 'done', 60, ?)''',
                     (db.utcnow(),))
    res_empty = c.get('/api/videos/lecture_empty/brief')
    assert res_empty.status_code == 200
    data_empty = res_empty.json()
    assert data_empty['available'] is False
    assert data_empty['bullets'] == []


def test_phase5_admin_quizzes_and_adaptive_review(academy_env):
    """Criterion 27 & 28: Auto quizzes & admin management; adaptive review prioritizing struggles."""
    config, admin, admin_client, student, _ = academy_env
    c, u = student('adaptive_user@courseforge.test')

    # 1. Create a quiz attempt where user failed
    quiz_res = c.get('/api/videos/lecture/quiz')
    assert quiz_res.status_code == 200
    q_data = quiz_res.json()
    qid = q_data['quiz_id']
    fail_answers = {q['id']: 3 for q in q_data['questions']} # wrong answer

    submit_res = c.post('/api/videos/lecture/quiz/attempts', json={
        'quiz_id': qid,
        'answers': fail_answers,
    })
    assert submit_res.status_code == 201
    assert submit_res.json()['passed'] is False

    # 2. Adaptive review endpoint prioritizes cards from the failed lesson
    adapt_res = c.get('/api/reviews/adaptive?course=SQL')
    assert adapt_res.status_code == 200
    cards = adapt_res.json()['cards']
    assert len(cards) >= 1
    # Check that highest card has adaptive priority
    assert cards[0]['adaptive_score'] >= 50.0
    assert 'Quiz retry priority' in cards[0].get('adaptive_tag', '')

    # 3. Admin quiz management endpoints
    admin_quizzes = admin_client.get('/api/admin/courses/SQL/quizzes')
    assert admin_quizzes.status_code == 200
    q_list = admin_quizzes.json()['quizzes']
    assert len(q_list) >= 1
    assert q_list[0]['video_id'] == 'lecture'

    # Admin inspect quiz detail
    q_detail = admin_client.get(f"/api/admin/quizzes/{qid}")
    assert q_detail.status_code == 200
    assert len(q_detail.json()['questions']) >= 3

    # Admin update quiz
    up_res = admin_client.put(f"/api/admin/quizzes/{qid}", json={
        'questions': q_detail.json()['questions'],
        'status': 'approved',
    })
    assert up_res.status_code == 200
    assert up_res.json()['status'] == 'approved'

    # Admin regenerate quiz
    regen_res = admin_client.post('/api/admin/videos/lecture/quiz/regenerate')
    assert regen_res.status_code == 200


def test_phase5_smart_resume_and_interview_prep_and_placement(academy_env, monkeypatch):
    """Criteria 29, 30, 31, 32: Smart resume banner, interview prep mock, teacher insights, placement diagnostic."""
    config, admin, admin_client, student, _ = academy_env
    c, u = student('prep_candidate@courseforge.test')

    # 1. Placement diagnostic
    placement_res = c.get('/api/courses/SQL/placement-test')
    assert placement_res.status_code == 200
    diag_data = placement_res.json()
    assert diag_data['question_count'] == 10
    assert len(diag_data['questions']) == 10

    # Submit placement test
    ans_dict = {f"q_{i+1}": 1 for i in range(10)}
    sub_diag = c.post('/api/courses/SQL/placement-test/submit', json={'answers': ans_dict})
    assert sub_diag.status_code == 201
    assert 'recommended_lesson_id' in sub_diag.json()
    assert 'level_label' in sub_diag.json()

    # 2. Smart resume: simulate 3 days of absence
    with db.connect() as conn:
        past_time = "2026-10-01T12:00:00Z"
        conn.execute('''INSERT OR REPLACE INTO video_progress(user_id, video_id, percent, position, completed, updated_at)
                        VALUES(?, 'lecture', 50, 60.0, 0, ?)''', (u['id'], past_time))

    smart_res = c.get('/api/smart-resume')
    assert smart_res.status_code == 200
    s_data = smart_res.json()
    assert s_data['show_banner'] is True
    assert 'SQL joins' in s_data['banner_text']
    assert s_data['days_absent'] >= 2

    # 3. Interview prep mode
    topics_res = c.get('/api/interview-prep/topics')
    assert topics_res.status_code == 200
    topics = topics_res.json()['topics']
    assert len(topics) >= 1
    t_id = topics[0]['topic_id']

    # Start mock interview
    start_res = c.post('/api/interview-prep/start', json={'topic_id': t_id, 'course': 'SQL'})
    assert start_res.status_code == 201
    session_id = start_res.json()['session_id']
    assert len(start_res.json()['question']) > 15

    # Evaluate answer
    eval_res = c.post('/api/interview-prep/evaluate', json={
        'session_id': session_id,
        'answer': 'ADLS Gen2 uses hierarchical namespace for atomic rename operations and directory ACL permissions.',
    })
    assert eval_res.status_code == 200
    assert eval_res.json()['score'] >= 50
    assert eval_res.json()['readiness_score'] >= 30
    assert len(eval_res.json()['feedback']) > 20

    # 4. Teacher insights for admin
    insights_res = admin_client.get('/api/admin/teacher-insights')
    assert insights_res.status_code == 200
    ins_data = insights_res.json()
    assert 'top_tutor_topics' in ins_data
    assert 'high_fail_quiz_questions' in ins_data
    assert 'total_ai_queries' in ins_data
    assert 'total_tokens' in ins_data
    assert 'estimated_cost_usd' in ins_data
