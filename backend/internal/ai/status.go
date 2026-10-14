package ai

import (
	"context"
	"net/http"
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

	ollamaOnline := false
	resp, err := s.HTTPClient.Get(s.OllamaURL + "/api/tags")
	if err == nil {
		resp.Body.Close()
		ollamaOnline = resp.StatusCode == 200
	}

	httpx.JSON(w, 200, map[string]any{
		"pgvector_active":        true,
		"vector_dimensions":      1024,
		"embeddings_count":       vectorCount,
		"transcript_chunks":      chunkCount,
		"ollama_online":          ollamaOnline,
		"ollama_embedding_model": s.EmbeddingModel,
		"ollama_chat_model":      s.ChatModel,
	})
}
