package ai

import (
	"context"
	"net/http"
	"strings"
	"time"

	"courseforge/backend/internal/httpx"
)

func (s *Service) semanticSearch(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		httpx.Error(w, 400, "invalid_query", "Search query 'q' is required")
		return
	}
	courseID := r.URL.Query().Get("course_id")
	lessonID := r.URL.Query().Get("lesson_id")

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	citations := s.findRelevantCitations(ctx, courseID, lessonID, q, 8)
	httpx.JSON(w, 200, map[string]any{
		"query":     q,
		"course_id": courseID,
		"results":   citations,
	})
}

type AssociativeResult struct {
	ChunkID          string  `json:"chunk_id"`
	LessonID         string  `json:"lesson_id"`
	LessonTitle      string  `json:"lesson_title"`
	StartSeconds     float64 `json:"start_seconds"`
	EndSeconds       float64 `json:"end_seconds"`
	Text             string  `json:"text"`
	EntityName       string  `json:"entity_name"`
	AssociativeScore float64 `json:"associative_score"`
	PathExplanation  string  `json:"path_explanation"`
}

func (s *Service) associativeSearch(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		httpx.Error(w, 400, "invalid_query", "Query parameter 'q' is required")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	cleanKeywords := extractSearchKeywords(q)
	rows, err := s.Pool.Query(ctx, `
		WITH matched_seeds AS (
			SELECT id, name, category, 1.0::float as score
			FROM kg_entities
			WHERE name ILIKE '%' || $1 || '%' OR $2 ILIKE '%' || name || '%'
			LIMIT 3
		),
		graph_walk AS (
			SELECT id as entity_id, name, score, 0 as depth, name as path
			FROM matched_seeds

			UNION ALL

			SELECT r.target_entity_id, e.name, gw.score * r.weight * 0.85, gw.depth + 1,
			       gw.path || ' -> ' || r.relation_type || ' -> ' || e.name
			FROM graph_walk gw
			JOIN kg_relations r ON r.source_entity_id = gw.entity_id
			JOIN kg_entities e ON e.id = r.target_entity_id
			WHERE gw.depth < 2
		)
		SELECT DISTINCT ON (t.id)
			t.id, t.lesson_id, COALESCE(l.title, ''), t.start_seconds, t.end_seconds, t.text,
			gw.name, round(gw.score::numeric, 3), gw.path
		FROM graph_walk gw
		JOIN kg_passage_entities pe ON pe.entity_id = gw.entity_id
		JOIN transcript_chunks t ON t.id = pe.chunk_id
		JOIN lessons l ON l.id = t.lesson_id
		ORDER BY t.id, gw.score DESC
		LIMIT 10
	`, q, cleanKeywords)

	var results []AssociativeResult
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var res AssociativeResult
			if scanErr := rows.Scan(&res.ChunkID, &res.LessonID, &res.LessonTitle, &res.StartSeconds, &res.EndSeconds, &res.Text, &res.EntityName, &res.AssociativeScore, &res.PathExplanation); scanErr == nil {
				results = append(results, res)
			}
		}
	}

	if len(results) == 0 {
		cits := s.findRelevantCitations(ctx, "", "", q, 6)
		for _, c := range cits {
			results = append(results, AssociativeResult{
				ChunkID:          c.ChunkID,
				LessonID:         c.LessonID,
				LessonTitle:      c.LessonTitle,
				StartSeconds:     c.StartSeconds,
				EndSeconds:       c.EndSeconds,
				Text:             c.Text,
				EntityName:       "Vector / Keyword Semantic Match",
				AssociativeScore: c.Similarity,
				PathExplanation:  "Direct Lexical & Cosine Retrieval",
			})
		}
	}

	httpx.JSON(w, 200, map[string]any{
		"query":     q,
		"algorithm": "HippoRAG-2 Dual-Node Multi-Hop Walk",
		"count":     len(results),
		"results":   results,
	})
}
