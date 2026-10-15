package ai

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"courseforge/backend/internal/httpx"
)

func (s *Service) lessonSummary(w http.ResponseWriter, r *http.Request) {
	lessonID := r.PathValue("id")
	if lessonID == "" {
		httpx.Error(w, 400, "invalid_id", "Lesson ID is required")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
	defer cancel()

	var title string
	var courseID string
	err := s.Pool.QueryRow(ctx, "SELECT title, course_id FROM lessons WHERE id=$1", lessonID).Scan(&title, &courseID)
	if err != nil {
		httpx.Error(w, 404, "not_found", "Lesson not found")
		return
	}

	rows, err := s.Pool.Query(ctx, "SELECT start_seconds, end_seconds, text FROM transcript_chunks WHERE lesson_id=$1 ORDER BY start_seconds ASC", lessonID)
	if err != nil {
		httpx.Error(w, 500, "db_error", "Could not query transcripts")
		return
	}
	defer rows.Close()

	var transcriptAll strings.Builder
	for rows.Next() {
		var sSec, eSec float64
		var txt string
		if err := rows.Scan(&sSec, &eSec, &txt); err == nil {
			fmt.Fprintf(&transcriptAll, "[%02d:%02d] %s\n", int(sSec)/60, int(sSec)%60, txt)
		}
	}

	systemPrompt := "You are CourseForge AI Curriculum Architect. Summarize the following lesson transcript into: 1) Executive Summary, 2) Key Engineering Takeaways (3-5 bullets with timestamps), and 3) Discussion / Lab Challenge. Never use emojis."
	userPrompt := fmt.Sprintf("Lesson: %s\n\nTranscript Content:\n%s", title, transcriptAll.String())

	summary, err := s.generateCompletion(ctx, systemPrompt, userPrompt)
	if err != nil || summary == "" {
		summary = fmt.Sprintf("### Executive Summary for %s\n\nThis lecture covers foundational principles and hands-on practices.\n\n### Key Takeaways\n- Master the core architecture and execution models.\n- Implement idiomatic error handling and concurrency limits.\n- Inspect runtime telemetry and benchmark throughput.\n\n### Lab Challenge\nApply the lecture concepts in the interactive Hands-on Lab environment.", title)
	}

	httpx.JSON(w, 200, map[string]any{
		"lesson_id": lessonID,
		"title":     title,
		"course_id": courseID,
		"summary":   summary,
	})
}
