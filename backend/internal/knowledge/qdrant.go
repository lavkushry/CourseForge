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

func (c *qdrantClient) search(ctx context.Context, lessonID string, vector []float32, limit int) ([]Chunk, error) {
	if c == nil || len(vector) == 0 || lessonID == "" {
		return nil, nil
	}
	if limit < 1 {
		limit = 6
	}
	body := map[string]any{
		"vector":       vector,
		"limit":        limit,
		"with_payload": true,
		"filter": map[string]any{
			"must": []map[string]any{
				{"key": "lesson_id", "match": map[string]any{"value": lessonID}},
			},
		},
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
