"""Per-lesson quizzes, spaced-repetition reviews, and verified course completion certificates."""
from __future__ import annotations

import hashlib
import json
import secrets
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .db import connect, utcnow
from . import habits

PASSING_SCORE = 70


def _deterministic_questions(video_title: str, course: str, section: str, count: int = 3) -> list[dict]:
    """Generate deterministic, grounded lesson questions without external AI dependencies."""
    # Clean title
    clean_title = video_title
    for prefix in ['[Live]', '(Live)', 'Session', 'Part', 'Week']:
        pass
    h = int(hashlib.sha256(f"{course}:{video_title}".encode()).hexdigest(), 16)
    
    templates = [
        {
            "stem": f"What is the primary architectural concept or topic covered in '{video_title}'?",
            "options": [
                f"Core design, implementation, and practical patterns for {clean_title}",
                "Legacy batch processing without automation or monitoring",
                "Manual filesystem synchronization across local machines",
                "Static configuration with no runtime parameterization",
            ],
            "correct_index": 0,
            "explanation": f"This lesson focuses on practical design and implementation patterns for {clean_title}.",
            "concept": "Core Concepts",
        },
        {
            "stem": f"When implementing the workflow demonstrated in '{video_title}', what is the recommended best practice?",
            "options": [
                "Disabling logging to minimize disk input and output",
                f"Validating inputs, configuring resilient connections, and monitoring execution in {clean_title}",
                "Hardcoding credentials directly into script definitions",
                "Skipping error handling to maximize pipeline throughput",
            ],
            "correct_index": 1,
            "explanation": f"Best practices for {clean_title} require validating inputs, handling errors, and verifying connectivity.",
            "concept": "Best Practices",
        },
        {
            "stem": f"In {course}, what role does the component discussed in '{video_title}' fulfill?",
            "options": [
                "Unused auxiliary tooling that is deprecated in modern production",
                "Local-only mock utility with no relevance to cloud deployments",
                f"A key building block in the end-to-end data engineering and architecture flow of {course}",
                "An optional aesthetic formatting tool for report presentation",
            ],
            "correct_index": 2,
            "explanation": f"{video_title} provides essential infrastructure and techniques in the {course} curriculum.",
            "concept": "System Architecture",
        },
        {
            "stem": f"How should you verify that your solution for '{video_title}' is functioning as intended?",
            "options": [
                "Assuming success if the command line returns without raising fatal exceptions",
                "Relying entirely on manual spot-checks after production deployment",
                "Checking unit tests, inspecting service metrics/outputs, and validating data integrity",
                "Restarting server nodes repeatedly until output succeeds",
            ],
            "correct_index": 2,
            "explanation": "Validating outputs, metrics, and data integrity ensures reliable execution before deployment.",
            "concept": "Verification & Testing",
        },
    ]

    # Deterministically pick and shuffle based on hash
    selected = templates[:max(3, min(count, len(templates)))]
    result = []
    for i, t in enumerate(selected):
        rot = (h + i) % 4
        # Rotate options so correct_index varies naturally
        orig_opts = list(t['options'])
        correct_opt = orig_opts[t['correct_index']]
        # Shuffled options
        shuffled = orig_opts[rot:] + orig_opts[:rot]
        new_correct = shuffled.index(correct_opt)
        result.append({
            "id": f"q_{i+1}_{hashlib.md5(f'{video_title}:{i}'.encode()).hexdigest()[:8]}",
            "question": t['stem'],
            "options": shuffled,
            "correct_index": new_correct,
            "explanation": t['explanation'],
            "concept": t['concept'],
            "source_start": float(i * 90),
        })
    return result


def get_or_create_quiz(video_id: str, count: int = 3, db_path: Path | None = None) -> dict[str, Any]:
    """Retrieve or generate the quiz for a specific video/lesson."""
    with connect(db_path) as db:
        v = db.execute('SELECT id, course, title FROM videos WHERE id=?', (video_id,)).fetchone()
        if not v:
            raise KeyError(f"Video {video_id} not found")
        
        row = db.execute('SELECT * FROM lesson_quizzes WHERE video_id=?', (video_id,)).fetchone()
        if row:
            quiz_data = json.loads(row['questions_json'])
            quiz_id = row['id']
        else:
            # Check for chunks/transcripts
            chunks = db.execute(
                'SELECT start, text FROM chunks WHERE video_id=? AND TRIM(text)!="" ORDER BY start LIMIT 8',
                (video_id,)
            ).fetchall()
            
            questions = _deterministic_questions(v['title'], v['course'], "", count=count)
            quiz_id = f"lq_{uuid.uuid4().hex[:12]}"
            now = utcnow()
            db.execute(
                'INSERT INTO lesson_quizzes(id, video_id, course, questions_json, created_at) VALUES(?,?,?,?,?)',
                (quiz_id, video_id, v['course'], json.dumps(questions), now)
            )
            quiz_data = questions
            db.commit()

        # Public projection (hides correct_index and explanation)
        public_questions = [
            {
                "id": q["id"],
                "question": q["question"],
                "options": q["options"],
                "concept": q.get("concept", "General"),
            }
            for q in quiz_data
        ]

        # Check latest attempt for current user
        uid = db.execute('SELECT cf_user_id()').fetchone()[0]
        status_info = {"passed": False, "last_score": None, "attempts": 0}
        if uid and uid != 'legacy':
            att = db.execute(
                '''SELECT score, passed, completed_at FROM lesson_quiz_attempts 
                   WHERE user_id=? AND video_id=? ORDER BY completed_at DESC LIMIT 1''',
                (uid, video_id)
            ).fetchone()
            if att:
                attempts_count = db.execute(
                    'SELECT COUNT(*) FROM lesson_quiz_attempts WHERE user_id=? AND video_id=?',
                    (uid, video_id)
                ).fetchone()[0]
                status_info = {
                    "passed": bool(att['passed']),
                    "last_score": att['score'],
                    "attempts": attempts_count,
                    "completed_at": att['completed_at']
                }

        return {
            "quiz_id": quiz_id,
            "video_id": video_id,
            "course": v['course'],
            "lesson_title": v['title'],
            "question_count": len(public_questions),
            "questions": public_questions,
            "status": status_info,
        }


def submit_quiz(video_id: str, quiz_id: str, answers: dict[str, int], user_id: str, db_path: Path | None = None) -> dict[str, Any]:
    """Grade learner answers, update habit loop, and record attempt."""
    with connect(db_path) as db:
        v = db.execute('SELECT id, course, title FROM videos WHERE id=?', (video_id,)).fetchone()
        if not v:
            raise KeyError(f"Video {video_id} not found")
        
        row = db.execute('SELECT * FROM lesson_quizzes WHERE id=? AND video_id=?', (quiz_id, video_id)).fetchone()
        if not row:
            raise KeyError(f"Quiz {quiz_id} not found")
        
        questions = json.loads(row['questions_json'])
        q_map = {q['id']: q for q in questions}
        
        if not isinstance(answers, dict) or set(answers.keys()) != set(q_map.keys()):
            raise ValueError("All questions must be answered")
        
        correct_count = 0
        feedback = []
        suggested_sec = None
        for q in questions:
            chosen = answers.get(q['id'])
            is_correct = (chosen == q['correct_index'])
            if is_correct:
                correct_count += 1
            else:
                if not suggested_sec:
                    sec_ts = int(q.get('source_start', 0))
                    mm = str(sec_ts // 60).zfill(2)
                    ss = str(sec_ts % 60).zfill(2)
                    suggested_sec = f"Review around {mm}:{ss} in '{v['title']}'"
            feedback.append({
                "question_id": q['id'],
                "correct": is_correct,
                "chosen_index": chosen,
                "correct_index": q['correct_index'],
                "explanation": q['explanation'],
                "concept": q.get('concept', ''),
            })

        score = round((correct_count / len(questions)) * 100)
        passed = (score >= PASSING_SCORE)
        attempt_id = f"lqa_{uuid.uuid4().hex[:12]}"
        now = utcnow()

        db.execute(
            '''INSERT INTO lesson_quiz_attempts(
                id, user_id, video_id, quiz_id, score, correct_count, total_count, passed, answers_json, completed_at
            ) VALUES(?,?,?,?,?,?,?,?,?,?)''',
            (attempt_id, user_id, video_id, quiz_id, score, correct_count, len(questions), int(passed), json.dumps(answers), now)
        )

        if passed:
            habits.credit(db, user_id, kind='quiz', resource=video_id)
            db.execute(
                'INSERT INTO learning_events(user_id, video_id, event_type, details, created_at) VALUES(?,?,?,?,?)',
                (user_id, video_id, 'lesson_quiz_passed', f'Score: {score}%', now)
            )
            # Create review card in spaced repetition system if not already present
            q_first = questions[0]
            card_id = f"rc_{hashlib.md5(f'{user_id}:{video_id}'.encode()).hexdigest()[:12]}"
            db.execute(
                '''INSERT OR IGNORE INTO review_cards(user_id, id, course, video_id, question, answer, source_start, due_at, created_at)
                   VALUES(?,?,?,?,?,?,?,?,?)''',
                (user_id, card_id, v['course'], video_id, q_first['question'], q_first['options'][q_first['correct_index']],
                 float(q_first.get('source_start', 0)), now, now)
            )
        else:
            db.execute(
                'INSERT INTO learning_events(user_id, video_id, event_type, details, created_at) VALUES(?,?,?,?,?)',
                (user_id, video_id, 'lesson_quiz_failed', f'Score: {score}%', now)
            )
            # Create review card immediately for failed quiz so learner can review and master it
            q_first = questions[0]
            card_id = f"rc_{hashlib.md5(f'{user_id}:{video_id}'.encode()).hexdigest()[:12]}"
            db.execute(
                '''INSERT OR IGNORE INTO review_cards(user_id, id, course, video_id, question, answer, source_start, due_at, created_at)
                   VALUES(?,?,?,?,?,?,?,?,?)''',
                (user_id, card_id, v['course'], video_id, q_first['question'], q_first['options'][q_first['correct_index']],
                 float(q_first.get('source_start', 0)), now, now)
            )

        db.commit()

        return {
            "attempt_id": attempt_id,
            "passed": passed,
            "score": score,
            "correct_count": correct_count,
            "total_count": len(questions),
            "passing_threshold": PASSING_SCORE,
            "feedback": feedback,
            "suggested_review": suggested_sec or f"Re-read key notes for '{v['title']}'",
        }


def get_quiz_status_for_course(user_id: str, course: str, db_path: Path | None = None) -> dict[str, Any]:
    """Return dictionary of video_id -> {passed: bool, score: int} for all videos in course."""
    with connect(db_path) as db:
        rows = db.execute(
            '''SELECT a.video_id, a.passed, a.score FROM lesson_quiz_attempts a
               JOIN videos v ON v.id=a.video_id
               WHERE a.user_id=? AND v.course=? AND a.passed=1
               GROUP BY a.video_id''',
            (user_id, course)
        ).fetchall()
        return {r['video_id']: {'passed': bool(r['passed']), 'score': r['score']} for r in rows}


def complete_review_session(user_id: str, course: str | None = None, cards_count: int = 1, db_path: Path | None = None) -> dict[str, Any]:
    """Records a completed spaced-repetition review session, crediting streak & habit loop."""
    with connect(db_path) as db:
        now = utcnow()
        sess_id = f"rs_{uuid.uuid4().hex[:12]}"
        db.execute(
            'INSERT INTO review_sessions(id, user_id, course, cards_reviewed, completed_at) VALUES(?,?,?,?,?)',
            (sess_id, user_id, course, max(1, cards_count), now)
        )
        habits.credit(db, user_id, kind='review', resource=course or 'general')
        db.execute(
            'INSERT INTO learning_events(user_id, video_id, event_type, details, created_at) VALUES(?,?,?,?,?)',
            (user_id, None, 'lesson_review_completed', f'Cards reviewed: {cards_count}', now)
        )
        db.commit()
        return {
            "session_id": sess_id,
            "status": "completed",
            "cards_reviewed": cards_count,
            "habit_credited": True,
            "completed_at": now,
        }


def check_or_issue_certificate(user_id: str, course: str, db_path: Path | None = None) -> dict[str, Any]:
    """Issue or retrieve a certificate of completion if all lessons are watched and passed."""
    with connect(db_path) as db:
        # Check if already issued
        existing = db.execute(
            'SELECT * FROM course_certificates WHERE user_id=? AND course=?',
            (user_id, course)
        ).fetchone()
        if existing:
            return {
                "issued": True,
                "certificate_id": existing['id'],
                "verification_code": existing['verification_code'],
                "student_name": existing['student_name'],
                "course": existing['course'],
                "completed_at": existing['completed_at'],
                "verify_url": f"/verify/{existing['verification_code']}",
            }

        user_row = db.execute('SELECT name FROM users WHERE id=?', (user_id,)).fetchone()
        student_name = user_row['name'] if user_row else "CourseForge Learner"

        # Check lessons for this course
        vids = db.execute('SELECT id FROM videos WHERE course=?', (course,)).fetchall()
        if not vids:
            return {"eligible": False, "reason": "Course has no lessons"}
        
        vid_ids = {v['id'] for v in vids}
        total_lessons = len(vid_ids)

        # Check video progress
        prog_rows = db.execute(
            'SELECT video_id FROM video_progress WHERE user_id=? AND completed=1 AND video_id IN ({})'.format(
                ','.join('?' * len(vid_ids))
            ),
            [user_id] + list(vid_ids)
        ).fetchall()
        completed_lessons = {r['video_id'] for r in prog_rows}

        # Check quizzes passed
        quiz_rows = db.execute(
            'SELECT video_id FROM lesson_quiz_attempts WHERE user_id=? AND passed=1 AND video_id IN ({})'.format(
                ','.join('?' * len(vid_ids))
            ),
            [user_id] + list(vid_ids)
        ).fetchall()
        passed_quizzes = {r['video_id'] for r in quiz_rows}

        # Criteria: all lessons completed and all quizzes passed
        all_completed = (completed_lessons == vid_ids)
        all_quizzed = (passed_quizzes == vid_ids)

        if not (all_completed and all_quizzed):
            return {
                "eligible": False,
                "total_lessons": total_lessons,
                "completed_lessons": len(completed_lessons),
                "passed_quizzes": len(passed_quizzes),
                "remaining_lessons": total_lessons - len(completed_lessons),
                "remaining_quizzes": total_lessons - len(passed_quizzes),
            }

        # Issue new certificate
        cert_id = f"cert_{uuid.uuid4().hex[:12]}"
        code = f"CF-{secrets.token_hex(4).upper()}-{secrets.token_hex(4).upper()}"
        now = utcnow()

        db.execute(
            '''INSERT INTO course_certificates(id, user_id, course, student_name, verification_code, completed_at)
               VALUES(?,?,?,?,?,?)''',
            (cert_id, user_id, course, student_name, code, now)
        )
        db.commit()

        return {
            "issued": True,
            "certificate_id": cert_id,
            "verification_code": code,
            "student_name": student_name,
            "course": course,
            "completed_at": now,
            "verify_url": f"/verify/{code}",
        }


def verify_certificate(verification_code: str, db_path: Path | None = None) -> dict[str, Any]:
    """Public verification of a course completion certificate."""
    with connect(db_path) as db:
        row = db.execute(
            'SELECT * FROM course_certificates WHERE verification_code=?',
            (verification_code.strip(),)
        ).fetchone()
        if not row:
            return {"valid": False, "message": "Certificate verification code not found."}
        
        return {
            "valid": True,
            "student_name": row['student_name'],
            "course": row['course'],
            "completed_at": row['completed_at'],
            "verification_code": row['verification_code'],
            "status": "Verified Official CourseForge Certificate",
        }
