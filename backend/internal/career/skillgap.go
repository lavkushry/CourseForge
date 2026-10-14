package career

import (
	"context"
	"strings"
)

const maxBridgesPerMatch = 8
const maxLinksPerSkill = 4

// bridgeSkillGaps maps missing JD keywords to published CourseForge courses/lessons
// by tags, titles, and category/search text. Never invents content outside the catalog.
func (s *Service) bridgeSkillGaps(ctx context.Context, missing []KeywordWeight) ([]SkillBridge, error) {
	if s == nil || s.Pool == nil || len(missing) == 0 {
		return []SkillBridge{}, nil
	}
	out := make([]SkillBridge, 0, maxBridgesPerMatch)
	for _, kw := range missing {
		if len(out) >= maxBridgesPerMatch {
			break
		}
		skill := normalizeTerm(kw.Term)
		if skill == "" {
			continue
		}
		courses, err := s.findCoursesForSkill(ctx, skill)
		if err != nil {
			return nil, err
		}
		lessons, err := s.findLessonsForSkill(ctx, skill)
		if err != nil {
			return nil, err
		}
		if len(courses) == 0 && len(lessons) == 0 {
			continue
		}
		out = append(out, SkillBridge{Skill: skill, Courses: courses, Lessons: lessons})
	}
	return out, nil
}

func (s *Service) findCoursesForSkill(ctx context.Context, skill string) ([]SkillBridgeLink, error) {
	rows, err := s.Pool.Query(ctx, `
SELECT c.id, c.title
FROM courses c
WHERE c.published
  AND (
    EXISTS (SELECT 1 FROM unnest(c.tags) t WHERE lower(t) = $1 OR POSITION($1 IN lower(t)) > 0)
    OR POSITION($1 IN lower(c.title)) > 0
    OR POSITION($1 IN lower(c.category)) > 0
    OR POSITION($1 IN lower(c.description)) > 0
  )
ORDER BY
  CASE WHEN EXISTS (SELECT 1 FROM unnest(c.tags) t WHERE lower(t) = $1) THEN 0
       WHEN POSITION($1 IN lower(c.title)) > 0 THEN 1
       ELSE 2 END,
  c.title, c.id
LIMIT $2`, skill, maxLinksPerSkill)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SkillBridgeLink
	for rows.Next() {
		var link SkillBridgeLink
		if err := rows.Scan(&link.ID, &link.Title); err != nil {
			return nil, err
		}
		link.Href = "#courses"
		out = append(out, link)
	}
	if out == nil {
		out = []SkillBridgeLink{}
	}
	return out, rows.Err()
}

func (s *Service) findLessonsForSkill(ctx context.Context, skill string) ([]SkillBridgeLink, error) {
	rows, err := s.Pool.Query(ctx, `
SELECT l.id, l.title, l.course_id
FROM lessons l
JOIN courses c ON c.id = l.course_id
WHERE c.published
  AND POSITION($1 IN lower(l.title)) > 0
ORDER BY l.sort_order, l.title, l.id
LIMIT $2`, skill, maxLinksPerSkill)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SkillBridgeLink
	for rows.Next() {
		var link SkillBridgeLink
		if err := rows.Scan(&link.ID, &link.Title, &link.CourseID); err != nil {
			return nil, err
		}
		link.Href = "#learning/" + link.ID
		out = append(out, link)
	}
	if out == nil {
		out = []SkillBridgeLink{}
	}
	return out, rows.Err()
}

// SkillGapSearchTerms exposes normalized missing terms for tests / UI helpers.
func SkillGapSearchTerms(missing []KeywordWeight) []string {
	out := make([]string, 0, len(missing))
	seen := map[string]struct{}{}
	for _, kw := range missing {
		t := normalizeTerm(kw.Term)
		if t == "" {
			continue
		}
		if _, ok := seen[t]; ok {
			continue
		}
		seen[t] = struct{}{}
		out = append(out, t)
	}
	return out
}

// FilterBridgesForSkill returns bridges whose skill equals term (normalized).
func FilterBridgesForSkill(bridges []SkillBridge, skill string) []SkillBridge {
	want := normalizeTerm(skill)
	var out []SkillBridge
	for _, b := range bridges {
		if strings.EqualFold(b.Skill, want) {
			out = append(out, b)
		}
	}
	return out
}
