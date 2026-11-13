package ai

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestStatusReportsMeasuredDependencies(t *testing.T) {
	aiSvc, _, mux := setupTest(t)

	ollamaMock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "offline", http.StatusServiceUnavailable)
	}))
	defer ollamaMock.Close()
	aiSvc.OllamaURL = ollamaMock.URL

	req := authedRequest("GET", "/api/v1/ai/status")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body["ollama_online"] != false {
		t.Fatalf("ollama should be offline when /api/tags fails: %#v", body)
	}
	if body["qdrant_online"] != false {
		t.Fatalf("qdrant must not be invented online: %#v", body)
	}
	if _, ok := body["pgvector_active"].(bool); !ok {
		t.Fatalf("pgvector_active must be a measured boolean: %#v", body)
	}
	if body["pgvector_active"] == true {
		if body["vector_dimensions"] != float64(1024) {
			t.Fatalf("active pgvector should report configured dimensions: %#v", body)
		}
	} else if body["vector_dimensions"] != float64(0) {
		t.Fatalf("inactive pgvector must not invent dimensions: %#v", body)
	}
}
