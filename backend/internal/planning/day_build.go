package planning

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"courseforge/backend/internal/identity"

	"github.com/jackc/pgx/v5"
)

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
