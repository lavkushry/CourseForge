package ai

import (
	"context"
	"net/http"
	"os"
	"strings"
	"time"

	"courseforge/backend/internal/httpx"
)

func (s *Service) status(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	var vectorCount int64
	var chunkCount int64
	_ = s.Pool.QueryRow(ctx, "SELECT count(*) FROM lesson_embeddings").Scan(&vectorCount)
	_ = s.Pool.QueryRow(ctx, "SELECT count(*) FROM transcript_chunks").Scan(&chunkCount)

	pgvectorActive := false
	_ = s.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'vector')`).Scan(&pgvectorActive)

	vectorDimensions := 0
	if pgvectorActive {
		vectorDimensions = 1024
	}

	ollamaOnline := false
	resp, err := s.HTTPClient.Get(s.OllamaURL + "/api/tags")
	if err == nil {
		resp.Body.Close()
		ollamaOnline = resp.StatusCode == 200
	}

	qdrantURL := strings.TrimRight(strings.TrimSpace(os.Getenv("CF_QDRANT_URL")), "/")
	if qdrantURL == "" {
		qdrantURL = strings.TrimRight(strings.TrimSpace(os.Getenv("QDRANT_URL")), "/")
	}
	qdrantConfigured := qdrantURL != ""
	qdrantOnline := false
	if qdrantConfigured {
		qResp, qErr := s.HTTPClient.Get(qdrantURL + "/readyz")
		if qErr == nil {
			qResp.Body.Close()
			qdrantOnline = qResp.StatusCode == 200
		}
	}

	httpx.JSON(w, 200, map[string]any{
		"pgvector_active":        pgvectorActive,
		"vector_dimensions":      vectorDimensions,
		"embeddings_count":       vectorCount,
		"transcript_chunks":      chunkCount,
		"ollama_online":          ollamaOnline,
		"ollama_embedding_model": s.EmbeddingModel,
		"ollama_chat_model":      s.ChatModel,
		"qdrant_configured":      qdrantConfigured,
		"qdrant_online":          qdrantOnline,
	})
}
