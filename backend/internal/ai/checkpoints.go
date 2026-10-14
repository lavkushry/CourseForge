package ai

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"courseforge/backend/internal/httpx"
)

type VideoCheckpoint struct {
	ID                 string   `json:"id"`
	LessonID           string   `json:"lesson_id"`
	TimestampSeconds   float64  `json:"timestamp_seconds"`
	Prompt             string   `json:"prompt"`
	Options            []string `json:"options"`
	CorrectOptionIndex int      `json:"correct_option_index"`
	Explanation        string   `json:"explanation"`
}

func (s *Service) lessonCheckpoints(w http.ResponseWriter, r *http.Request) {
	lessonID := r.PathValue("id")
	if lessonID == "" {
		httpx.Error(w, 400, "invalid_id", "Lesson ID is required")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	rows, err := s.Pool.Query(ctx, `
		SELECT id, lesson_id, timestamp_seconds, prompt, options, correct_option_index, explanation
		FROM interactive_video_checkpoints
		WHERE lesson_id = $1
		ORDER BY timestamp_seconds ASC
	`, lessonID)
	if err != nil {
		httpx.JSON(w, 200, map[string]any{"lesson_id": lessonID, "checkpoints": []VideoCheckpoint{}})
		return
	}
	defer rows.Close()

	var checkpoints []VideoCheckpoint
	for rows.Next() {
		var cp VideoCheckpoint
		var optsJSON []byte
		if err := rows.Scan(&cp.ID, &cp.LessonID, &cp.TimestampSeconds, &cp.Prompt, &optsJSON, &cp.CorrectOptionIndex, &cp.Explanation); err == nil {
			_ = json.Unmarshal(optsJSON, &cp.Options)
			checkpoints = append(checkpoints, cp)
		}
	}
	if checkpoints == nil {
		checkpoints = []VideoCheckpoint{}
	}

	httpx.JSON(w, 200, map[string]any{
		"lesson_id":   lessonID,
		"checkpoints": checkpoints,
		"count":       len(checkpoints),
	})
}
