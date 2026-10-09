"""Read-only analytics and course metadata for the local learner dashboard.

Only persisted learner activity is reported. No inferred certifications, ratings or AI mastery.
"""
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path
from .db import connect


def insights(path: Path | None = None, *, now: datetime | None = None) -> dict:
    instant = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    end = instant.date()
    start = end - timedelta(days=6)
    with connect(path) as db:
        rows = db.execute('''SELECT a.quality,a.reviewed_at,c.course,c.question
                             FROM review_attempts a JOIN review_cards c ON c.id=a.card_id
                             ORDER BY a.reviewed_at DESC LIMIT 500''').fetchall()
        completed = db.execute('''SELECT updated_at FROM video_progress WHERE completed=1''').fetchall()
        due = db.execute('SELECT COUNT(*) FROM review_cards WHERE due_at<=?',
                         (instant.isoformat(timespec='seconds'),)).fetchone()[0]
        total_cards = db.execute('SELECT COUNT(*) FROM review_cards').fetchone()[0]
    daily = Counter()
    attempts = []
    for r in rows:
        try:
            day = datetime.fromisoformat(r['reviewed_at']).date()
        except (ValueError, TypeError):
            continue
        if start <= day <= end:
            daily[day.isoformat()] += 1
        attempts.append({'quality': r['quality'], 'course': r['course'],
                         'question': r['question'], 'date': day.isoformat()})
    recent = attempts[:12]
    weak = [r for r in attempts if r['quality'] < 3][:5]
    mastered = sum(1 for r in attempts if r['quality'] >= 4)
    # Activity is based on actual review attempts or completed lessons.
    active_days = set(daily)
    for r in completed:
        try:
            day = datetime.fromisoformat(r['updated_at']).date()
        except (ValueError, TypeError):
            continue
        if day <= end:
            active_days.add(day.isoformat())
    cursor = end
    # Streak can start yesterday if no activity yet today.
    if end.isoformat() not in active_days:
        cursor -= timedelta(days=1)
    streak = 0
    while cursor.isoformat() in active_days:
        streak += 1
        cursor -= timedelta(days=1)
    return {
        'due_count': due, 'total_cards': total_cards,
        'reviews_today': daily.get(end.isoformat(), 0),
        'streak_days': streak,
        'mastery_signal_percent': round(100 * mastered / len(attempts)) if attempts else None,
        'mastery_basis': 'Share of all self-rated recall attempts scored Good or Easy',
        'weekly_reviews': [{'date': (start + timedelta(days=i)).isoformat(),
                            'count': daily.get((start + timedelta(days=i)).isoformat(), 0)}
                           for i in range(7)],
        'weak_areas': weak,
        'history': recent,
    }
