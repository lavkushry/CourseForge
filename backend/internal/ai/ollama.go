package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

func (s *Service) generateEmbedding(ctx context.Context, text string) ([]float32, error) {
	reqBody, _ := json.Marshal(map[string]any{
		"model":  s.EmbeddingModel,
		"prompt": text,
	})
	req, err := http.NewRequestWithContext(ctx, "POST", s.OllamaURL+"/api/embeddings", bytes.NewReader(reqBody))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := s.HTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("ollama embeddings returned status %d: %s", resp.StatusCode, string(body))
	}

	var res struct {
		Embedding []float32 `json:"embedding"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		return nil, err
	}
	return res.Embedding, nil
}

func formatVector(v []float32) string {
	var sb strings.Builder
	sb.WriteByte('[')
	for i, f := range v {
		if i > 0 {
			sb.WriteByte(',')
		}
		fmt.Fprintf(&sb, "%g", f)
	}
	sb.WriteByte(']')
	return sb.String()
}

// Complete runs a bounded chat completion against the configured Ollama model.
// Callers must treat failures as unavailable and apply their own fallbacks.
func (s *Service) Complete(ctx context.Context, systemPrompt, userPrompt string) (string, error) {
	return s.generateCompletion(ctx, systemPrompt, userPrompt)
}

func (s *Service) generateCompletion(ctx context.Context, systemPrompt, userPrompt string) (string, error) {
	reqBody, _ := json.Marshal(map[string]any{
		"model":  s.ChatModel,
		"prompt": userPrompt,
		"system": systemPrompt,
		"stream": false,
		"options": map[string]any{
			"temperature": 0.1,
			"num_predict": 400,
		},
	})
	req, err := http.NewRequestWithContext(ctx, "POST", s.OllamaURL+"/api/generate", bytes.NewReader(reqBody))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := s.HTTPClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("ollama generate returned status %d", resp.StatusCode)
	}

	var res struct {
		Response string `json:"response"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		return "", err
	}
	return strings.TrimSpace(res.Response), nil
}
