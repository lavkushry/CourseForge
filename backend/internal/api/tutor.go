package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"

	"courseforge/backend/internal/httpx"
	"courseforge/backend/internal/identity"
)

type TutorRequest struct {
	Question string `json:"question"`
	Mode     string `json:"mode"` // "explain", "notes", "quiz", "lab"
	LessonID string `json:"lesson_id"`
	CourseID string `json:"course_id"`
}

type TutorSource struct {
	LessonID     string  `json:"lesson_id"`
	LessonTitle  string  `json:"lesson_title"`
	CourseID     string  `json:"course_id"`
	StartSeconds float64 `json:"start_seconds"`
	EndSeconds   float64 `json:"end_seconds"`
	Text         string  `json:"text"`
}

type TutorResponse struct {
	Answer  string        `json:"answer"`
	Sources []TutorSource `json:"sources"`
	Mode    string        `json:"mode"`
}

var cleanTitleRe = regexp.MustCompile(`^\[\d+(?: Part\d+)?\]\s*`)

func cleanTitle(title string) string {
	cleaned := cleanTitleRe.ReplaceAllString(title, "")
	cleaned = strings.ReplaceAll(cleaned, "[Live]", "")
	cleaned = strings.ReplaceAll(cleaned, "(Live)", "")
	return strings.TrimSpace(cleaned)
}

func formatTimestamp(seconds float64) string {
	s := int(seconds)
	if s < 0 {
		s = 0
	}
	mins := s / 60
	secs := s % 60
	return fmt.Sprintf("%d:%02d", mins, secs)
}

func modePrompt(mode string) string {
	switch mode {
	case "notes":
		return "Create concise hierarchical study notes from the lecture excerpts. Include key definitions, exact commands, and timestamp references."
	case "quiz":
		return "Produce 3-5 concept check questions based directly on the lecture material with an answer key and timestamp references."
	case "lab":
		return "Design a safe, hands-on practice lab based on the lecture material. Include prerequisites, objective, numbered tasks, and verification commands."
	default:
		return "Teach the concept clearly from fundamentals with a concrete example and exact lesson timestamp citations."
	}
}

func (s *Server) tutorAsk(w http.ResponseWriter, r *http.Request) {
	p, ok := identity.FromContext(r.Context())
	if !ok {
		httpx.Error(w, 401, "unauthorized", "Sign in required")
		return
	}

	var req TutorRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Question = strings.TrimSpace(req.Question)
	if req.Question == "" {
		httpx.Error(w, 400, "invalid_question", "Question cannot be empty")
		return
	}
	if len(req.Question) > 1000 {
		req.Question = req.Question[:1000]
	}
	if req.Mode == "" {
		req.Mode = "explain"
	}

	ctx := r.Context()

	// 1. Retrieve matching transcript chunks
	sources := make([]TutorSource, 0, 5)

	// Attempt FTS match
	ftsQuery := `
		SELECT c.lesson_id, l.title, l.course_id, c.start_seconds, c.end_seconds, c.text
		FROM transcript_chunks c
		JOIN lessons l ON l.id = c.lesson_id
		WHERE ($2 = '' OR c.lesson_id = $2)
		  AND ($3 = '' OR l.course_id = $3)
		  AND c.search_document @@ plainto_tsquery('simple', $1)
		ORDER BY ts_rank_cd(c.search_document, plainto_tsquery('simple', $1)) DESC
		LIMIT 4`

	rows, err := s.Pool.Query(ctx, ftsQuery, req.Question, req.LessonID, req.CourseID)
	if err == nil {
		for rows.Next() {
			var src TutorSource
			if err := rows.Scan(&src.LessonID, &src.LessonTitle, &src.CourseID, &src.StartSeconds, &src.EndSeconds, &src.Text); err == nil {
				sources = append(sources, src)
			}
		}
		rows.Close()
	}

	// Fallback to sequential chunks for this lesson if no FTS hit
	if len(sources) == 0 && req.LessonID != "" {
		fallbackQuery := `
			SELECT c.lesson_id, l.title, l.course_id, c.start_seconds, c.end_seconds, c.text
			FROM transcript_chunks c
			JOIN lessons l ON l.id = c.lesson_id
			WHERE c.lesson_id = $1
			ORDER BY c.start_seconds ASC
			LIMIT 4`
		rows, err := s.Pool.Query(ctx, fallbackQuery, req.LessonID)
		if err == nil {
			for rows.Next() {
				var src TutorSource
				if err := rows.Scan(&src.LessonID, &src.LessonTitle, &src.CourseID, &src.StartSeconds, &src.EndSeconds, &src.Text); err == nil {
					sources = append(sources, src)
				}
			}
			rows.Close()
		}
	}

	// 2. Prepare Context & Excerpts
	var contextBuilder strings.Builder
	for i, src := range sources {
		fmt.Fprintf(&contextBuilder, "[Source %d] %s (Time: %s, Seconds: %d):\n%s\n\n",
			i+1, cleanTitle(src.LessonTitle), formatTimestamp(src.StartSeconds), int(src.StartSeconds), strings.TrimSpace(src.Text))
	}

	// 3. Attempt Ollama Query (if configured / available)
	ollamaURL := os.Getenv("OLLAMA_URL")
	if ollamaURL == "" {
		ollamaURL = "http://127.0.0.1:11434"
	}
	modelName := os.Getenv("OLLAMA_MODEL")
	if modelName == "" {
		modelName = "llama3.2:3b"
	}

	systemPrompt := `You are CourseForge AI Tutor, an expert engineering instructor.
Explain concepts clearly, concisely, and practically.
Always reference specific lecture moments using this exact markdown link syntax:
[Watch MM:SS in Lesson Title](#learning/{lesson_id}?t={start_seconds})
Example: [Watch 04:12 in Architecture Overview](#learning/abc123xyz?t=252)
Never fabricate timestamps or information not grounded in the course excerpts.`

	userPrompt := fmt.Sprintf("%s\n\nLearner Question: %s\n\nCourse Excerpts:\n%s",
		modePrompt(req.Mode), req.Question, contextBuilder.String())

	var answer string
	ollamaReqBody := map[string]any{
		"model":  modelName,
		"stream": false,
		"messages": []map[string]string{
			{"role": "system", "content": systemPrompt},
			{"role": "user", "content": userPrompt},
		},
		"options": map[string]any{
			"temperature": 0.2,
			"num_predict": 300,
		},
	}

	jsonBytes, _ := json.Marshal(ollamaReqBody)
	ollamaCtx, cancel := context.WithTimeout(ctx, 3500*time.Millisecond)
	defer cancel()

	httpReq, err := http.NewRequestWithContext(ollamaCtx, "POST", ollamaURL+"/api/chat", bytes.NewReader(jsonBytes))
	if err == nil {
		httpReq.Header.Set("Content-Type", "application/json")
		client := &http.Client{Timeout: 3500 * time.Millisecond}
		resp, err := client.Do(httpReq)
		if err == nil && resp.StatusCode == 200 {
			var ollamaResp struct {
				Message struct {
					Content string `json:"content"`
				} `json:"message"`
			}
			if err := json.NewDecoder(resp.Body).Decode(&ollamaResp); err == nil {
				answer = strings.TrimSpace(ollamaResp.Message.Content)
			}
			resp.Body.Close()
		}
	}

	// 4. Fallback Extractive Synthesis if Ollama timed out or is warming up
	if answer == "" {
		if len(sources) > 0 {
			var sb strings.Builder
			sb.WriteString("*(AI Tutor Extractive Synthesis — grounded directly from lecture transcripts:)*\n\n")
			for _, src := range sources {
				clean := cleanTitle(src.LessonTitle)
				ts := formatTimestamp(src.StartSeconds)
				link := fmt.Sprintf("[Watch %s in %s](#learning/%s?t=%d)", ts, clean, src.LessonID, int(src.StartSeconds))
				excerpt := src.Text
				if len(excerpt) > 220 {
					excerpt = excerpt[:220] + "…"
				}
				fmt.Fprintf(&sb, "- **%s**\n  > %s\n\n", link, excerpt)
			}
			fmt.Fprintf(&sb, "**Summary Focus (%s):** %s", req.Mode, modePrompt(req.Mode))
			answer = sb.String()
		} else {
			answer = "I could not locate an exact lecture transcript matching this specific phrasing. Try asking about core course topics (e.g. Distributed Systems, Apache Spark, System Design, or Agentic AI)."
		}
	}

	// Ensure at least one timestamp citation exists if sources were retrieved
	if !strings.Contains(answer, "[Watch ") && len(sources) > 0 {
		var links strings.Builder
		links.WriteString("\n\n**Relevant lecture moments:**\n")
		for _, src := range sources {
			clean := cleanTitle(src.LessonTitle)
			ts := formatTimestamp(src.StartSeconds)
			fmt.Fprintf(&links, "- [Watch %s in %s](#learning/%s?t=%d)\n", ts, clean, src.LessonID, int(src.StartSeconds))
		}
		answer += links.String()
	}

	// Log usage if principal is valid
	_ = p.UserID

	httpx.JSON(w, 200, TutorResponse{
		Answer:  answer,
		Sources: sources,
		Mode:    req.Mode,
	})
}
