package paths

import (
	"context"
	"math"
	"strconv"

	"courseforge/backend/internal/identity"

	"github.com/jackc/pgx/v5"
)

func validDefinition(d Definition) error {
	if !identifiers.MatchString(d.ID) || !text(d.Goal, 3, 180) || len(d.CourseIDs) < 1 || len(d.CourseIDs) > 8 || len(d.Steps) < 1 || len(d.Steps) > 100 || d.ExpectedRevision < 0 {
		return ErrInvalid
	}
	courses := map[string]bool{}
	for _, c := range d.CourseIDs {
		if !text(c, 1, 200) || courses[c] {
			return ErrInvalid
		}
		courses[c] = true
	}
	steps := map[string]bool{}
	for _, step := range d.Steps {
		if !identifiers.MatchString(step.ID) || steps[step.ID] || !text(step.Title, 1, 120) || len(step.Objectives) > 5 || len(step.Sources) < 1 || len(step.Sources) > 8 {
			return ErrInvalid
		}
		steps[step.ID] = true
		for _, o := range step.Objectives {
			if !text(o, 1, 300) {
				return ErrInvalid
			}
		}
		seen := map[string]bool{}
		for _, src := range step.Sources {
			key := src.LessonID + ":" + strconv.FormatFloat(src.Start, 'f', -1, 64)
			if !courses[src.CourseID] || !text(src.LessonID, 1, 500) || math.IsNaN(src.Start) || math.IsInf(src.Start, 0) || src.Start < 0 || seen[key] {
				return ErrInvalid
			}
			seen[key] = true
		}
	}
	visited := map[string]int{}
	lookup := map[string]Step{}
	for _, s := range d.Steps {
		lookup[s.ID] = s
	}
	var visit func(string) bool
	visit = func(key string) bool {
		if visited[key] == 1 {
			return false
		}
		if visited[key] == 2 {
			return true
		}
		visited[key] = 1
		seen := map[string]bool{}
		for _, pre := range lookup[key].Prerequisites {
			if !steps[pre] || pre == key || seen[pre] || !visit(pre) {
				return false
			}
			seen[pre] = true
		}
		visited[key] = 2
		return true
	}
	for key := range lookup {
		if !visit(key) {
			return ErrInvalid
		}
	}
	return nil
}
func sourceFingerprint(ctx context.Context, tx pgx.Tx, p identity.Principal, d Definition) (string, error) {
	if e := courseAccess(ctx, tx, p, d.CourseIDs); e != nil {
		return "", e
	}
	parts := []any{d.Goal, d.CourseIDs, d.Steps}
	for _, step := range d.Steps {
		for _, src := range step.Sources {
			var title string
			var duration float64
			e := tx.QueryRow(ctx, `SELECT title,duration_seconds FROM lessons WHERE id=$1 AND course_id=$2 FOR SHARE`, src.LessonID, src.CourseID).Scan(&title, &duration)
			if e != nil {
				return "", e
			}
			if src.Start > duration {
				return "", ErrInvalid
			}
			parts = append(parts, []any{src.LessonID, src.CourseID, title, duration})
			rows, e := tx.Query(ctx, `SELECT id,start_seconds,end_seconds,text FROM transcript_chunks WHERE lesson_id=$1 AND abs(start_seconds-$2)<=300 ORDER BY abs(start_seconds-$2),id LIMIT 10 FOR SHARE`, src.LessonID, src.Start)
			if e != nil {
				return "", e
			}
			found := src.ChunkID == ""
			for rows.Next() {
				var chunk, text string
				var start, end float64
				if e = rows.Scan(&chunk, &start, &end, &text); e != nil {
					rows.Close()
					return "", e
				}
				parts = append(parts, []any{chunk, start, end, text})
				if chunk == src.ChunkID {
					found = true
				}
			}
			e = rows.Err()
			rows.Close()
			if e != nil {
				return "", e
			}
			if !found {
				return "", ErrInvalid
			}
		}
	}
	return digest(parts), nil
}
