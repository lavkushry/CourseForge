package knowledge

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

type qdrantClient struct {
	base       string
	collection string
	http       *http.Client
}

func newQdrantFromEnv() *qdrantClient {
	base := strings.TrimSpace(os.Getenv("CF_QDRANT_URL"))
	if base == "" {
		base = strings.TrimSpace(os.Getenv("QDRANT_URL"))
	}
	if base == "" {
		base = "http://127.0.0.1:6333"
	}
	collection := strings.TrimSpace(os.Getenv("CF_QDRANT_COLLECTION"))
	if collection == "" || collection == "courseforge_chunks" || collection == "courseforge_living_video" {
		collection = QdrantCollection
	}
	return &qdrantClient{
		base:       strings.TrimRight(base, "/"),
		collection: collection,
		http:       &http.Client{Timeout: 8 * time.Second},
	}
}

type collectionMeta struct {
	Embedder string `json:"embedder"`
	Dim      int    `json:"dim"`
}

func (c *qdrantClient) getCollectionMeta(ctx context.Context) (collectionMeta, error) {
	var meta collectionMeta
	if c == nil {
		return meta, nil
	}
	url := fmt.Sprintf("%s/collections/%s", c.base, c.collection)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return meta, err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return meta, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return meta, nil
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return meta, fmt.Errorf("qdrant collection status %d", resp.StatusCode)
	}
	var parsed struct {
		Result struct {
			Config struct {
				Params struct {
					Vectors struct {
						Size int `json:"size"`
					} `json:"vectors"`
				} `json:"params"`
			} `json:"config"`
			PayloadSchema map[string]any `json:"payload_schema"`
			// Collection-level metadata written by the worker.
			Metadata map[string]any `json:"metadata"`
		} `json:"result"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return meta, err
	}
	meta.Dim = parsed.Result.Config.Params.Vectors.Size
	if parsed.Result.Metadata != nil {
		meta.Embedder = asString(parsed.Result.Metadata["embedder"])
		if d := asInt(parsed.Result.Metadata["dim"]); d > 0 {
			meta.Dim = d
		}
	}
	return meta, nil
}

func (c *qdrantClient) search(ctx context.Context, lessonID string, vector []float32, limit int, embedder string, dim int) ([]Chunk, error) {
	if c == nil || len(vector) == 0 || lessonID == "" {
		return nil, nil
	}
	if limit < 1 {
		limit = 6
	}
	if embedder != "" {
		meta, err := c.getCollectionMeta(ctx)
		if err == nil && meta.Embedder != "" && !SameEmbedder(meta.Embedder, embedder) {
			return nil, fmt.Errorf("embedder mismatch: collection=%s query=%s", meta.Embedder, embedder)
		}
		if dim > 0 && meta.Dim > 0 && meta.Dim != dim {
			return nil, fmt.Errorf("embed dim mismatch: collection=%d query=%d", meta.Dim, dim)
		}
		if dim > 0 && len(vector) != dim {
			return nil, fmt.Errorf("vector dim %d != expected %d", len(vector), dim)
		}
	}
	must := []map[string]any{
		{"key": "lesson_id", "match": map[string]any{"value": lessonID}},
	}
	if embedder != "" {
		must = append(must, map[string]any{
			"key": "embedder", "match": map[string]any{"value": embedder},
		})
	}
	body := map[string]any{
		"vector":       vector,
		"limit":        limit,
		"with_payload": true,
		"filter":       map[string]any{"must": must},
	}
	raw, _ := json.Marshal(body)
	url := fmt.Sprintf("%s/collections/%s/points/search", c.base, c.collection)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	payload, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("qdrant search status %d", resp.StatusCode)
	}
	var parsed struct {
		Result []struct {
			Score   float64        `json:"score"`
			Payload map[string]any `json:"payload"`
		} `json:"result"`
	}
	if err := json.Unmarshal(payload, &parsed); err != nil {
		return nil, err
	}
	out := make([]Chunk, 0, len(parsed.Result))
	for _, hit := range parsed.Result {
		p := hit.Payload
		if p == nil {
			continue
		}
		if embedder != "" {
			if pe := asString(p["embedder"]); pe != "" && !SameEmbedder(pe, embedder) {
				continue
			}
		}
		chunk := Chunk{
			ID:      asString(p["chunk_id"]),
			Text:    asString(p["text"]),
			Source:  asString(p["source"]),
			StartMs: asInt(p["start_ms"]),
			EndMs:   asInt(p["end_ms"]),
			Ordinal: asInt(p["ordinal"]),
			Score:   hit.Score,
		}
		if chunk.ID == "" {
			continue
		}
		out = append(out, chunk)
	}
	return out, nil
}

func asString(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case fmt.Stringer:
		return t.String()
	default:
		return ""
	}
}

func asInt(v any) int {
	switch t := v.(type) {
	case float64:
		return int(t)
	case int:
		return t
	case json.Number:
		n, _ := t.Int64()
		return int(n)
	default:
		return 0
	}
}
