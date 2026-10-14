package knowledge

import (
	"context"
	"fmt"
	"os"
	"strings"
)

// TextEmbedder produces dense query/index vectors. Production default is the
// Ollama model from EMBED_MODEL / OLLAMA_EMBED_MODEL via internal/ai.
type TextEmbedder interface {
	Embed(ctx context.Context, text string) ([]float32, error)
	Name() string
	Dimension() int
}

// AIEmbedder adapts an Ollama-backed AI service to TextEmbedder.
type AIEmbedder struct {
	Model string
	Dim   int
	Fn    func(ctx context.Context, text string) ([]float32, error)
}

func (e AIEmbedder) Embed(ctx context.Context, text string) ([]float32, error) {
	if e.Fn == nil {
		return nil, fmt.Errorf("embedder not configured")
	}
	return e.Fn(ctx, text)
}

func (e AIEmbedder) Name() string {
	model := strings.TrimSpace(e.Model)
	if model == "" {
		model = DefaultEmbedModel
	}
	return "ollama:" + model
}

func (e AIEmbedder) Dimension() int {
	if e.Dim > 0 {
		return e.Dim
	}
	return 0 // unknown until first successful embed
}

// HashEmbedder is an explicitly labeled offline/test fallback (bag-of-words hashing).
// Never use as a silent substitute for the Ollama semantic embedder in production.
type HashEmbedder struct {
	Dim int
}

func (e HashEmbedder) Embed(ctx context.Context, text string) ([]float32, error) {
	_ = ctx
	dim := e.Dim
	if dim < 8 {
		dim = 384
	}
	return HashEmbed(text, dim), nil
}

func (e HashEmbedder) Name() string { return "hash" }

func (e HashEmbedder) Dimension() int {
	if e.Dim < 8 {
		return 384
	}
	return e.Dim
}

const DefaultEmbedModel = "qwen3-embedding:0.6b"

// DefaultEmbedModelFromEnv returns EMBED_MODEL, then OLLAMA_EMBED_MODEL, then default.
func DefaultEmbedModelFromEnv() string {
	if m := strings.TrimSpace(os.Getenv("EMBED_MODEL")); m != "" {
		return m
	}
	if m := strings.TrimSpace(os.Getenv("OLLAMA_EMBED_MODEL")); m != "" {
		return m
	}
	return DefaultEmbedModel
}

// EmbedderModeFromEnv returns "ollama" (default) or "hash" when explicitly requested.
func EmbedderModeFromEnv() string {
	kind := strings.ToLower(strings.TrimSpace(os.Getenv("CF_KNOWLEDGE_EMBEDDER")))
	switch kind {
	case "hash", "mock", "offline":
		return "hash"
	default:
		return "ollama"
	}
}

func resolveEmbedder(e TextEmbedder) TextEmbedder {
	if EmbedderModeFromEnv() == "hash" {
		dim := 384
		if e != nil && e.Dimension() > 0 {
			dim = e.Dimension()
		}
		return HashEmbedder{Dim: dim}
	}
	return e
}

// SameEmbedder reports whether two embedder identity strings match (name only).
func SameEmbedder(a, b string) bool {
	return strings.EqualFold(strings.TrimSpace(a), strings.TrimSpace(b))
}
