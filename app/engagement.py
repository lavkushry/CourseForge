"""Administrator aggregates with explicit denominators and UTC periods."""
from datetime import timedelta
from .db import connect
from .habits import now


def report():
    today=now().date();start=today-timedelta(days=6);cohort=today-timedelta(days=7)
    with connect() as db:
        rows=db.execute('''SELECT DISTINCT e.user_id,date(e.created_at) day FROM learning_events e
            JOIN users u ON u.id=e.user_id WHERE u.role='student' AND u.suspended=0
            AND u.verified=1 AND date(e.created_at)>=? AND e.event_type IN
            ('native_player_opened','completion_reported','lesson_completed','note_saved',
             'assessment_submitted','recall_reviewed','lesson_quiz_passed','lesson_review_completed')''', (cohort.isoformat(),)).fetchall()
        days={}
        for r in rows:days.setdefault(r['day'],set()).add(r['user_id'])
        base=days.get(cohort.isoformat(),set())
        returned=set().union(*(days.get((cohort+timedelta(days=n)).isoformat(),set()) for n in range(1,8))) & base
        sessions=db.execute('''SELECT COUNT(*),AVG(n.playing_seconds)/60 FROM native_sessions n
            JOIN users u ON u.id=n.user_id WHERE u.role='student' AND u.suspended=0
            AND n.playing_seconds>0 AND date(n.created_at)>=?''', (start.isoformat(),)).fetchone()
    return {'daily_active_students':len(days.get(today.isoformat(),set())),
            'average_session_minutes':round(sessions[1] or 0,1),'sessions':sessions[0],
            'seven_day_return_rate':round(len(returned)/len(base)*100,1) if base else None,
            'return_cohort':len(base),'returning_students':len(returned),
            'period':'UTC; session average is the last 7 days; return cohort is students active 7 days ago'}
