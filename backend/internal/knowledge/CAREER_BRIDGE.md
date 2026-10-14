# Career skill-gap bridge

The `career` package may not exist on this branch. Living Video Knowledge owns
concept storage and exposes a stable interface for future skill-gap work.

## Interface

```go
type SkillGapConceptProvider interface {
    ListConceptsForSkillGap(ctx context.Context, lessonID string) ([]SkillGapConcept, error)
}
```

`knowledge.Service` implements this interface.

## Integration steps

1. When `backend/internal/career` is added, depend on `SkillGapConceptProvider`
   (inject `*knowledge.Service` or a thin adapter).
2. Map `SkillGapConcept.Slug` / `Title` onto the career skill taxonomy.
3. Order remediation using `PrereqIDs` (and `knowledge_concept_prereqs.confidence`
   / `source` via a dedicated list helper if richer edges are needed).
4. Keep SQL ownership in `knowledge` — career must not query `knowledge_*` tables.

## Concept graph fields

| Field | Use |
| --- | --- |
| `slug` / `title` | Skill identity matching |
| `summary` | Gap explanation copy |
| `prereq_ids` | Prerequisite DAG edges |
| `segment_end_ms` | Deep-link into video for remediation |
