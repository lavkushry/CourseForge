"""Seven-day study calendar; source-backed suggestions, never invented study activity.

Forecasts are snapshots of card due dates at generation time. A review card is
allocated to the first selected study day on/after its due local calendar date.
"""
from __future__ import annotations

import json
import math
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from .db import connect, utcnow
from . import planner

DEFAULT_MINUTES = [45, 45, 45, 45, 45, 0, 0]


def ensure_schema(path: Path | None = None) -> None:
    with connect(path) as db:
        db.executescript('''
        CREATE TABLE IF NOT EXISTS weekly_preferences (
          singleton INTEGER PRIMARY KEY CHECK(singleton = 1), minutes_json TEXT NOT NULL,
          updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS weekly_plans (
          week_start TEXT PRIMARY KEY, tz_offset_minutes INTEGER NOT NULL,
          minutes_json TEXT NOT NULL, forecast_json TEXT NOT NULL,
          path_id TEXT, unscheduled_reviews INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        ''')
        db.execute('INSERT OR IGNORE INTO weekly_preferences(singleton, minutes_json, updated_at) VALUES(1,?,?)',
                   (json.dumps(DEFAULT_MINUTES), utcnow()))
        week_fields = {r['name'] for r in db.execute('PRAGMA table_info(weekly_plans)')}
        if 'unscheduled_reviews' not in week_fields:
            db.execute('ALTER TABLE weekly_plans ADD COLUMN unscheduled_reviews INTEGER NOT NULL DEFAULT 0')
        fields = {r['name'] for r in db.execute('PRAGMA table_info(daily_plan_items)')}
        if 'actual_minutes' not in fields:
            db.execute('ALTER TABLE daily_plan_items ADD COLUMN actual_minutes INTEGER NOT NULL DEFAULT 0 CHECK(actual_minutes BETWEEN 0 AND 600)')


def validate_minutes(minutes: list[int]) -> list[int]:
    if not isinstance(minutes, list) or len(minutes) != 7 or any(
        type(m) is not int or (m != 0 and not 15 <= m <= 180) for m in minutes
    ) or not any(minutes):
        raise planner.PlannerInputError('Set seven weekday budgets (Mon–Sun): 0 for rest or 15–180 minutes; select at least one study day')
    return minutes


def preferences(db_path: Path | None = None) -> dict:
    with connect(db_path) as db:
        row = db.execute('SELECT minutes_json FROM weekly_preferences WHERE weekly_preferences.user_id=cf_user_id() AND singleton=1').fetchone()
    return {'weekday_minutes': json.loads(row['minutes_json']) if row else list(DEFAULT_MINUTES)}


def save_preferences(minutes: list[int], db_path: Path | None = None) -> dict:
    validate_minutes(minutes)
    with connect(db_path) as db:
        db.execute('''INSERT INTO weekly_preferences(user_id,singleton,minutes_json,updated_at)
                      VALUES(cf_user_id(),1,?,?) ON CONFLICT(user_id,singleton) DO UPDATE SET
                      minutes_json=excluded.minutes_json,updated_at=excluded.updated_at''',
                   (json.dumps(minutes), utcnow()))
    return preferences(db_path)


def _monday(value: str) -> date:
    day = planner._study_date(value)
    if day.weekday() != 0:
        raise planner.PlannerInputError('week_start must be a Monday (YYYY-MM-DD)')
    return day


def _forecast(start: date, offset: int, budgets: list[int], db_path: Path | None) -> tuple[list[dict], int]:
    active = [i for i, n in enumerate(budgets) if n]
    forecasts = [{'count': 0, 'overdue': 0, 'ids': []} for _ in range(7)]
    unscheduled = 0
    with connect(db_path) as db:
        cards = db.execute('SELECT id,due_at FROM review_cards  WHERE review_cards.user_id=cf_user_id() ORDER BY due_at,id').fetchall()
    for card in cards:
        try:
            due = datetime.fromisoformat(card['due_at'])
            if due.tzinfo is None:
                due = due.replace(tzinfo=timezone.utc)
            # JS timezone offset = UTC minus local.
            local_day = (due.astimezone(timezone.utc) - timedelta(minutes=offset)).date()
        except (ValueError, TypeError, OverflowError):
            continue
        weekday = (local_day - start).days
        if weekday > 6:
            continue
        index = next((i for i in active if i >= max(0, weekday)), None)
        if index is None:
            unscheduled += 1
            continue
        forecasts[index]['count'] += 1
        forecasts[index]['ids'].append(card['id'])
        forecasts[index]['overdue'] += int(local_day < start + timedelta(days=index))
    return forecasts, unscheduled


def build(week_start: str, tz_offset_minutes: int, *, refresh: bool = False,
          db_path: Path | None = None) -> dict:
    start = _monday(week_start)
    if type(tz_offset_minutes) is not int or not -840 <= tz_offset_minutes <= 840:
        raise planner.PlannerInputError('Timezone offset must be between -840 and 840 minutes')
    if not refresh:
        existing = get_week(week_start, db_path)
        if existing:
            return existing
    budgets = preferences(db_path)['weekday_minutes']
    pref = planner.preferences(db_path)
    path_id = pref['path_id']
    forecasts, unscheduled = _forecast(start, tz_offset_minutes, budgets, db_path)
    reserved: set[str] = set()
    for i, budget in enumerate(budgets):
        if not budget:
            continue
        day = start + timedelta(days=i)
        day_key = day.isoformat()
        existing = planner.get_day(day_key, db_path)
        if existing and not refresh:
            reserved.update(x['item_key'] for x in existing['items'])
            continue
        candidate, _warnings = planner._candidates(day, tz_offset_minutes, path_id, db_path)
        candidate = [x for x in candidate if x['kind'] != 'review' and x['item_key'] not in reserved]
        forecast = forecasts[i]
        if forecast['count']:
            review = planner._item(f'review:week:{day_key}', 'review',
                                   f'Review {forecast["count"]} scheduled flashcards',
                                   'Forecast from current card due dates; may change after grading.',
                                   min(16, max(5, math.ceil(forecast['count'] / 4) * 3)),
                                   {'view': 'reviews', 'due_card_ids': forecast['ids'][:100]})
            candidate.insert(0, review)
        result = planner.generate(day_key, tz_offset_minutes, refresh=True, db_path=db_path,
                                  budget_override=budget, candidate_override=candidate, retain_recorded=True)
        reserved.update(x['item_key'] for x in result['items'])
    now = utcnow()
    with connect(db_path) as db:
        db.execute('''INSERT INTO weekly_plans
                      (user_id,week_start,tz_offset_minutes,minutes_json,forecast_json,path_id,unscheduled_reviews,created_at,updated_at)
                      VALUES(cf_user_id(),?,?,?,?,?,?,?,?) ON CONFLICT(user_id,week_start) DO UPDATE SET
                      tz_offset_minutes=excluded.tz_offset_minutes,
                      minutes_json=excluded.minutes_json,forecast_json=excluded.forecast_json,
                      path_id=excluded.path_id,unscheduled_reviews=excluded.unscheduled_reviews,updated_at=excluded.updated_at''',
                   (week_start,tz_offset_minutes,json.dumps(budgets), json.dumps(forecasts),path_id,unscheduled,now,now))
    return get_week(week_start, db_path)


def get_week(week_start: str, db_path: Path | None = None) -> dict | None:
    start = _monday(week_start)
    with connect(db_path) as db:
        row = db.execute('SELECT * FROM weekly_plans WHERE weekly_plans.user_id=cf_user_id() AND week_start=?', (week_start,)).fetchone()
    if row is None:
        return None
    budgets = json.loads(row['minutes_json'])
    forecasts = json.loads(row['forecast_json'])
    days: list[dict] = []
    warnings: list[str] = []
    for i in range(7):
        day_key = (start + timedelta(days=i)).isoformat()
        # Historical self-reported work remains visible even if a day is now marked as rest.
        saved = planner.get_day(day_key, db_path)
        if saved:
            warnings.extend(saved['warnings'])
        days.append({
            'date': day_key, 'weekday': i, 'budget_minutes': budgets[i],
            'rest_day': budgets[i] == 0, 'planned_minutes': saved['planned_minutes'] if saved else 0,
            'actual_minutes': saved['actual_minutes'] if saved else 0,
            'reported_done_minutes': saved['reported_done_minutes'] if saved else 0,
            'completed_count': saved['completed_count'] if saved else 0,
            'task_count': len(saved['items']) if saved else 0,
            'forecast_reviews': forecasts[i]['count'], 'forecast_overdue': forecasts[i]['overdue']
        })
    return {
        'week_start': week_start, 'days': days, 'path_id': row['path_id'],
        'budget_minutes': sum(budgets), 'planned_minutes': sum(x['planned_minutes'] for x in days),
        'actual_minutes': sum(x['actual_minutes'] for x in days),
        'reported_done_minutes': sum(x['reported_done_minutes'] for x in days),
        'forecast_reviews': sum(x['forecast_reviews'] for x in days),
        'warnings': list(dict.fromkeys(warnings + ([
            f'{row["unscheduled_reviews"]} card(s) fall due after the last available study day; not scheduled early.'
        ] if row['unscheduled_reviews'] else []))),
        'disclaimer': 'Forecasts are snapshots, and recorded actual minutes are learner-reported, not tracked video playback.'
    }
