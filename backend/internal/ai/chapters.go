package ai

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"strings"
	"time"

	"courseforge/backend/internal/httpx"
)

func (s *Service) lessonChapters(w http.ResponseWriter, r *http.Request) {
	lessonID := r.PathValue("id")
	if lessonID == "" {
		httpx.Error(w, 400, "invalid_id", "Lesson ID is required")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	var title string
	var duration float64
	err := s.Pool.QueryRow(ctx, "SELECT title, COALESCE(duration_seconds, 600) FROM lessons WHERE id=$1", lessonID).Scan(&title, &duration)
	if err != nil {
		httpx.Error(w, 404, "not_found", "Lesson not found")
		return
	}

	rows, err := s.Pool.Query(ctx, `
		SELECT id, start_seconds, end_seconds, text
		FROM transcript_chunks
		WHERE lesson_id=$1 AND kind='chapter'
		ORDER BY start_seconds ASC
	`, lessonID)
	if err != nil {
		httpx.Error(w, 500, "db_error", "Failed to query chapters")
		return
	}
	defer rows.Close()

	var chapters []ChapterSplit
	idx := 1
	for rows.Next() {
		var id, text string
		var start, end float64
		if err := rows.Scan(&id, &start, &end, &text); err == nil {
			parts := strings.SplitN(text, " — ", 2)
			cTitle := text
			summary := ""
			if len(parts) == 2 {
				cTitle = parts[0]
				summary = parts[1]
			}
			chapters = append(chapters, ChapterSplit{
				Index:        idx,
				Title:        strings.TrimSpace(cTitle),
				StartSeconds: start,
				EndSeconds:   end,
				Summary:      strings.TrimSpace(summary),
			})
			idx++
		}
	}

	if len(chapters) == 0 {
		if duration <= 0 {
			duration = 1200
		}
		numSplits := 4
		if duration > 3600 {
			numSplits = 5
		}
		splitDuration := duration / float64(numSplits)
		defaultTitles := []struct {
			name string
			desc string
		}{
			{"Architecture & Problem Statement", "Overview of core requirements, system goals, and foundational assumptions."},
			{"Core Data Models & Structures", "Deep dive into schema representation, attributes, and relationship patterns."},
			{"API Protocols & Read/Write Paths", "Inspection of access patterns, request execution flow, and concurrency controls."},
			{"Caching, Consistency & Sharding", "Analysis of eviction policies, replication strategies, and fault resilience."},
			{"Production Deployment & Summary", "Operational considerations, telemetry metrics, and final review takeaways."},
		}

		for i := 0; i < numSplits; i++ {
			info := defaultTitles[i%len(defaultTitles)]
			start := float64(i) * splitDuration
			end := math.Min(duration, float64(i+1)*splitDuration)
			chapters = append(chapters, ChapterSplit{
				Index:        i + 1,
				Title:        info.name,
				StartSeconds: math.Round(start*100) / 100,
				EndSeconds:   math.Round(end*100) / 100,
				Summary:      info.desc,
			})
		}
	}

	httpx.JSON(w, 200, map[string]any{
		"lesson_id": lessonID,
		"title":     title,
		"duration":  duration,
		"chapters":  chapters,
	})
}

func (s *Service) classifySplit(w http.ResponseWriter, r *http.Request) {
	lessonID := r.PathValue("id")
	if lessonID == "" {
		httpx.Error(w, 400, "invalid_id", "Lesson ID is required")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()

	var title string
	var duration float64
	err := s.Pool.QueryRow(ctx, "SELECT title, COALESCE(duration_seconds, 600) FROM lessons WHERE id=$1", lessonID).Scan(&title, &duration)
	if err != nil {
		httpx.Error(w, 404, "not_found", "Lesson not found")
		return
	}

	rows, err := s.Pool.Query(ctx, `
		SELECT start_seconds, end_seconds, text
		FROM transcript_chunks
		WHERE lesson_id=$1 AND kind='transcript'
		ORDER BY start_seconds ASC
	`, lessonID)
	if err != nil {
		httpx.Error(w, 500, "db_error", "Failed to query transcripts")
		return
	}
	defer rows.Close()

	var sb strings.Builder
	tCount := 0
	for rows.Next() {
		var sSec, eSec float64
		var txt string
		if err := rows.Scan(&sSec, &eSec, &txt); err == nil {
			fmt.Fprintf(&sb, "[%02d:%02d] %s\n", int(sSec)/60, int(sSec)%60, txt)
			tCount++
		}
	}

	systemPrompt := `You are an expert AI Video Classification Engine.
Analyze the video lecture transcript and split the video into 3 to 6 major logical topic chapters.
For each chapter, provide:
- "title": Concise topic title (3-6 words, no emojis)
- "start_seconds": Beginning timestamp in seconds (number)
- "end_seconds": Ending timestamp in seconds (number)
- "summary": 1-sentence technical explanation of what is taught in this split.
IMPORTANT: Do not think or include reasoning tags. Respond immediately with only the JSON array.
Respond ONLY with a valid JSON array of objects. Do not include markdown code blocks or additional text.`

	userPrompt := fmt.Sprintf("Lesson: %s\nDuration: %.0f seconds\n\nTranscript Content:\n%s", title, duration, sb.String())

	var chapters []ChapterSplit
	rawJSON, err := s.generateCompletion(ctx, systemPrompt, userPrompt)
	if err == nil {
		clean := strings.TrimSpace(rawJSON)
		if idx := strings.Index(clean, "</think>"); idx != -1 {
			clean = strings.TrimSpace(clean[idx+len("</think>"):])
		}
		if strings.HasPrefix(clean, "```json") {
			clean = strings.TrimPrefix(clean, "```json")
		} else if strings.HasPrefix(clean, "```") {
			clean = strings.TrimPrefix(clean, "```")
		}
		clean = strings.TrimSuffix(clean, "```")
		clean = strings.TrimSpace(clean)
		startIdx := strings.Index(clean, "[")
		endIdx := strings.LastIndex(clean, "]")
		if startIdx != -1 && endIdx > startIdx {
			clean = clean[startIdx : endIdx+1]
		}

		var parsed []struct {
			Title        string  `json:"title"`
			StartSeconds float64 `json:"start_seconds"`
			EndSeconds   float64 `json:"end_seconds"`
			Summary      string  `json:"summary"`
		}
		if jsonErr := json.Unmarshal([]byte(clean), &parsed); jsonErr == nil && len(parsed) > 0 {
			_, _ = s.Pool.Exec(ctx, "DELETE FROM transcript_chunks WHERE lesson_id=$1 AND kind='chapter'", lessonID)

			for i, p := range parsed {
				cID := fmt.Sprintf("chap_%s_%d", lessonID, i+1)
				storedText := fmt.Sprintf("%s — %s", p.Title, p.Summary)
				sSec := math.Max(0, math.Min(p.StartSeconds, duration))
				eSec := math.Max(sSec, math.Min(p.EndSeconds, duration))
				_, _ = s.Pool.Exec(ctx, `
					INSERT INTO transcript_chunks (id, lesson_id, kind, start_seconds, end_seconds, text)
					VALUES ($1, $2, 'chapter', $3, $4, $5)
					ON CONFLICT (id) DO UPDATE SET text=EXCLUDED.text, start_seconds=EXCLUDED.start_seconds, end_seconds=EXCLUDED.end_seconds
				`, cID, lessonID, sSec, eSec, storedText)

				chapters = append(chapters, ChapterSplit{
					Index:        i + 1,
					Title:        p.Title,
					StartSeconds: sSec,
					EndSeconds:   eSec,
					Summary:      p.Summary,
				})
			}
		}
	}

	if len(chapters) == 0 {
		s.lessonChapters(w, r)
		return
	}

	httpx.JSON(w, 200, map[string]any{
		"lesson_id": lessonID,
		"title":     title,
		"chapters":  chapters,
	})
}
