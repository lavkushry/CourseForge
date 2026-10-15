package ai

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"courseforge/backend/internal/httpx"
)

func (s *Service) tutorAsk(w http.ResponseWriter, r *http.Request) {
	var req TutorRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.Question) == "" {
		httpx.Error(w, 400, "invalid_request", "Question is required")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 40*time.Second)
	defer cancel()

	citations := s.findRelevantCitations(ctx, req.CourseID, req.LessonID, req.Question, 4)

	var contextBuilder strings.Builder
	for i, c := range citations {
		fmt.Fprintf(&contextBuilder, "\n[Excerpt %d | Lesson: %s | Time: %02d:%02d]\n\"%s\"\n",
			i+1, c.LessonTitle, int(c.StartSeconds)/60, int(c.StartSeconds)%60, c.Text)
	}

	modeInstruction := "Provide a clear, detailed conceptual explanation."
	switch req.Mode {
	case "socratic":
		modeInstruction = "Guide the student with thoughtful questions and hints without immediately giving the final answer."
	case "code":
		modeInstruction = "Provide concrete, idiomatic, high-performance code examples with line-by-line commentary."
	case "quiz":
		modeInstruction = "Ask a challenging question testing comprehension of the topic, and evaluate the student's answer."
	}

	systemPrompt := fmt.Sprintf(`You are CourseForge AI Tutor, an exceptionally knowledgeable pair programming and engineering mentor.
%s
Base your answer on the following lecture transcripts when applicable. When referring to concepts discussed in the lecture, cite the exact timestamp format [MM:SS] so the learner can jump to the video.
Never use emojis. Format all code in proper markdown code blocks.

Relevant Lecture Excerpts:
%s`, modeInstruction, contextBuilder.String())

	answer, err := s.generateCompletion(ctx, systemPrompt, req.Question)
	if err != nil {
		// Provide high quality structured fallback if model was offline
		answer = fmt.Sprintf("Based on the course materials for %s:\n\n%s\n\nRefer to video timestamps above for detailed walkthroughs.",
			req.LessonID, citationsFallbackSummary(citations, req.Question))
	}

	httpx.JSON(w, 200, TutorResponse{
		Answer:    answer,
		Mode:      req.Mode,
		Citations: citations,
	})
}

func extractSearchKeywords(q string) string {
	stopWords := map[string]bool{
		"what": true, "is": true, "an": true, "a": true, "the": true, "in": true, "of": true,
		"for": true, "how": true, "why": true, "does": true, "do": true, "can": true,
		"to": true, "and": true, "or": true, "with": true, "by": true, "on": true,
		"at": true, "from": true, "explain": true, "describe": true, "tell": true,
		"me": true, "about": true, "difference": true, "between": true, "vs": true,
	}
	words := strings.Fields(strings.Map(func(r rune) rune {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
			return r
		}
		return ' '
	}, q))
	var result []string
	for _, w := range words {
		if !stopWords[strings.ToLower(w)] && len(w) > 1 {
			result = append(result, w)
		}
	}
	if len(result) == 0 {
		return q
	}
	return strings.Join(result, " ")
}

func (s *Service) findRelevantCitations(ctx context.Context, courseID, lessonID, question string, limit int) []Citation {
	var citations []Citation

	// First try pgvector cosine similarity if embedding model responds
	embCtx, embCancel := context.WithTimeout(ctx, 4*time.Second)
	emb, err := s.generateEmbedding(embCtx, question)
	embCancel()

	if err == nil && len(emb) == 1024 {
		vecStr := formatVector(emb)
		query := `
			SELECT e.chunk_id, e.lesson_id, COALESCE(l.title, ''), t.start_seconds, t.end_seconds, t.text,
			       1 - (e.embedding <=> $1::vector) AS similarity
			FROM lesson_embeddings e
			JOIN transcript_chunks t ON t.id = e.chunk_id
			JOIN lessons l ON l.id = e.lesson_id
			WHERE ($2 = '' OR l.course_id = $2)
			  AND ($3 = '' OR l.id = $3)
			ORDER BY e.embedding <=> $1::vector
			LIMIT $4
		`
		rows, qErr := s.Pool.Query(ctx, query, vecStr, courseID, lessonID, limit)
		if qErr == nil {
			defer rows.Close()
			for rows.Next() {
				var c Citation
				if err := rows.Scan(&c.ChunkID, &c.LessonID, &c.LessonTitle, &c.StartSeconds, &c.EndSeconds, &c.Text, &c.Similarity); err == nil {
					citations = append(citations, c)
				}
			}
		}
	}

	// If vector returned few or no rows, fall back to PostgreSQL full-text search
	if len(citations) < 2 {
		dbCtx := ctx
		var dbCancel context.CancelFunc
		if ctx.Err() != nil {
			dbCtx, dbCancel = context.WithTimeout(context.Background(), 5*time.Second)
			defer dbCancel()
		}

		cleanKeywords := extractSearchKeywords(question)
		query := `
			SELECT t.id, t.lesson_id, COALESCE(l.title, ''), t.start_seconds, t.end_seconds, t.text
			FROM transcript_chunks t
			JOIN lessons l ON l.id = t.lesson_id
			WHERE ($1 = '' OR l.course_id = $1)
			  AND ($2 = '' OR l.id = $2)
			  AND (
			       t.search_document @@ websearch_to_tsquery('simple', $3)
			    OR (length($4) > 1 AND t.search_document @@ plainto_tsquery('simple', $4))
			    OR (length($4) > 2 AND t.text ILIKE '%' || $4 || '%')
			    OR t.text ILIKE '%' || $3 || '%'
			  )
			ORDER BY t.start_seconds ASC
			LIMIT $5
		`
		rows, qErr := s.Pool.Query(dbCtx, query, courseID, lessonID, question, cleanKeywords, limit)
		if qErr == nil {
			defer rows.Close()
			for rows.Next() {
				var c Citation
				if err := rows.Scan(&c.ChunkID, &c.LessonID, &c.LessonTitle, &c.StartSeconds, &c.EndSeconds, &c.Text); err == nil {
					// Avoid duplicates
					exists := false
					for _, existing := range citations {
						if existing.ChunkID == c.ChunkID {
							exists = true
							break
						}
					}
					if !exists {
						citations = append(citations, c)
					}
				}
			}
		}
	}

	// If still empty and lessonID specified, fetch the first few chunks of the lesson
	if len(citations) == 0 && lessonID != "" {
		dbCtx := ctx
		var dbCancel context.CancelFunc
		if ctx.Err() != nil {
			dbCtx, dbCancel = context.WithTimeout(context.Background(), 5*time.Second)
			defer dbCancel()
		}

		query := `
			SELECT t.id, t.lesson_id, COALESCE(l.title, ''), t.start_seconds, t.end_seconds, t.text
			FROM transcript_chunks t
			JOIN lessons l ON l.id = t.lesson_id
			WHERE l.id = $1
			ORDER BY t.start_seconds ASC
			LIMIT $2
		`
		rows, qErr := s.Pool.Query(dbCtx, query, lessonID, limit)
		if qErr == nil {
			defer rows.Close()
			for rows.Next() {
				var c Citation
				if err := rows.Scan(&c.ChunkID, &c.LessonID, &c.LessonTitle, &c.StartSeconds, &c.EndSeconds, &c.Text); err == nil {
					citations = append(citations, c)
				}
			}
		}
	}

	return citations
}

func citationsFallbackSummary(citations []Citation, q string) string {
	if len(citations) == 0 {
		return "Please consult the course overview and review the relevant lecture modules."
	}
	var sb strings.Builder
	for _, c := range citations {
		m := int(c.StartSeconds) / 60
		sec := int(c.StartSeconds) % 60
		fmt.Fprintf(&sb, "- [%02d:%02d] %s: %s\n", m, sec, c.LessonTitle, c.Text)
	}
	return sb.String()
}
