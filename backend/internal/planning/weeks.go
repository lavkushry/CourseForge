package planning

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"courseforge/backend/internal/httpx"
	"courseforge/backend/internal/identity"

	"github.com/jackc/pgx/v5"
)

type Forecast struct {
	Count   int64    `json:"count"`
	Overdue int64    `json:"overdue"`
	IDs     []string `json:"ids"`
}
type WeekDay struct {
	Date                string `json:"date"`
	Weekday             int    `json:"weekday"`
	BudgetMinutes       int    `json:"budget_minutes"`
	RestDay             bool   `json:"rest_day"`
	PlannedMinutes      int    `json:"planned_minutes"`
	ActualMinutes       int    `json:"actual_minutes"`
	ReportedDoneMinutes int    `json:"reported_done_minutes"`
	CompletedCount      int    `json:"completed_count"`
	TaskCount           int    `json:"task_count"`
	ForecastReviews     int64  `json:"forecast_reviews"`
	ForecastOverdue     int64  `json:"forecast_overdue"`
}
type Week struct {
	ID                  string    `json:"id"`
	WeekStart           string    `json:"week_start"`
	Timezone            string    `json:"timezone"`
	PathID              *string   `json:"path_id"`
	Revision            int64     `json:"revision"`
	CreatedAt           time.Time `json:"created_at"`
	UpdatedAt           time.Time `json:"updated_at"`
	Days                []WeekDay `json:"days"`
	BudgetMinutes       int       `json:"budget_minutes"`
	PlannedMinutes      int       `json:"planned_minutes"`
	ActualMinutes       int       `json:"actual_minutes"`
	ReportedDoneMinutes int       `json:"reported_done_minutes"`
	ForecastReviews     int64     `json:"forecast_reviews"`
	UnscheduledReviews  int64     `json:"unscheduled_reviews"`
	Warnings            []string  `json:"warnings"`
	Disclaimer          string    `json:"disclaimer"`
}

func (s *Service) forecast(ctx context.Context, tx pgx.Tx, p identity.Principal, start time.Time, zone string, budgets []int) ([]Forecast, int64, error) {
	forecast := make([]Forecast, 7)
	for i := range forecast {
		forecast[i].IDs = []string{}
	}
	rows, err := tx.Query(ctx, `WITH scoped AS(
 SELECT rc.id,rc.due_at,(rc.due_at AT TIME ZONE $3)::date AS due_day FROM review_cards rc JOIN courses c ON c.id=rc.course_id WHERE rc.user_id=$1 AND `+visibleCourse+`),
 allocated AS(SELECT *, (SELECT min(i) FROM generate_series(0,6) i WHERE ($5::integer[])[i+1]>0 AND $4::date+i>=due_day) AS idx FROM scoped WHERE due_day<=$4::date+6),
 ranked AS(SELECT *,row_number()OVER(PARTITION BY idx ORDER BY due_at,id) AS rn FROM allocated)
 SELECT COALESCE(idx,-1),count(*),count(*)FILTER(WHERE due_day<$4::date+idx),COALESCE(jsonb_agg(id ORDER BY due_at,id)FILTER(WHERE rn<=100),'[]'::jsonb)FROM ranked GROUP BY idx ORDER BY idx`, p.UserID, p.Role, zone, start.Format("2006-01-02"), budgets)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var unscheduled int64
	for rows.Next() {
		var i int
		var count, overdue int64
		var raw []byte
		if err = rows.Scan(&i, &count, &overdue, &raw); err != nil {
			return nil, 0, err
		}
		if i < 0 {
			unscheduled = count
			continue
		}
		if i > 6 {
			return nil, 0, ErrInvalid
		}
		var ids []string
		if err = json.Unmarshal(raw, &ids); err != nil {
			return nil, 0, err
		}
		forecast[i] = Forecast{Count: count, Overdue: overdue, IDs: ids}
	}
	return forecast, unscheduled, rows.Err()
}
func (s *Service) readWeek(ctx context.Context, tx pgx.Tx, p identity.Principal, start time.Time) (Week, error) {
	v := Week{WeekStart: start.Format("2006-01-02"), Days: []WeekDay{}, Warnings: []string{}, Disclaimer: "Forecasts are snapshots; actual planner minutes are learner-reported and distinct from focus and playback time."}
	var budgets []int
	var raw []byte
	err := tx.QueryRow(ctx, `SELECT id,timezone,path_id,revision,created_at,updated_at,weekday_minutes,forecast,unscheduled_reviews FROM weekly_plans WHERE user_id=$1 AND week_start=$2`, p.UserID, v.WeekStart).Scan(&v.ID, &v.Timezone, &v.PathID, &v.Revision, &v.CreatedAt, &v.UpdatedAt, &budgets, &raw, &v.UnscheduledReviews)
	if err != nil {
		return v, err
	}
	var forecasts []Forecast
	if json.Unmarshal(raw, &forecasts) != nil || len(forecasts) != 7 || !validWeek(budgets) {
		return v, ErrInvalid
	}
	for i, budget := range budgets {
		date := start.AddDate(0, 0, i).Format("2006-01-02")
		d := WeekDay{Date: date, Weekday: i, BudgetMinutes: budget, RestDay: budget == 0, ForecastReviews: forecasts[i].Count, ForecastOverdue: forecasts[i].Overdue}
		saved, err := s.readDay(ctx, tx, p, date, true)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return v, err
		}
		if err == nil {
			d.PlannedMinutes = saved.PlannedMinutes
			d.ActualMinutes = saved.ActualMinutes
			d.ReportedDoneMinutes = saved.ReportedDoneMinutes
			d.CompletedCount = saved.CompletedCount
			d.TaskCount = len(saved.Items)
			v.Warnings = append(v.Warnings, saved.Warnings...)
		}
		v.Days = append(v.Days, d)
		v.BudgetMinutes += budget
		v.PlannedMinutes += d.PlannedMinutes
		v.ActualMinutes += d.ActualMinutes
		v.ReportedDoneMinutes += d.ReportedDoneMinutes
		v.ForecastReviews += d.ForecastReviews
	}
	if v.UnscheduledReviews > 0 {
		v.Warnings = append(v.Warnings, "Cards due after the final available study day were not scheduled early.")
	}
	return v, nil
}
func (s *Service) week(w http.ResponseWriter, r *http.Request) {
	start, err := monday(r.PathValue("date"))
	if err != nil {
		failure(w, err)
		return
	}
	tx, err := s.Pool.Begin(r.Context())
	if err != nil {
		failure(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	v, err := s.readWeek(r.Context(), tx, principal(r), start)
	if err != nil {
		failure(w, err)
		return
	}
	httpx.JSON(w, 200, v)
}
func (s *Service) generateWeek(w http.ResponseWriter, r *http.Request) {
	var in struct {
		WeekStart        string `json:"week_start"`
		Refresh          bool   `json:"refresh"`
		ExpectedRevision *int64 `json:"expected_revision"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	start, err := monday(in.WeekStart)
	if err != nil || !validRefresh(in.Refresh, in.ExpectedRevision) {
		failure(w, ErrInvalid)
		return
	}
	check := func(ctx context.Context, tx pgx.Tx, p identity.Principal) error {
		pref, err := preferences(ctx, tx, p.UserID)
		if err != nil {
			return err
		}
		_, err = s.pathAccess(ctx, tx, p, pref.PathID)
		return err
	}
	s.mutate(w, r, 201, "generate-week", in, check, func(ctx context.Context, tx pgx.Tx, p identity.Principal, at time.Time) (any, error) {
		old, err := s.readWeek(ctx, tx, p, start)
		exists := err == nil
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return nil, err
		}
		if in.ExpectedRevision != nil && old.Revision != *in.ExpectedRevision {
			return nil, ErrConflict
		}
		if exists && !in.Refresh {
			return old, nil
		}
		pref, err := preferences(ctx, tx, p.UserID)
		if err != nil {
			return nil, err
		}
		course, err := s.pathAccess(ctx, tx, p, pref.PathID)
		if err != nil {
			return nil, err
		}
		wp, err := weekPreferences(ctx, tx, p.UserID)
		if err != nil {
			return nil, err
		}
		zoneName, _, err := zone(ctx, tx, p.UserID, true)
		if err != nil {
			return nil, err
		}
		forecasts, unscheduled, err := s.forecast(ctx, tx, p, start, zoneName, wp.WeekdayMinutes)
		if err != nil {
			return nil, err
		}
		reserved := map[string]bool{}
		// Pin all recorded references before choosing any new day, including rest days.
		for i := range 7 {
			saved, err := s.readDay(ctx, tx, p, start.AddDate(0, 0, i).Format("2006-01-02"), false)
			if err != nil && !errors.Is(err, pgx.ErrNoRows) {
				return nil, err
			}
			for _, item := range saved.Items {
				if item.pinned || !in.Refresh {
					reserved[item.Key] = true
				}
			}
		}
		for i, budget := range wp.WeekdayMinutes {
			if budget == 0 {
				continue
			}
			date := start.AddDate(0, 0, i)
			saved, err := s.readDay(ctx, tx, p, date.Format("2006-01-02"), false)
			if err != nil && !errors.Is(err, pgx.ErrNoRows) {
				return nil, err
			}
			if err == nil && !in.Refresh {
				continue
			}
			items, _, err := s.candidates(ctx, tx, p, date, pref.PathID, zoneName)
			if err != nil {
				return nil, err
			}
			override := []Candidate{}
			if forecasts[i].Count > 0 {
				override = append(override, Candidate{Key: "review:week:" + date.Format("2006-01-02"), Kind: "review", Title: "Review scheduled flashcards", Description: "Forecast from source card due dates; never scheduled before due", Minutes: min(16, max(5, int((min(forecasts[i].Count, 100)+3)/4)*3)), Action: Action{View: "reviews", ReviewCardIDs: forecasts[i].IDs}})
			}
			for _, item := range items {
				if item.Kind != "review" {
					override = append(override, item)
				}
			}
			result, err := s.buildDay(ctx, tx, p, date, budget, true, &saved.Revision, override, reserved, at)
			if err != nil {
				return nil, err
			}
			for _, item := range result.Items {
				reserved[item.Key] = true
			}
		}
		weekID := old.ID
		if !exists {
			weekID, err = id("week_")
			if err != nil {
				return nil, err
			}
		}
		raw, err := json.Marshal(forecasts)
		if err != nil {
			return nil, err
		}
		if _, err = tx.Exec(ctx, `INSERT INTO weekly_plans(id,user_id,week_start,timezone,weekday_minutes,forecast,unscheduled_reviews,path_id,path_course_id,revision,created_at,updated_at)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)ON CONFLICT(user_id,week_start)DO UPDATE SET timezone=excluded.timezone,weekday_minutes=excluded.weekday_minutes,forecast=excluded.forecast,unscheduled_reviews=excluded.unscheduled_reviews,path_id=excluded.path_id,path_course_id=excluded.path_course_id,revision=excluded.revision,updated_at=excluded.updated_at`, weekID, p.UserID, in.WeekStart, zoneName, wp.WeekdayMinutes, raw, unscheduled, pref.PathID, course, old.Revision+1, at); err != nil {
			return nil, err
		}
		return s.readWeek(ctx, tx, p, start)
	})
}
