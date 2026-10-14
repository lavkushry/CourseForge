package knowledge

import (
	"context"
	"fmt"
	"strings"
	"unicode/utf8"

	"courseforge/backend/internal/identity"
)

// Generator produces grounded answers from a system/user prompt pair.
type Generator interface {
	Complete(ctx context.Context, system, user string) (string, error)
}

const (
	supportMinScore = 0.02
	askTopK         = 6
)

func (s *Service) Ask(ctx context.Context, p identity.Principal, lessonID, question string) (AskResponse, error) {
	question = strings.TrimSpace(question)
	if lessonID == "" || question == "" || utf8.RuneCountInString(question) > 2000 {
		return AskResponse{}, ErrInvalid
	}

	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return AskResponse{}, err
	}
	if err = lessonAccess(ctx, tx, p.UserID, lessonID, p.Role); err != nil {
		_ = tx.Rollback(ctx)
		return AskResponse{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return AskResponse{}, err
	}

	hits, broadened, supported := s.retrieveForAsk(ctx, lessonID, question)
	if !supported || len(hits) == 0 {
		return AskResponse{
			Answer:    AbstainMessage,
			Abstained: true,
			Support:   "not_covered",
			Citations: []AskCitation{},
			Broadened: broadened,
		}, nil
	}

	citations := make([]AskCitation, 0, len(hits))
	var contextBuilder strings.Builder
	for i, h := range hits {
		label := formatClock(h.Chunk.StartMs)
		citations = append(citations, AskCitation{
			ChunkID: h.Chunk.ID,
			StartMs: h.Chunk.StartMs,
			EndMs:   h.Chunk.EndMs,
			Label:   label,
			Text:    h.Chunk.Text,
			Score:   h.Score,
		})
		fmt.Fprintf(&contextBuilder, "\n[Excerpt %d | Time: %s]\n%s\n", i+1, label, h.Chunk.Text)
	}

	system := `You are CourseForge Living Video Knowledge. Answer ONLY using the provided video excerpts.
Every factual claim must cite a timestamp in [m:ss] form that appears in the excerpts.
If the excerpts do not support an answer, reply exactly: not covered in this video
Never invent content outside the excerpts. Do not use emojis.`

	user := fmt.Sprintf("Question: %s\n\nExcerpts:%s", question, contextBuilder.String())
	answer := ""
	if s.Generator != nil {
		if raw, genErr := s.Generator.Complete(ctx, system, user); genErr == nil {
			answer = strings.TrimSpace(raw)
		}
	}
	if answer == "" {
		answer = groundedFallback(citations)
	}
	if !answerHasCitation(answer, citations) || strings.EqualFold(strings.TrimSpace(answer), AbstainMessage) {
		if strings.EqualFold(strings.TrimSpace(answer), AbstainMessage) {
			return AskResponse{
				Answer:    AbstainMessage,
				Abstained: true,
				Support:   "not_covered",
				Citations: []AskCitation{},
				Broadened: broadened,
			}, nil
		}
		// Model omitted citations — attach support rather than hallucinating bare prose.
		answer = groundedFallback(citations)
	}
	return AskResponse{
		Answer:    answer,
		Abstained: false,
		Support:   "supported",
		Citations: citations,
		Broadened: broadened,
	}, nil
}

func (s *Service) retrieveForAsk(ctx context.Context, lessonID, question string) ([]rankedHit, bool, bool) {
	hits := s.hybridOnce(ctx, lessonID, question, askTopK)
	if gradeSupport(hits, supportMinScore) {
		return hits, false, true
	}
	broad := extractSearchKeywords(question)
	if broad == "" || strings.EqualFold(broad, question) {
		return hits, false, false
	}
	hits2 := s.hybridOnce(ctx, lessonID, broad, askTopK*2)
	if gradeSupport(hits2, supportMinScore) {
		return hits2, true, true
	}
	return hits2, true, false
}

func (s *Service) hybridOnce(ctx context.Context, lessonID, query string, limit int) []rankedHit {
	bm25, _ := s.searchBM25(ctx, lessonID, query, limit)
	var dense []Chunk
	if s.Qdrant != nil {
		vec, embedderName, dim := s.queryEmbed(ctx, lessonID, query)
		if len(vec) > 0 {
			dense, _ = s.Qdrant.search(ctx, lessonID, vec, limit, embedderName, dim)
		}
	}
	fused := reciprocalRankFusion(bm25, dense)
	return lexicalRerank(query, fused)
}

// queryEmbed uses the configured semantic embedder (Ollama EMBED_MODEL by default).
// HashEmbed is only used when CF_KNOWLEDGE_EMBEDDER=hash (offline/test).
func (s *Service) queryEmbed(ctx context.Context, lessonID, text string) ([]float32, string, int) {
	emb := resolveEmbedder(s.Embedder)
	if emb == nil {
		return nil, "", 0
	}
	// Refuse mixing: if the lesson was indexed with a different embedder, skip dense.
	if lessonID != "" && s.Pool != nil {
		var stored string
		var storedDim int
		_ = s.Pool.QueryRow(ctx, `SELECT embedder, embed_dim FROM knowledge_documents WHERE lesson_id=$1`, lessonID).
			Scan(&stored, &storedDim)
		if stored != "" && !SameEmbedder(stored, emb.Name()) {
			return nil, "", 0
		}
	}
	vec, err := emb.Embed(ctx, text)
	if err != nil || len(vec) == 0 {
		return nil, "", 0
	}
	dim := emb.Dimension()
	if dim == 0 {
		dim = len(vec)
	}
	return vec, emb.Name(), dim
}

func groundedFallback(citations []AskCitation) string {
	if len(citations) == 0 {
		return AbstainMessage
	}
	var b strings.Builder
	b.WriteString("Based on the video:\n")
	for _, c := range citations {
		snippet := c.Text
		if utf8.RuneCountInString(snippet) > 180 {
			snippet = string([]rune(snippet)[:180]) + "…"
		}
		fmt.Fprintf(&b, "- [%s] %s\n", c.Label, snippet)
	}
	return strings.TrimSpace(b.String())
}

func answerHasCitation(answer string, citations []AskCitation) bool {
	if strings.Contains(answer, AbstainMessage) && len(strings.TrimSpace(answer)) <= len(AbstainMessage)+8 {
		return false
	}
	for _, c := range citations {
		if strings.Contains(answer, "["+c.Label+"]") {
			return true
		}
	}
	// Also accept zero-padded mm:ss variants.
	for _, c := range citations {
		total := c.StartMs / 1000
		padded := fmt.Sprintf("[%02d:%02d]", total/60, total%60)
		if strings.Contains(answer, padded) {
			return true
		}
	}
	return false
}
