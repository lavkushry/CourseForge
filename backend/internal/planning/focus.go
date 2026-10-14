package planning

import (
	"context"
	"errors"
	"math"
	"net/http"
	"strings"
	"time"

	"courseforge/backend/internal/httpx"
	"courseforge/backend/internal/identity"

	"github.com/jackc/pgx/v5"
)

type Focus struct {
	ID               string    `json:"id"`
	Mode             string    `json:"mode"`
	Status           string    `json:"status"`
	DurationSeconds  int       `json:"duration_seconds"`
	ElapsedSeconds   float64   `json:"elapsed_seconds"`
	RemainingSeconds float64   `json:"remaining_seconds"`
	PlannerItemID    *string   `json:"planner_item_id"`
	LessonID         *string   `json:"lesson_id"`
	CourseID         *string   `json:"course_id"`
	LabSessionID     *string   `json:"lab_session_id"`
	Title            string    `json:"title"`
	Revision         int64     `json:"revision"`
	CreatedAt        time.Time `json:"created_at"`
	UpdatedAt        time.Time `json:"updated_at"`
	ServerNow        time.Time `json:"server_now"`
	started          *time.Time
	intervals        int
	linked           bool
}

const focusColumns = `id,mode,status,duration_seconds,elapsed_seconds,run_started_at,planner_item_id,lesson_id,course_id,lab_session_id,title,revision,interval_count,created_at,updated_at,source_required`

func scanFocus(row pgx.Row) (Focus, error) {
	var v Focus
	err := row.Scan(&v.ID, &v.Mode, &v.Status, &v.DurationSeconds, &v.ElapsedSeconds, &v.started, &v.PlannerItemID, &v.LessonID, &v.CourseID, &v.LabSessionID, &v.Title, &v.Revision, &v.intervals, &v.CreatedAt, &v.UpdatedAt, &v.linked)
	return v, err
}
func snapshot(v Focus, at time.Time) Focus {
	if v.Status == "running" && v.started != nil {
		v.ElapsedSeconds += max(0, at.Sub(*v.started).Seconds())
	}
	v.ElapsedSeconds = min(float64(v.DurationSeconds), v.ElapsedSeconds)
	v.RemainingSeconds = max(0, float64(v.DurationSeconds)-v.ElapsedSeconds)
	v.ElapsedSeconds = math.Round(v.ElapsedSeconds*100) / 100
	v.RemainingSeconds = math.Round(v.RemainingSeconds*100) / 100
	v.ServerNow = at
	return v
}
func (s *Service) focusAccess(ctx context.Context, tx pgx.Tx, p identity.Principal, v Focus) error {
	if v.linked && v.CourseID == nil && v.LessonID == nil && v.PlannerItemID == nil && v.LabSessionID == nil {
		return pgx.ErrNoRows
	}
	if v.CourseID != nil {
		if err := courseAccess(ctx, tx, p, *v.CourseID); err != nil {
			return err
		}
	}
	if v.LessonID != nil {
		if err := s.lessonAccess(ctx, tx, p, *v.LessonID); err != nil {
			return err
		}
	}
	if v.PlannerItemID != nil {
		return s.itemGuard(*v.PlannerItemID)(ctx, tx, p)
	}
	if v.LabSessionID != nil {
		if s.Labs == nil {
			return ErrUnavailable
		}
		_, course, err := s.Labs.ValidateSession(ctx, tx, p, *v.LabSessionID)
		if err != nil {
			return err
		}
		return courseAccess(ctx, tx, p, course)
	}
	return nil
}
func closeRun(ctx context.Context, tx pgx.Tx, user string, v *Focus, at time.Time) error {
	if v.started == nil {
		return ErrInvalid
	}
	remaining := max(0, float64(v.DurationSeconds)-v.ElapsedSeconds)
	seconds := min(remaining, max(0, at.Sub(*v.started).Seconds()))
	end := v.started.Add(time.Duration(seconds * float64(time.Second)))
	tag, err := tx.Exec(ctx, `UPDATE focus_intervals SET ended_at=$3 WHERE session_id=$1 AND user_id=$2 AND ended_at IS NULL`, v.ID, user, end)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrInvalid
	}
	v.ElapsedSeconds += seconds
	v.started = nil
	return nil
}
func (s *Service) reconcile(ctx context.Context, tx pgx.Tx, p identity.Principal, at time.Time) error {
	v, err := scanFocus(tx.QueryRow(ctx, `SELECT `+focusColumns+` FROM focus_sessions WHERE user_id=$1 AND status='running' FOR UPDATE`, p.UserID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if v.started == nil {
		return ErrInvalid
	}
	if v.ElapsedSeconds+max(0, at.Sub(*v.started).Seconds()) < float64(v.DurationSeconds) {
		return nil
	}
	if err = closeRun(ctx, tx, p.UserID, &v, at); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE focus_sessions SET status='finished',elapsed_seconds=$3,run_started_at=NULL,revision=revision+1,updated_at=greatest(updated_at,$4)WHERE id=$1 AND user_id=$2`, v.ID, p.UserID, v.ElapsedSeconds, at)
	return err
}

type startInput struct {
	Mode            string  `json:"mode"`
	DurationMinutes *int    `json:"duration_minutes"`
	PlannerItemID   *string `json:"planner_item_id"`
	LessonID        *string `json:"lesson_id"`
	LabSessionID    *string `json:"lab_session_id"`
	Title           string  `json:"title"`
}

func (s *Service) startSource(ctx context.Context, tx pgx.Tx, p identity.Principal, in startInput) (string, *string, error) {
	title := in.Title
	var course *string
	if in.PlannerItemID != nil {
		item, err := scanItem(tx.QueryRow(ctx, `SELECT `+itemColumns+` FROM daily_plan_items i WHERE i.id=$1 AND i.user_id=$2`, *in.PlannerItemID, p.UserID))
		if err != nil {
			return "", nil, err
		}
		if err = s.itemAccess(ctx, tx, p, item); err != nil {
			return "", nil, err
		}
		course = item.CourseID
		if title == "" {
			title = item.Title
		}
	}
	if in.LessonID != nil {
		if err := s.lessonAccess(ctx, tx, p, *in.LessonID); err != nil {
			return "", nil, err
		}
		var c, t string
		if err := tx.QueryRow(ctx, `SELECT course_id,title FROM lessons WHERE id=$1`, *in.LessonID).Scan(&c, &t); err != nil {
			return "", nil, err
		}
		course = &c
		if title == "" {
			title = t
		}
	}
	if in.LabSessionID != nil {
		if s.Labs == nil {
			return "", nil, ErrUnavailable
		}
		t, c, err := s.Labs.ValidateSession(ctx, tx, p, *in.LabSessionID)
		if err != nil {
			return "", nil, err
		}
		if err = courseAccess(ctx, tx, p, c); err != nil {
			return "", nil, err
		}
		course = &c
		if title == "" {
			title = t
		}
	}
	if title == "" {
		title = "Focused study"
		if in.Mode == "break" {
			title = "Rest break"
		}
	}
	if len([]rune(title)) > 160 {
		title = string([]rune(title)[:160])
	}
	return title, course, nil
}
func (s *Service) focusStart(w http.ResponseWriter, r *http.Request) {
	var in startInput
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.Mode == "" {
		in.Mode = "focus"
	}
	if in.DurationMinutes == nil {
		value := 25
		in.DurationMinutes = &value
	}
	in.Title = strings.TrimSpace(in.Title)
	refs := 0
	for _, ref := range []*string{in.PlannerItemID, in.LessonID, in.LabSessionID} {
		if ref != nil {
			refs++
			if len(*ref) < 1 || len(*ref) > 500 {
				failure(w, ErrInvalid)
				return
			}
		}
	}
	if refs > 1 || in.Mode != "focus" && in.Mode != "break" || *in.DurationMinutes < 1 || *in.DurationMinutes > 120 || !validText(in.Title, 0, 160) {
		failure(w, ErrInvalid)
		return
	}
	check := func(ctx context.Context, tx pgx.Tx, p identity.Principal) error {
		_, _, err := s.startSource(ctx, tx, p, in)
		return err
	}
	s.mutate(w, r, 201, "focus-start", in, check, func(ctx context.Context, tx pgx.Tx, p identity.Principal, at time.Time) (any, error) {
		if _, _, err := zone(ctx, tx, p.UserID, true); err != nil {
			return nil, err
		}
		if err := s.reconcile(ctx, tx, p, at); err != nil {
			return nil, err
		}
		var active, running int
		if err := tx.QueryRow(ctx, `SELECT count(*),count(*)FILTER(WHERE status='running')FROM focus_sessions WHERE user_id=$1 AND status IN('running','paused')`, p.UserID).Scan(&active, &running); err != nil {
			return nil, err
		}
		if running > 0 {
			return nil, ErrConflict
		}
		if active >= 32 {
			return nil, ErrLimit
		}
		title, course, err := s.startSource(ctx, tx, p, in)
		if err != nil {
			return nil, err
		}
		sessionID, err := id("focus_")
		if err != nil {
			return nil, err
		}
		intervalID, err := id("fi_")
		if err != nil {
			return nil, err
		}
		_, err = tx.Exec(ctx, `INSERT INTO focus_sessions(id,user_id,mode,status,duration_seconds,run_started_at,planner_item_id,lesson_id,course_id,lab_session_id,title,created_at,updated_at,source_required)VALUES($1,$2,$3,'running',$4,$5,$6,$7,$8,$9,$10,$5,$5,$11)`, sessionID, p.UserID, in.Mode, *in.DurationMinutes*60, at, in.PlannerItemID, in.LessonID, course, in.LabSessionID, title, refs > 0)
		if err != nil {
			return nil, err
		}
		if _, err = tx.Exec(ctx, `INSERT INTO focus_intervals(id,user_id,session_id,began_at)VALUES($1,$2,$3,$4)`, intervalID, p.UserID, sessionID, at); err != nil {
			return nil, err
		}
		v, err := scanFocus(tx.QueryRow(ctx, `SELECT `+focusColumns+` FROM focus_sessions WHERE id=$1 AND user_id=$2`, sessionID, p.UserID))
		return snapshot(v, at), err
	})
}
func (s *Service) focusGuard(session string) guard {
	return func(ctx context.Context, tx pgx.Tx, p identity.Principal) error {
		v, err := scanFocus(tx.QueryRow(ctx, `SELECT `+focusColumns+` FROM focus_sessions WHERE id=$1 AND user_id=$2`, session, p.UserID))
		if err != nil {
			return err
		}
		return s.focusAccess(ctx, tx, p, v)
	}
}
func (s *Service) focusAction(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Action           string `json:"action"`
		ExpectedRevision int64  `json:"expected_revision"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.ExpectedRevision < 1 || in.Action != "pause" && in.Action != "resume" && in.Action != "finish" && in.Action != "cancel" && in.Action != "hidden" {
		failure(w, ErrInvalid)
		return
	}
	session := r.PathValue("id")
	s.mutate(w, r, 200, "focus-action:"+session, in, s.focusGuard(session), func(ctx context.Context, tx pgx.Tx, p identity.Principal, at time.Time) (any, error) {
		v, err := scanFocus(tx.QueryRow(ctx, `SELECT `+focusColumns+` FROM focus_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE`, session, p.UserID))
		if err != nil {
			return nil, err
		}
		if v.Revision != in.ExpectedRevision {
			return nil, ErrConflict
		}
		if v.Status == "finished" || v.Status == "cancelled" {
			return nil, ErrConflict
		}
		if at.Before(v.UpdatedAt) {
			at = v.UpdatedAt
		}
		action := in.Action
		if action == "hidden" {
			action = "pause"
		}
		if action == "pause" && v.Status != "running" || action == "resume" && v.Status != "paused" {
			return nil, ErrConflict
		}
		if action == "resume" {
			if err = s.reconcile(ctx, tx, p, at); err != nil {
				return nil, err
			}
			var running bool
			if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM focus_sessions WHERE user_id=$1 AND status='running')`, p.UserID).Scan(&running); err != nil {
				return nil, err
			}
			if running {
				return nil, ErrConflict
			}
			if v.intervals >= 256 {
				return nil, ErrLimit
			}
			intervalID, err := id("fi_")
			if err != nil {
				return nil, err
			}
			if _, err = tx.Exec(ctx, `INSERT INTO focus_intervals(id,user_id,session_id,began_at)VALUES($1,$2,$3,$4)`, intervalID, p.UserID, session, at); err != nil {
				return nil, err
			}
			v.started = &at
			v.intervals++
			v.Status = "running"
		} else {
			if v.Status == "running" {
				if err = closeRun(ctx, tx, p.UserID, &v, at); err != nil {
					return nil, err
				}
			}
			v.Status = map[string]string{"pause": "paused", "finish": "finished", "cancel": "cancelled"}[action]
			if v.ElapsedSeconds >= float64(v.DurationSeconds) {
				v.Status = "finished"
			}
		}
		if _, err = tx.Exec(ctx, `UPDATE focus_sessions SET status=$3,elapsed_seconds=$4,run_started_at=$5,interval_count=$6,revision=revision+1,updated_at=$7 WHERE id=$1 AND user_id=$2`, session, p.UserID, v.Status, v.ElapsedSeconds, v.started, v.intervals, at); err != nil {
			return nil, err
		}
		v.Revision++
		v.UpdatedAt = at
		return snapshot(v, at), nil
	})
}
func (s *Service) focusReadTransaction(w http.ResponseWriter, r *http.Request) (pgx.Tx, identity.Principal, time.Time, bool) {
	p := principal(r)
	tx, err := s.begin(r.Context(), p)
	if err != nil {
		failure(w, err)
		return nil, p, time.Time{}, false
	}
	at, err := s.now(r.Context(), tx)
	if err == nil {
		err = s.reconcile(r.Context(), tx, p, at)
	}
	if err != nil {
		tx.Rollback(r.Context())
		failure(w, err)
		return nil, p, at, false
	}
	return tx, p, at, true
}
