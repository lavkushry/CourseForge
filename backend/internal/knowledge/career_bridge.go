package knowledge

import (
	"context"
)

// SkillGapConcept is the stable shape exposed to a future career skill-gap package.
// The career package may not exist on this branch; integrate by depending on
// SkillGapConceptProvider rather than reading knowledge_* tables directly.
type SkillGapConcept struct {
	ID          string   `json:"id"`
	LessonID    string   `json:"lesson_id"`
	Slug        string   `json:"slug"`
	Title       string   `json:"title"`
	Summary     string   `json:"summary"`
	Ordinal     int      `json:"ordinal"`
	PrereqIDs   []string `json:"prereq_ids,omitempty"`
	SegmentEnds []int    `json:"segment_end_ms,omitempty"`
}

// SkillGapConceptProvider is the integration surface for career skill-gap analysis.
//
// Integration notes (when backend/internal/career lands):
//  1. Inject knowledge.Service (or a narrow adapter) as SkillGapConceptProvider.
//  2. Map SkillGapConcept.Slug/Title onto career skill taxonomies.
//  3. Use PrereqIDs + confidence from knowledge_concept_prereqs for gap ordering;
//     call ListConceptPrereqs for edge metadata if needed.
//  4. Do not query knowledge_* tables from career — keep storage ownership here.
type SkillGapConceptProvider interface {
	ListConceptsForSkillGap(ctx context.Context, lessonID string) ([]SkillGapConcept, error)
}

// ListConceptsForSkillGap implements SkillGapConceptProvider.
func (s *Service) ListConceptsForSkillGap(ctx context.Context, lessonID string) ([]SkillGapConcept, error) {
	concepts, err := s.listConcepts(ctx, lessonID)
	if err != nil {
		return nil, err
	}
	out := make([]SkillGapConcept, 0, len(concepts))
	for _, c := range concepts {
		prereqs, _ := s.listPrereqIDs(ctx, c.ID)
		ends, _ := s.listConceptSegmentEnds(ctx, c.ID)
		out = append(out, SkillGapConcept{
			ID:          c.ID,
			LessonID:    c.LessonID,
			Slug:        c.Slug,
			Title:       c.Title,
			Summary:     c.Summary,
			Ordinal:     c.Ordinal,
			PrereqIDs:   prereqs,
			SegmentEnds: ends,
		})
	}
	return out, nil
}
