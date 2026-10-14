package ai

import (
	"context"
	"net/http"
	"time"

	"courseforge/backend/internal/httpx"
)

func (s *Service) lessonTranscripts(w http.ResponseWriter, r *http.Request) {
	lessonID := r.PathValue("id")
	if lessonID == "" {
		httpx.Error(w, 400, "invalid_id", "Lesson ID is required")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	var title string
	err := s.Pool.QueryRow(ctx, "SELECT title FROM lessons WHERE id=$1", lessonID).Scan(&title)
	if err != nil {
		httpx.Error(w, 404, "not_found", "Lesson not found")
		return
	}

	rows, err := s.Pool.Query(ctx, `
		SELECT id, start_seconds, end_seconds, text, kind
		FROM transcript_chunks
		WHERE lesson_id=$1 AND kind='transcript'
		ORDER BY start_seconds ASC
	`, lessonID)
	if err != nil {
		httpx.Error(w, 500, "db_error", "Failed to query transcripts")
		return
	}
	defer rows.Close()

	chunks := []TranscriptChunk{}
	for rows.Next() {
		var c TranscriptChunk
		if err := rows.Scan(&c.ID, &c.StartSeconds, &c.EndSeconds, &c.Text, &c.Kind); err == nil {
			chunks = append(chunks, c)
		}
	}

	httpx.JSON(w, 200, map[string]any{
		"lesson_id": lessonID,
		"title":     title,
		"count":     len(chunks),
		"chunks":    chunks,
	})
}
