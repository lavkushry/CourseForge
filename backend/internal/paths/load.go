package paths

import (
	"context"
	"encoding/json"
	"errors"
	"math"

	"courseforge/backend/internal/identity"

	"github.com/jackc/pgx/v5"
)

func (s *Service) load(ctx context.Context, tx pgx.Tx, p identity.Principal, pathID string, lock bool) (Path, error) {
	v := Path{}
	var raw []byte
	q := `SELECT id,goal,course_ids,definition,provenance,source_fingerprint,revision,created_at,updated_at FROM learning_paths WHERE id=$1 AND user_id=$2`
	if lock {
		q += " FOR UPDATE"
	}
	e := tx.QueryRow(ctx, q, pathID, p.UserID).Scan(&v.ID, &v.Goal, &v.CourseIDs, &raw, &v.Provenance, &v.Fingerprint, &v.Revision, &v.CreatedAt, &v.UpdatedAt)
	if e != nil {
		return v, e
	}
	if e = json.Unmarshal(raw, &v.definition); e != nil {
		return v, e
	}
	current, e := sourceFingerprint(ctx, tx, p, v.definition)
	if errors.Is(e, ErrInvalid) {
		v.Outdated = true
	} else if e != nil {
		return v, e
	} else {
		v.Outdated = current != v.Fingerprint
	}
	completed := map[string]bool{}
	rows, e := tx.Query(ctx, `SELECT step_id FROM learning_path_completions WHERE path_id=$1 AND user_id=$2`, pathID, p.UserID)
	if e != nil {
		return v, e
	}
	for rows.Next() {
		var step string
		e = rows.Scan(&step)
		if e != nil {
			rows.Close()
			return v, e
		}
		completed[step] = true
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return v, e
	}
	v.Steps = []PublicStep{}
	for _, step := range v.definition.Steps {
		item := PublicStep{Step: step, Completed: completed[step.ID]}
		if item.Completed {
			v.CompletedSteps++
		}
		for _, src := range step.Sources {
			var done bool
			e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM progress WHERE user_id=$1 AND lesson_id=$2 AND completed)`, p.UserID, src.LessonID).Scan(&done)
			if e != nil {
				return v, e
			}
			if done {
				item.WatchedSources++
			}
		}
		m := Mastery{}
		e = tx.QueryRow(ctx, `SELECT t.score,t.correct_count,t.total_count,t.completed_at,(SELECT count(*) FROM topic_assessment_attempts x JOIN topic_assessments a ON a.id=x.assessment_id WHERE x.user_id=$1 AND a.path_id=$2 AND a.step_id=$3) FROM topic_assessment_attempts t JOIN topic_assessments a ON a.id=t.assessment_id WHERE t.user_id=$1 AND a.path_id=$2 AND a.step_id=$3 ORDER BY t.completed_at DESC,t.id DESC LIMIT 1`, p.UserID, pathID, step.ID).Scan(&m.LastScore, &m.Correct, &m.Total, &m.LastAttemptAt, &m.Attempts)
		if e == nil {
			m.Status = masteryStatus(m.LastScore)
			item.Mastery = &m
			v.AssessedTopics++
			if m.Status == "needs_practice" {
				v.NeedsPractice++
			}
		} else if !errors.Is(e, pgx.ErrNoRows) {
			return v, e
		}
		if !item.Completed && v.NextStepID == nil {
			unlocked := true
			for _, pre := range step.Prerequisites {
				unlocked = unlocked && completed[pre]
			}
			if unlocked {
				key := step.ID
				v.NextStepID = &key
			}
		}
		v.Steps = append(v.Steps, item)
	}
	v.CompletionPercent = int(math.RoundToEven(100 * float64(v.CompletedSteps) / float64(len(v.Steps))))
	return v, nil
}
