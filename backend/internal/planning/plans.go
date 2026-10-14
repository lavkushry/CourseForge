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

type Action struct {
	View          string   `json:"view"`
	LessonID      *string  `json:"lesson_id,omitempty"`
	Position      float64  `json:"position,omitempty"`
	ReviewCardIDs []string `json:"review_card_ids,omitempty"`
	PathID        *string  `json:"path_id,omitempty"`
	StepID        *string  `json:"step_id,omitempty"`
	LabSlug       *string  `json:"lab_slug,omitempty"`
}
type Candidate struct {
	Key         string  `json:"item_key"`
	Kind        string  `json:"kind"`
	Title       string  `json:"title"`
	Description string  `json:"description"`
	Minutes     int     `json:"minutes"`
	CourseID    *string `json:"course_id"`
	Action      Action  `json:"action"`
}
type Item struct {
	Candidate
	ID            string    `json:"id"`
	Status        string    `json:"status"`
	ActualMinutes int       `json:"actual_minutes"`
	Revision      int64     `json:"revision"`
	UpdatedAt     time.Time `json:"updated_at"`
	pinned        bool
	order         int
}
type Day struct {
	ID                  string    `json:"id"`
	StudyDate           string    `json:"study_date"`
	PathID              *string   `json:"path_id"`
	BudgetMinutes       int       `json:"budget_minutes"`
	Timezone            string    `json:"timezone"`
	Revision            int64     `json:"revision"`
	CreatedAt           time.Time `json:"created_at"`
	UpdatedAt           time.Time `json:"updated_at"`
	PlannedMinutes      int       `json:"planned_minutes"`
	ReportedDoneMinutes int       `json:"reported_done_minutes"`
	ActualMinutes       int       `json:"actual_minutes"`
	CompletedCount      int       `json:"completed_count"`
	Items               []Item    `json:"items"`
	Warnings            []string  `json:"warnings"`
	Disclaimer          string    `json:"disclaimer"`
}

const itemColumns = `i.id,i.item_key,i.kind,i.course_id,i.title,i.description,i.minutes,i.action,i.status,i.actual_minutes,i.revision,i.updated_at,i.sort_order,EXISTS(SELECT 1 FROM focus_sessions fs WHERE fs.planner_item_id=i.id)`

func scanItem(row pgx.Row) (Item, error) {
	var v Item
	var raw []byte
	err := row.Scan(&v.ID, &v.Key, &v.Kind, &v.CourseID, &v.Title, &v.Description, &v.Minutes, &raw, &v.Status, &v.ActualMinutes, &v.Revision, &v.UpdatedAt, &v.order, &v.pinned)
	if err == nil {
		err = json.Unmarshal(raw, &v.Action)
	}
	v.pinned = v.pinned || v.Status != "pending" || v.ActualMinutes > 0
	return v, err
}
func (s *Service) itemAccess(ctx context.Context, tx pgx.Tx, p identity.Principal, in Item) error {
	if in.CourseID != nil {
		if err := courseAccess(ctx, tx, p, *in.CourseID); err != nil {
			return err
		}
	}
	if in.Action.LessonID != nil {
		if err := s.lessonAccess(ctx, tx, p, *in.Action.LessonID); err != nil {
			return err
		}
	}
	if in.Action.PathID != nil {
		course, err := s.pathAccess(ctx, tx, p, in.Action.PathID)
		if err != nil {
			return err
		}
		if in.CourseID != nil && course != nil && *in.CourseID != *course {
			return ErrInvalid
		}
		if err = s.Paths.ValidateCandidate(ctx, tx, p, *in.Action.PathID, in.Candidate); err != nil {
			return err
		}
	}
	if len(in.Action.ReviewCardIDs) > 0 {
		var n int
		err := tx.QueryRow(ctx, `SELECT count(*) FROM review_cards rc JOIN courses c ON c.id=rc.course_id WHERE rc.user_id=$1 AND `+visibleCourse+` AND rc.id=ANY($3)`, p.UserID, p.Role, in.Action.ReviewCardIDs).Scan(&n)
		if err != nil {
			return err
		}
		if n != len(in.Action.ReviewCardIDs) {
			return pgx.ErrNoRows
		}
	}
	return nil
}
func (s *Service) readDay(ctx context.Context, tx pgx.Tx, p identity.Principal, date string, filter bool) (Day, error) {
	v := Day{StudyDate: date, Items: []Item{}, Warnings: []string{}, Disclaimer: "Checklist completion and actual minutes are self-reported; they do not change mastery, quiz, lab or watched-video results."}
	err := tx.QueryRow(ctx, `SELECT id,path_id,budget_minutes,timezone,revision,created_at,updated_at FROM daily_plans WHERE user_id=$1 AND study_date=$2`, p.UserID, date).Scan(&v.ID, &v.PathID, &v.BudgetMinutes, &v.Timezone, &v.Revision, &v.CreatedAt, &v.UpdatedAt)
	if err != nil {
		return v, err
	}
	rows, err := tx.Query(ctx, `SELECT `+itemColumns+` FROM daily_plan_items i WHERE i.user_id=$1 AND i.plan_id=$2 ORDER BY i.sort_order,i.id LIMIT 33`, p.UserID, v.ID)
	if err != nil {
		return v, err
	}
	items := []Item{}
	for rows.Next() {
		item, err := scanItem(rows)
		if err != nil {
			rows.Close()
			return v, err
		}
		items = append(items, item)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return v, err
	}
	if len(items) > 32 {
		return v, ErrLimit
	}
	v.Items = items
	if filter {
		return s.filterDay(ctx, tx, p, v)
	}
	return summarizeDay(v), nil
}

func (s *Service) filterDay(ctx context.Context, tx pgx.Tx, p identity.Principal, v Day) (Day, error) {
	items := v.Items
	v.Items = []Item{}
	for _, item := range items {
		err := s.itemAccess(ctx, tx, p, item)
		if errors.Is(err, pgx.ErrNoRows) {
			v.Warnings = append(v.Warnings, "A saved item is currently unavailable.")
			continue
		}
		if err != nil {
			return v, err
		}
		v.Items = append(v.Items, item)
	}
	return summarizeDay(v), nil
}

func summarizeDay(v Day) Day {
	v.PlannedMinutes, v.ActualMinutes, v.CompletedCount, v.ReportedDoneMinutes = 0, 0, 0, 0
	for _, item := range v.Items {
		v.PlannedMinutes += item.Minutes
		v.ActualMinutes += item.ActualMinutes
		if item.Status == "done" {
			v.CompletedCount++
			v.ReportedDoneMinutes += item.Minutes
		}
	}
	return v
}
func (s *Service) day(w http.ResponseWriter, r *http.Request) {
	date := r.PathValue("date")
	if _, err := dateValue(date); err != nil {
		failure(w, err)
		return
	}
	tx, err := s.Pool.Begin(r.Context())
	if err != nil {
		failure(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	v, err := s.readDay(r.Context(), tx, principal(r), date, true)
	if err != nil {
		failure(w, err)
		return
	}
	httpx.JSON(w, 200, v)
}

type generateInput struct {
	StudyDate        string `json:"study_date"`
	Refresh          bool   `json:"refresh"`
	ExpectedRevision *int64 `json:"expected_revision"`
}

func validRefresh(refresh bool, revision *int64) bool {
	return (revision == nil && !refresh) || (revision != nil && *revision >= 0)
}
func (s *Service) generateDay(w http.ResponseWriter, r *http.Request) {
	var in generateInput
	if !httpx.Decode(w, r, &in) {
		return
	}
	day, err := dateValue(in.StudyDate)
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
	s.mutate(w, r, 201, "generate-day", in, check, func(ctx context.Context, tx pgx.Tx, p identity.Principal, at time.Time) (any, error) {
		pref, err := preferences(ctx, tx, p.UserID)
		if err != nil {
			return nil, err
		}
		return s.buildDay(ctx, tx, p, day, pref.DailyMinutes, in.Refresh, in.ExpectedRevision, nil, nil, at)
	})
}
