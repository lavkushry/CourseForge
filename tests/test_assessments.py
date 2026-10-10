"""Acceptance tests for AI-generated practice, server-side grading and source safety."""
import json
from dataclasses import replace

import httpx
import pytest
from fastapi.testclient import TestClient

from app import assessments, db, learning_paths, library, main


def setup_course(tmp_path, monkeypatch):
    root = tmp_path / 'courses'
    (root / 'SQL').mkdir(parents=True)
    (root / 'SQL' / 'lesson.mp4').write_bytes(b'movie')
    config = replace(db.settings, courses_dir=root, data_dir=tmp_path / 'run')
    for module in (main, db, library):
        monkeypatch.setattr(module, 'settings', config)
    db.init_db(config.db_path)
    library.scan_courses(root, config.db_path)
    video = db.fetch_videos(config.db_path)[0]
    syllabus = {'course': 'SQL', 'source_fingerprint': 'stable-1',
                'topics': [{'title': 'SQL joins', 'objectives': ['Understand relational joins'],
                            'sources': [{'video_id': video['id'], 'video_title': video['title'], 'start': 25}]}]}
    with db.connect(config.db_path) as conn:
        conn.execute('INSERT INTO syllabi VALUES (?,?,?,?)',
                     ('SQL', json.dumps(syllabus), db.utcnow(), syllabus['source_fingerprint']))
        conn.execute('INSERT INTO chunks(id,video_id,kind,start,end,text,frame_path) VALUES (?,?,?,?,?,?,?)',
                     ('chunk1', video['id'], 'speech', 25, 90,
                      'An INNER JOIN returns only matching rows from both joined relations. '
                      'A LEFT JOIN preserves every row from the left table and fills missing right columns with null.', None))
    path = learning_paths.generate(['SQL'], 'Understand database joins',
                                   db_path=config.db_path, use_ai=False)
    return config, path, video


def fake_generator(topic, evidence, count):
    assert topic == 'SQL joins'
    assert evidence[0]['chunk_id'] == 'chunk1'
    return {'questions': [
        {'question': f'When should we use {name} to join relations?',
         'options': ['LEFT JOIN','INNER JOIN','CROSS JOIN','FULL OUTER JOIN'],
         'correct_index': answer, 'source_index': 0,
         'explanation': f'The indexed lecture explains when the {name} applies.',
         'concept': name}
        for name, answer in [('matching rows',1),('keep left rows',0),('matched relation',1),('left-preservation',0),('match',1)]][:count]}


def test_secret_answer_key_and_provenance(tmp_path, monkeypatch):
    config, path, video = setup_course(tmp_path, monkeypatch)
    step = path['steps'][0]
    test = assessments.create(path['id'], step['id'], db_path=config.db_path, generator=fake_generator)
    assert test['question_count'] == 3
    assert 'correct_index' not in json.dumps(test)
    assert 'explanation' not in json.dumps(test)
    assert test['questions'][0]['source']['video_id'] == video['id']
    assert test['questions'][0]['source']['start'] == 25
    assert assessments.get(test['id'], config.db_path) == test
    correct = {q['id']: [1,0,1][i] for i,q in enumerate(test['questions'])}
    result = assessments.submit(test['id'], correct, config.db_path)
    assert result['score'] == 100
    assert result['status'] == 'ready_for_review'
    assert result['review_sources'] == []
    assert result['correct_count'] == 3
    path_after = learning_paths.get_path(path['id'], config.db_path)
    assert path_after['steps'][0]['mastery']['last_score'] == 100
    assert path_after['steps'][0]['completed'] is False  # quiz does not auto-complete roadmap
    retry = assessments.submit(test['id'], {q['id']: 2 for q in test['questions']}, config.db_path)
    assert retry['status'] == 'needs_practice'
    assert len(retry['review_sources']) == 3
    assert all(ref['video_id'] == video['id'] for ref in retry['review_sources'])
    assert learning_paths.get_path(path['id'], config.db_path)['topics_needing_practice'] == 1
    history = assessments.history(path['id'], db_path=config.db_path)
    assert len(history) == 2 and history[0]['score'] == 0
    assert 'answers' not in json.dumps(history)


def test_reject_missing_evidence_and_bad_questions(tmp_path,monkeypatch):
    config,path,_ = setup_course(tmp_path, monkeypatch)
    step=path['steps'][0]
    with db.connect(config.db_path) as conn:
        conn.execute('DELETE FROM chunks')
    with pytest.raises(assessments.AssessmentInputError, match='indexed lecture'):
        assessments.create(path['id'], step['id'], db_path=config.db_path, generator=fake_generator)
    with db.connect(config.db_path) as conn:
        conn.execute('INSERT INTO chunks VALUES (?,?,?,?,?,?,?)',
                     ('chunk1',step['sources'][0]['video_id'],'speech',25,90,'Joining uses an INNER JOIN for matches.',None))
    def invented(_, __, count):
        data=fake_generator('SQL joins',[{'chunk_id':'chunk1'}],count)
        data['questions'][0]['source_index']=888
        return data
    with pytest.raises(assessments.AssessmentInputError,match='Insufficient grounded'):
        assessments.create(path['id'], step['id'], db_path=config.db_path, generator=invented)
    with pytest.raises(assessments.AssessmentInputError):
        assessments.create(path['id'], step['id'], count=8, db_path=config.db_path, generator=fake_generator)


def test_stale_lecture_or_roadmap_rejects_submission(tmp_path,monkeypatch):
    config,path,_ = setup_course(tmp_path, monkeypatch)
    step=path['steps'][0]
    quiz=assessments.create(path['id'], step['id'], db_path=config.db_path, generator=fake_generator)
    answers={q['id']:0 for q in quiz['questions']}
    with db.connect(config.db_path) as conn:
        conn.execute('UPDATE chunks SET text=? WHERE id=?',('newly indexed lecture', 'chunk1'))
    with pytest.raises(assessments.AssessmentConflict,match='content changed'):
        assessments.submit(quiz['id'], answers, config.db_path)
    with db.connect(config.db_path) as conn:
        row=conn.execute('SELECT content_json FROM syllabi WHERE course=?',('SQL',)).fetchone()
        syllabus=json.loads(row[0]);syllabus['source_fingerprint']='new-version'
        conn.execute('UPDATE syllabi SET content_json=? WHERE course=?', (json.dumps(syllabus),'SQL'))
    with pytest.raises(assessments.AssessmentConflict,match='Refresh this learning path'):
        assessments.create(path['id'], step['id'], db_path=config.db_path, generator=fake_generator)
    with pytest.raises(assessments.AssessmentNotFound):
        assessments.get('missing', config.db_path)


def test_http_assessment_flow(tmp_path, monkeypatch):
    config, path, _ = setup_course(tmp_path, monkeypatch)
    monkeypatch.setattr(assessments, '_ollama_questions', fake_generator)
    path_id = path['id']; step_id = path['steps'][0]['id']
    with TestClient(main.app) as client:
        url=f'/api/learning-paths/{path_id}/steps/{step_id}/assessments'
        response=client.post(url,json={'count':3})
        assert response.status_code == 201, response.text
        body=response.json()
        assert client.get('/api/assessments/'+body['id']).json()==body
        assert client.post(url,json={'count':10}).status_code==422
        assert client.post(url.replace(step_id,'missing'),json={'count':3}).status_code==404
        assert client.get('/api/assessments/missing').status_code==404
        attempt_url=f'/api/assessments/{body["id"]}/attempts'
        assert client.post(attempt_url,json={'answers':{}}).status_code==422
        wrong={q['id']:2 for q in body['questions']}
        assert client.post(attempt_url,json={'answers':wrong},headers={'Origin':'http://example.com'}).status_code==403
        result=client.post(attempt_url,json={'answers':wrong})
        assert result.status_code==201, result.text
        assert result.json()['score']==0
        assert len(client.get(f'/api/learning-paths/{path_id}/assessment-history').json()['attempts'])==1
        assert client.get('/api/learning-paths/missing/assessment-history').status_code==404
        assert client.get(f'/api/learning-paths/{path_id}').json()['steps'][0]['mastery']['last_score']==0


def test_frontend_assessment_contract():
    from pathlib import Path
    root=Path(__file__).parents[1]/'app'/'static'
    html=(root/'index.html').read_text()
    js=(root/'assessments.js').read_text()
    for ident in ('assessmentPanel','assessmentHeading','assessmentStatus','assessmentClose',
                  'assessmentForm','assessmentQuestions','assessmentSubmit','assessmentResult'):
        assert f'id="{ident}"' in html
        assert f"$('#{ident}')" in js
    assert 'assessments.js' in html and 'assessments.css' in html
    assert 'dataset.assessStep' in (root/'learning-paths.js').read_text()
    assert 'startAssessment' in (root/'services.js').read_text()
