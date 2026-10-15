package planning

import (
	"context"
	"errors"
	"net/http"
	"time"

	"courseforge/backend/internal/httpx"
	"courseforge/backend/internal/identity"

	"github.com/jackc/pgx/v5"
)

type Preferences struct {
	DailyMinutes int     `json:"daily_minutes"`
	PathID       *string `json:"path_id"`
	Revision     int64   `json:"revision"`
}
type WeekPreferences struct {
	WeekdayMinutes []int `json:"weekday_minutes"`
	Revision       int64 `json:"revision"`
}

var defaultWeek = []int{45, 45, 45, 45, 45, 0, 0}

func preferences(ctx context.Context, tx pgx.Tx, user string) (Preferences, error) {
	v := Preferences{DailyMinutes: 45}
	err := tx.QueryRow(ctx, `SELECT daily_minutes,path_id,revision FROM planner_preferences WHERE user_id=$1`, user).Scan(&v.DailyMinutes, &v.PathID, &v.Revision)
	if errors.Is(err, pgx.ErrNoRows) {
		err = nil
	}
	return v, err
}
func weekPreferences(ctx context.Context, tx pgx.Tx, user string) (WeekPreferences, error) {
	v := WeekPreferences{WeekdayMinutes: append([]int{}, defaultWeek...)}
	err := tx.QueryRow(ctx, `SELECT weekday_minutes,revision FROM week_preferences WHERE user_id=$1`, user).Scan(&v.WeekdayMinutes, &v.Revision)
	if errors.Is(err, pgx.ErrNoRows) {
		err = nil
	}
	return v, err
}
func validWeek(v []int) bool {
	if len(v) != 7 {
		return false
	}
	total := 0
	for _, n := range v {
		if n != 0 && (n < 15 || n > 180) {
			return false
		}
		total += n
	}
	return total > 0
}
func (s *Service) preferences(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := principal(r)
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		failure(w, err)
		return
	}
	defer tx.Rollback(ctx)
	v, err := preferences(ctx, tx, p.UserID)
	if err == nil && v.PathID != nil {
		_, err = s.pathAccess(ctx, tx, p, v.PathID)
	}
	if err != nil {
		failure(w, err)
		return
	}
	httpx.JSON(w, 200, v)
}
func (s *Service) preferencesPut(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Preferences
		ExpectedRevision *int64 `json:"expected_revision"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.Revision != 0 || in.DailyMinutes < 15 || in.DailyMinutes > 180 || in.ExpectedRevision == nil || *in.ExpectedRevision < 0 {
		failure(w, ErrInvalid)
		return
	}
	check := func(ctx context.Context, tx pgx.Tx, p identity.Principal) error {
		_, err := s.pathAccess(ctx, tx, p, in.PathID)
		return err
	}
	s.mutate(w, r, 200, "planner-preferences", in, check, func(ctx context.Context, tx pgx.Tx, p identity.Principal, at time.Time) (any, error) {
		old, err := preferences(ctx, tx, p.UserID)
		if err != nil {
			return nil, err
		}
		if old.Revision != *in.ExpectedRevision {
			return nil, ErrConflict
		}
		course, err := s.pathAccess(ctx, tx, p, in.PathID)
		if err != nil {
			return nil, err
		}
		v := Preferences{DailyMinutes: in.DailyMinutes, PathID: in.PathID, Revision: old.Revision + 1}
		_, err = tx.Exec(ctx, `INSERT INTO planner_preferences(user_id,daily_minutes,path_id,path_course_id,revision,updated_at)VALUES($1,$2,$3,$4,$5,$6)ON CONFLICT(user_id)DO UPDATE SET daily_minutes=excluded.daily_minutes,path_id=excluded.path_id,path_course_id=excluded.path_course_id,revision=excluded.revision,updated_at=excluded.updated_at`, p.UserID, v.DailyMinutes, v.PathID, course, v.Revision, at)
		return v, err
	})
}
func (s *Service) weekPreferences(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		failure(w, err)
		return
	}
	defer tx.Rollback(ctx)
	v, err := weekPreferences(ctx, tx, principal(r).UserID)
	if err != nil {
		failure(w, err)
		return
	}
	httpx.JSON(w, 200, v)
}
func (s *Service) weekPreferencesPut(w http.ResponseWriter, r *http.Request) {
	var in struct {
		WeekdayMinutes   []int  `json:"weekday_minutes"`
		ExpectedRevision *int64 `json:"expected_revision"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if !validWeek(in.WeekdayMinutes) || in.ExpectedRevision == nil || *in.ExpectedRevision < 0 {
		failure(w, ErrInvalid)
		return
	}
	s.mutate(w, r, 200, "week-preferences", in, nil, func(ctx context.Context, tx pgx.Tx, p identity.Principal, at time.Time) (any, error) {
		old, err := weekPreferences(ctx, tx, p.UserID)
		if err != nil {
			return nil, err
		}
		if old.Revision != *in.ExpectedRevision {
			return nil, ErrConflict
		}
		v := WeekPreferences{WeekdayMinutes: in.WeekdayMinutes, Revision: old.Revision + 1}
		_, err = tx.Exec(ctx, `INSERT INTO week_preferences(user_id,weekday_minutes,revision,updated_at)VALUES($1,$2,$3,$4)ON CONFLICT(user_id)DO UPDATE SET weekday_minutes=excluded.weekday_minutes,revision=excluded.revision,updated_at=excluded.updated_at`, p.UserID, v.WeekdayMinutes, v.Revision, at)
		return v, err
	})
}
