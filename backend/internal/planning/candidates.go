package planning

import (
	"context"
	"math"
	"strings"
	"time"

	"courseforge/backend/internal/identity"

	"github.com/jackc/pgx/v5"
)

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
