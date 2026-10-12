package planning

import (
	"context"
	"courseforge/backend/internal/httpx"
	"courseforge/backend/internal/identity"
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5"
	"math"
	"net/http"
	"strings"
	"time"
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
func (s *Service) candidates(ctx context.Context, tx pgx.Tx, p identity.Principal, day time.Time, path *string, zoneName string) ([]Candidate, []string, error) {
	items := []Candidate{}
	warnings := []string{}
	loc, err := time.LoadLocation(zoneName)
	if err != nil {
		return nil, nil, ErrInvalid
	}
	cutoff := time.Date(day.Year(), day.Month(), day.Day()+1, 0, 0, 0, 0, loc)
	rows, err := tx.Query(ctx, `SELECT rc.id FROM review_cards rc JOIN courses c ON c.id=rc.course_id WHERE rc.user_id=$1 AND `+visibleCourse+` AND rc.due_at<$3 ORDER BY rc.due_at,rc.id LIMIT 20`, p.UserID, p.Role, cutoff)
	if err != nil {
		return nil, nil, err
	}
	cards := []string{}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return nil, nil, err
		}
		cards = append(cards, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, nil, err
	}
	if len(cards) > 0 {
		items = append(items, Candidate{Key: "review:due", Kind: "review", Title: "Review due flashcards", Description: "Cards due by the end of this anchored local day", Minutes: min(16, max(5, int(math.Ceil(float64(len(cards))/4))*3)), Action: Action{View: "reviews", ReviewCardIDs: cards}})
	}
	if path != nil {
		if s.Paths == nil {
			return nil, nil, ErrUnavailable
		}
		extra, w, err := s.Paths.Candidates(ctx, tx, p, *path, day, zoneName)
		if err != nil {
			return nil, nil, err
		}
		if len(extra) > 32 || len(w) > 10 {
			return nil, nil, ErrLimit
		}
		for _, item := range extra {
			if item.Action.PathID == nil || *item.Action.PathID != *path {
				return nil, nil, ErrInvalid
			}
		}
		items = append(items, extra...)
		warnings = append(warnings, w...)
		return items, warnings, nil
	}
	rows, err = tx.Query(ctx, `SELECT l.id,l.course_id,l.title,l.duration_seconds,COALESCE(pr.position,0) FROM lessons l JOIN courses c ON c.id=l.course_id LEFT JOIN progress pr ON pr.lesson_id=l.id AND pr.user_id=$1 WHERE `+visibleCourse+` AND l.status='done' AND NOT COALESCE(pr.completed,false) ORDER BY COALESCE(pr.percent,0) DESC,l.created_at,l.id LIMIT 3`, p.UserID, p.Role)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var lesson, course, title string
		var duration, position float64
		if err = rows.Scan(&lesson, &course, &title, &duration, &position); err != nil {
			return nil, nil, err
		}
		if duration <= 0 {
			duration = 900
		}
		minutes := min(20, max(8, int(math.Ceil(max(0, duration-position)/60))))
		if len([]rune(title)) > 165 {
			title = string([]rune(title)[:165])
		}
		items = append(items, Candidate{Key: "lesson:" + lesson, Kind: "lesson", Title: "Continue: " + title, Description: "Estimated study block; not measured playback time", Minutes: minutes, CourseID: &course, Action: Action{View: "learning", LessonID: &lesson, Position: position}})
	}
	return items, warnings, rows.Err()
}
func selectCandidates(items []Candidate, budget int) []Candidate {
	out := []Candidate{}
	remaining := budget
	seen := map[string]bool{}
	for _, kind := range []string{"review", "lesson", "lab", "assessment", "lesson", "lab", "assessment"} {
		for _, item := range items {
			if item.Kind != kind || seen[item.Key] {
				continue
			}
			if kind == "review" && len(out) == 0 && item.Minutes > remaining {
				item.Minutes = remaining
			}
			if item.Minutes > remaining || item.Minutes < 1 {
				continue
			}
			out = append(out, item)
			seen[item.Key] = true
			remaining -= item.Minutes
			break
		}
	}
	if len(out) == 0 && len(items) > 0 && budget > 0 {
		item := items[0]
		item.Minutes = min(item.Minutes, budget)
		out = append(out, item)
	}
	if len(out) > 6 {
		out = out[:6]
	}
	return out
}
func (s *Service) validateCandidate(ctx context.Context, tx pgx.Tx, p identity.Principal, c Candidate) error {
	if !validText(c.Key, 1, 500) || !validText(strings.TrimSpace(c.Title), 1, 180) || !validText(c.Description, 0, 350) || c.Minutes < 1 || c.Minutes > 180 || !finite(c.Action.Position) || c.Action.Position < 0 || c.Action.Position >= 1e9 || len(c.Action.ReviewCardIDs) > 100 {
		return ErrInvalid
	}
	if c.Kind != "lesson" && c.Kind != "review" && c.Kind != "lab" && c.Kind != "assessment" {
		return ErrInvalid
	}
	if c.Kind == "lesson" && (c.Action.LessonID == nil || c.CourseID == nil) || c.Kind == "review" && len(c.Action.ReviewCardIDs) == 0 || c.Kind == "assessment" && (c.Action.PathID == nil || c.Action.StepID == nil) || c.Kind == "lab" && (c.Action.PathID == nil || c.Action.StepID == nil || c.Action.LabSlug == nil) {
		return ErrInvalid
	}
	if c.Action.LessonID != nil {
		var course string
		if err := tx.QueryRow(ctx, `SELECT course_id FROM lessons WHERE id=$1`, *c.Action.LessonID).Scan(&course); err != nil {
			return err
		}
		if c.CourseID == nil || *c.CourseID != course {
			return ErrInvalid
		}
	}
	seen := map[string]bool{}
	for _, card := range c.Action.ReviewCardIDs {
		if len(card) < 1 || len(card) > 500 || seen[card] {
			return ErrInvalid
		}
		seen[card] = true
	}
	return s.itemAccess(ctx, tx, p, Item{Candidate: c})
}
func (s *Service) buildDay(ctx context.Context, tx pgx.Tx, p identity.Principal, date time.Time, budget int, refresh bool, expected *int64, override []Candidate, reserved map[string]bool, at time.Time) (Day, error) {
	key := date.Format("2006-01-02")
	old, err := s.readDay(ctx, tx, p, key, false)
	exists := err == nil
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return Day{}, err
	}
	if expected != nil && old.Revision != *expected {
		return Day{}, ErrConflict
	}
	if exists && !refresh {
		return s.readDay(ctx, tx, p, key, true)
	}
	pref, err := preferences(ctx, tx, p.UserID)
	if err != nil {
		return Day{}, err
	}
	course, err := s.pathAccess(ctx, tx, p, pref.PathID)
	if err != nil {
		return Day{}, err
	}
	zoneName, _, err := zone(ctx, tx, p.UserID, true)
	if err != nil {
		return Day{}, err
	}
	suggestions, warnings, err := s.candidates(ctx, tx, p, date, pref.PathID, zoneName)
	if err != nil {
		return Day{}, err
	}
	if override != nil {
		suggestions = override
	}
	pinned := []Item{}
	prior := map[string]Item{}
	for _, item := range old.Items {
		prior[item.Key] = item
		if item.pinned {
			pinned = append(pinned, item)
		}
	}
	remaining := budget
	for _, item := range pinned {
		remaining -= item.Minutes
	}
	eligible := []Candidate{}
	for _, item := range suggestions {
		if prior[item.Key].pinned || reserved != nil && reserved[item.Key] {
			continue
		}
		if err = s.validateCandidate(ctx, tx, p, item); err != nil {
			return Day{}, err
		}
		eligible = append(eligible, item)
	}
	picked := selectCandidates(eligible, max(0, remaining))
	if len(pinned) > 0 && remaining < 15 {
		picked = []Candidate{}
	}
	if len(pinned)+len(picked) > 32 {
		return Day{}, ErrLimit
	}
	planID := old.ID
	if !exists {
		planID, err = id("plan_")
		if err != nil {
			return Day{}, err
		}
	}
	if _, err = tx.Exec(ctx, `INSERT INTO daily_plans(id,user_id,study_date,path_id,path_course_id,budget_minutes,timezone,revision,created_at,updated_at)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)ON CONFLICT(user_id,study_date)DO UPDATE SET path_id=excluded.path_id,path_course_id=excluded.path_course_id,budget_minutes=excluded.budget_minutes,timezone=excluded.timezone,revision=excluded.revision,updated_at=excluded.updated_at`, planID, p.UserID, key, pref.PathID, course, budget, zoneName, old.Revision+1, at); err != nil {
		return Day{}, err
	}
	retained := []string{}
	for _, item := range pinned {
		retained = append(retained, item.ID)
	}
	for _, c := range picked {
		item := prior[c.Key]
		itemID := item.ID
		if itemID == "" {
			itemID, err = id("item_")
			if err != nil {
				return Day{}, err
			}
		}
		retained = append(retained, itemID)
		raw, err := json.Marshal(c.Action)
		if err != nil {
			return Day{}, err
		}
		_, err = tx.Exec(ctx, `INSERT INTO daily_plan_items(id,user_id,plan_id,item_key,kind,course_id,lesson_id,path_id,step_id,lab_slug,title,description,minutes,sort_order,action,revision,updated_at)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)ON CONFLICT(id)DO UPDATE SET kind=excluded.kind,course_id=excluded.course_id,lesson_id=excluded.lesson_id,path_id=excluded.path_id,step_id=excluded.step_id,lab_slug=excluded.lab_slug,title=excluded.title,description=excluded.description,minutes=excluded.minutes,sort_order=excluded.sort_order,action=excluded.action,revision=excluded.revision,updated_at=excluded.updated_at`, itemID, p.UserID, planID, c.Key, c.Kind, c.CourseID, c.Action.LessonID, c.Action.PathID, c.Action.StepID, c.Action.LabSlug, c.Title, c.Description, c.Minutes, len(retained)-1, raw, item.Revision+1, at)
		if err != nil {
			return Day{}, err
		}
	}
	for i, item := range pinned {
		if _, err = tx.Exec(ctx, `UPDATE daily_plan_items SET sort_order=$2 WHERE id=$1 AND user_id=$3`, item.ID, i, p.UserID); err != nil {
			return Day{}, err
		}
	}
	if _, err = tx.Exec(ctx, `DELETE FROM daily_plan_items WHERE plan_id=$1 AND user_id=$2 AND NOT(id=ANY($3::text[]))`, planID, p.UserID, retained); err != nil {
		return Day{}, err
	}
	result, err := s.readDay(ctx, tx, p, key, true)
	result.Warnings = append(result.Warnings, warnings...)
	if remaining < 0 {
		result.Warnings = append(result.Warnings, "Recorded work exceeds the updated budget and has been preserved.")
	}
	return result, err
}
func (s *Service) itemGuard(itemID string) guard {
	return func(ctx context.Context, tx pgx.Tx, p identity.Principal) error {
		item, err := scanItem(tx.QueryRow(ctx, `SELECT `+itemColumns+` FROM daily_plan_items i WHERE i.id=$1 AND i.user_id=$2`, itemID, p.UserID))
		if err != nil {
			return err
		}
		return s.itemAccess(ctx, tx, p, item)
	}
}
func (s *Service) itemStatus(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Status           string `json:"status"`
		ExpectedRevision int64  `json:"expected_revision"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.ExpectedRevision < 1 || in.Status != "pending" && in.Status != "done" && in.Status != "skipped" {
		failure(w, ErrInvalid)
		return
	}
	s.itemWrite(w, r, "item-status", in, in.ExpectedRevision, &in.Status, nil)
}
func (s *Service) itemActual(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ActualMinutes    *int  `json:"actual_minutes"`
		ExpectedRevision int64 `json:"expected_revision"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.ExpectedRevision < 1 || in.ActualMinutes == nil || *in.ActualMinutes < 0 || *in.ActualMinutes > 600 {
		failure(w, ErrInvalid)
		return
	}
	s.itemWrite(w, r, "item-actual", in, in.ExpectedRevision, nil, in.ActualMinutes)
}
func (s *Service) itemWrite(w http.ResponseWriter, r *http.Request, kind string, in any, revision int64, status *string, actual *int) {
	itemID := r.PathValue("id")
	s.mutate(w, r, 200, kind+":"+itemID, in, s.itemGuard(itemID), func(ctx context.Context, tx pgx.Tx, p identity.Principal, at time.Time) (any, error) {
		var planID string
		err := tx.QueryRow(ctx, `UPDATE daily_plan_items SET status=COALESCE($3,status),actual_minutes=COALESCE($4,actual_minutes),revision=revision+1,updated_at=$5 WHERE id=$1 AND user_id=$2 AND revision=$6 RETURNING plan_id`, itemID, p.UserID, status, actual, at, revision).Scan(&planID)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrConflict
		}
		if err != nil {
			return nil, err
		}
		var date string
		err = tx.QueryRow(ctx, `UPDATE daily_plans SET revision=revision+1,updated_at=$3 WHERE id=$1 AND user_id=$2 RETURNING study_date::text`, planID, p.UserID, at).Scan(&date)
		if err != nil {
			return nil, err
		}
		return s.readDay(ctx, tx, p, date, true)
	})
}
