package paths

import (
	"context"
	"courseforge/backend/internal/identity"
	"courseforge/backend/internal/planning"
	"github.com/jackc/pgx/v5"
	"time"
)

// PlanningAdapter performs bounded SQL within the planner's supplied transaction.
// Paths depends on planning's interface; planning never imports paths.
type PlanningAdapter struct{ Service *Service }

var _ planning.PathAdapter = PlanningAdapter{}

func (a PlanningAdapter) Validate(ctx context.Context, tx pgx.Tx, p identity.Principal, pathID string) (string, error) {
	v, e := a.Service.load(ctx, tx, p, pathID, false)
	if e != nil {
		return "", e
	}
	if v.Outdated {
		return "", planning.ErrUnavailable
	}
	return v.CourseIDs[0], nil
}
func (a PlanningAdapter) Candidates(ctx context.Context, tx pgx.Tx, p identity.Principal, pathID string, _ time.Time, _ string) ([]planning.Candidate, []string, error) {
	v, e := a.Service.load(ctx, tx, p, pathID, false)
	if e != nil {
		return nil, nil, e
	}
	if v.Outdated {
		return nil, nil, planning.ErrUnavailable
	}
	done := map[string]bool{}
	for _, s := range v.Steps {
		done[s.ID] = s.Completed
	}
	items := []planning.Candidate{}
	for _, step := range v.Steps {
		if step.Completed {
			continue
		}
		unlocked := true
		for _, pre := range step.Prerequisites {
			unlocked = unlocked && done[pre]
		}
		if !unlocked {
			continue
		}
		// Current planning.PathAdapter anchors a path to one course. Do not
		// return other-course actions its caller would subsequently reject.
		var src *Source
		for i := range step.Sources {
			if step.Sources[i].CourseID == v.CourseIDs[0] {
				src = &step.Sources[i]
				break
			}
		}
		if src == nil {
			continue
		}
		course, lesson, path, key := src.CourseID, src.LessonID, v.ID, step.ID
		items = append(items, planning.Candidate{Key: "path:" + path + ":" + key, Kind: "lesson", Title: step.Title, Description: "Source-linked path topic; checklist completion does not establish mastery.", Minutes: 15, CourseID: &course, Action: planning.Action{View: "learning", LessonID: &lesson, Position: src.Start, PathID: &path, StepID: &key}})
		if len(items) == 32 {
			break
		}
	}
	return items, []string{"Verified practice/lab recommendations are not connected.", "The planner currently anchors cross-course paths to their first course; other-course topics remain in the path."}, nil
}
func (a PlanningAdapter) ValidateCandidate(ctx context.Context, tx pgx.Tx, p identity.Principal, pathID string, candidate planning.Candidate) error {
	v, e := a.Service.load(ctx, tx, p, pathID, false)
	if e != nil {
		return e
	}
	if v.Outdated {
		return planning.ErrUnavailable
	}
	if candidate.Action.PathID == nil || *candidate.Action.PathID != pathID || candidate.Action.StepID == nil || candidate.Action.LessonID == nil || candidate.CourseID == nil {
		return planning.ErrInvalid
	}
	step, e := findStep(v, *candidate.Action.StepID)
	if e != nil {
		return e
	}
	for _, src := range step.Sources {
		if src.LessonID == *candidate.Action.LessonID && src.CourseID == *candidate.CourseID && src.Start == candidate.Action.Position {
			return nil
		}
	}
	return pgx.ErrNoRows
}
