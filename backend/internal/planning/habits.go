package planning

import (
	"context"
	"courseforge/backend/internal/httpx"
	"courseforge/backend/internal/identity"
	"errors"
	"github.com/jackc/pgx/v5"
	"net/http"
	"time"
)

type HabitPreferences struct {
	Goal          string `json:"goal"`
	Timezone      string `json:"timezone"`
	ReminderEmail bool   `json:"reminder_email"`
	Initialized   bool   `json:"initialized"`
}
type HabitDay struct {
	WatchedSeconds float64 `json:"watched_seconds"`
	Lessons        int64   `json:"lessons"`
	Quizzes        int64   `json:"quizzes"`
	Reviews        int64   `json:"reviews"`
	GoalMet        bool    `json:"goal_met"`
}
type HabitWeek struct {
	WatchedSeconds float64 `json:"watched_seconds"`
	Lessons        int64   `json:"lessons"`
	Quizzes        int64   `json:"quizzes"`
	Reviews        int64   `json:"reviews"`
	ActiveDays     int64   `json:"active_days"`
}

func (s *Service) habitSummary(ctx context.Context, tx pgx.Tx, user string, at time.Time) (any, error) {
	zoneName, loc, err := zone(ctx, tx, user, false)
	if err != nil {
		return nil, err
	}
	pref := HabitPreferences{Goal: "minutes", Timezone: zoneName}
	err = tx.QueryRow(ctx, `SELECT goal,reminder_email FROM habit_preferences WHERE user_id=$1`, user).Scan(&pref.Goal, &pref.ReminderEmail)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	pref.Initialized = err == nil
	var anchored bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM learning_preferences WHERE user_id=$1)`, user).Scan(&anchored); err != nil {
		return nil, err
	}
	today := at.In(loc).Format("2006-01-02")
	var day HabitDay
	err = tx.QueryRow(ctx, `SELECT watched_seconds,lessons,quizzes,reviews,goal_met FROM habit_days WHERE user_id=$1 AND day=$2`, user, today).Scan(&day.WatchedSeconds, &day.Lessons, &day.Quizzes, &day.Reviews, &day.GoalMet)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	var week HabitWeek
	err = tx.QueryRow(ctx, `SELECT COALESCE(sum(watched_seconds),0),COALESCE(sum(lessons),0),COALESCE(sum(quizzes),0),COALESCE(sum(reviews),0),count(*)FROM habit_days WHERE user_id=$1 AND day BETWEEN $2::date-6 AND $2::date`, user, today).Scan(&week.WatchedSeconds, &week.Lessons, &week.Quizzes, &week.Reviews, &week.ActiveDays)
	if err != nil {
		return nil, err
	}
	var streak, best int64
	err = tx.QueryRow(ctx, `WITH achieved AS(SELECT day,day-row_number()OVER(ORDER BY day)::integer AS band FROM habit_days WHERE user_id=$1 AND goal_met AND day<=$2::date),runs AS(SELECT min(day)first_day,max(day)last_day,count(*)length FROM achieved GROUP BY band)SELECT COALESCE(max(length)FILTER(WHERE last_day IN($2::date,$2::date-1)),0),COALESCE(max(length),0)FROM runs`, user, today).Scan(&streak, &best)
	if err != nil {
		return nil, err
	}
	return map[string]any{"day": today, "today": day, "week": week, "streak": streak, "best_streak": best, "preferences": pref, "timezone_anchored": anchored, "email_available": s.EmailAvailable, "reminder_delivery_available": false}, nil
}
func (s *Service) habits(w http.ResponseWriter, r *http.Request) {
	tx, err := s.Pool.Begin(r.Context())
	if err != nil {
		failure(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	at, err := s.now(r.Context(), tx)
	if err != nil {
		failure(w, err)
		return
	}
	v, err := s.habitSummary(r.Context(), tx, principal(r).UserID, at)
	if err != nil {
		failure(w, err)
		return
	}
	httpx.JSON(w, 200, v)
}
func (s *Service) habitPreferencesPut(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Goal          string `json:"goal"`
		Timezone      string `json:"timezone"`
		ReminderEmail bool   `json:"reminder_email"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.Goal == "" {
		in.Goal = "minutes"
	}
	if in.Timezone == "" {
		in.Timezone = "UTC"
	}
	if in.Goal != "minutes" && in.Goal != "lesson" || len(in.Timezone) > 100 || in.Timezone == "Local" {
		failure(w, ErrInvalid)
		return
	}
	if _, err := time.LoadLocation(in.Timezone); err != nil {
		failure(w, ErrInvalid)
		return
	}
	s.mutate(w, r, 200, "habit-preferences", in, nil, func(ctx context.Context, tx pgx.Tx, p identity.Principal, at time.Time) (any, error) {
		if _, err := tx.Exec(ctx, `INSERT INTO learning_preferences(user_id,timezone)VALUES($1,$2)ON CONFLICT DO NOTHING`, p.UserID, in.Timezone); err != nil {
			return nil, err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO habit_preferences(user_id,goal,reminder_email,updated_at)VALUES($1,$2,$3,$4)ON CONFLICT(user_id)DO UPDATE SET goal=excluded.goal,reminder_email=excluded.reminder_email,updated_at=excluded.updated_at`, p.UserID, in.Goal, in.ReminderEmail, at); err != nil {
			return nil, err
		}
		_, loc, err := zone(ctx, tx, p.UserID, false)
		if err != nil {
			return nil, err
		}
		if _, err = tx.Exec(ctx, `SELECT planning_habit_check($1,$2::date)`, p.UserID, at.In(loc).Format("2006-01-02")); err != nil {
			return nil, err
		}
		return s.habitSummary(ctx, tx, p.UserID, at)
	})
}
