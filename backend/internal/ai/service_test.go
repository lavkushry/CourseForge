package ai

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"courseforge/backend/internal/identity"
	"courseforge/backend/internal/testutil"
)

func setupTest(t *testing.T) (*Service, *identity.Service, *http.ServeMux) {
	t.Helper()
	pool := testutil.Postgres(t)
	ctx := context.Background()

	// Seed user and session
	if _, err := pool.Exec(ctx, `
		INSERT INTO users (id, email, name, password_hash, role, verified)
		VALUES ('learner-1', 'learner@example.test', 'Test Learner', 'disabled', 'student', true)
	`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO auth_sessions (id, user_id, token_hash, csrf_token, expires_at)
		VALUES ('sess-1', 'learner-1', $1, 'csrf-test', now() + interval '1 hour')
	`, identity.Digest("valid-token")); err != nil {
		t.Fatal(err)
	}

	// Seed course and lesson
	if _, err := pool.Exec(ctx, `
		INSERT INTO courses (id, title, published)
		VALUES ('course-ai-1', 'Advanced Distributed Systems', true)
	`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO lessons (id, course_id, title, duration_seconds)
		VALUES ('lesson-ai-1', 'course-ai-1', 'Deep Dive into Distributed Cache Architecture', 1800)
	`); err != nil {
		t.Fatal(err)
	}

	auth, err := identity.New(pool, identity.Config{
		PublicOrigin:        "http://test",
		PasswordConcurrency: 1,
	})
	if err != nil {
		t.Fatal(err)
	}

	aiSvc := New(pool)
	mux := http.NewServeMux()
	aiSvc.Register(mux, auth)

	return aiSvc, auth, mux
}

func authedRequest(method, path string) *http.Request {
	req := httptest.NewRequest(method, "http://test"+path, nil)
	req.Header.Set("Origin", "http://test")
	req.Header.Set("X-CSRF-Token", "csrf-test")
	req.AddCookie(&http.Cookie{
		Name:  identity.CookieName,
		Value: "valid-token",
	})
	return req
}

func TestLessonTranscriptsAndChaptersEndpoints(t *testing.T) {
	aiSvc, _, mux := setupTest(t)
	ctx := context.Background()

	// 1. Missing lesson returns 404
	{
		req := authedRequest("GET", "/api/v1/ai/lessons/no-such-lesson/transcripts")
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusNotFound {
			t.Fatalf("expected 404 for missing lesson, got %d", rec.Code)
		}
	}

	// 2. Empty transcripts returns empty list
	{
		req := authedRequest("GET", "/api/v1/ai/lessons/lesson-ai-1/transcripts")
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d", rec.Code)
		}
		var res struct {
			Count  int               `json:"count"`
			Chunks []TranscriptChunk `json:"chunks"`
		}
		if err := json.NewDecoder(rec.Body).Decode(&res); err != nil {
			t.Fatal(err)
		}
		if res.Count != 0 || len(res.Chunks) != 0 {
			t.Fatalf("expected 0 chunks, got %d", res.Count)
		}
	}

	// 3. Insert real transcript chunks
	if _, err := aiSvc.Pool.Exec(ctx, `
		INSERT INTO transcript_chunks (id, lesson_id, kind, start_seconds, end_seconds, text)
		VALUES
		  ('tchunk-1', 'lesson-ai-1', 'transcript', 0.0, 60.0, 'Welcome to the distributed cache deep dive.'),
		  ('tchunk-2', 'lesson-ai-1', 'transcript', 60.0, 180.0, 'Here we analyze eviction algorithms: LRU, LFU, and 2Q policies.')
	`); err != nil {
		t.Fatal(err)
	}

	// 4. Transcripts endpoint returns ordered chunks
	{
		req := authedRequest("GET", "/api/v1/ai/lessons/lesson-ai-1/transcripts")
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d", rec.Code)
		}
		var res struct {
			Count  int               `json:"count"`
			Chunks []TranscriptChunk `json:"chunks"`
		}
		if err := json.NewDecoder(rec.Body).Decode(&res); err != nil {
			t.Fatal(err)
		}
		if res.Count != 2 || len(res.Chunks) != 2 {
			t.Fatalf("expected 2 chunks, got %d", res.Count)
		}
		if res.Chunks[0].StartSeconds != 0.0 || res.Chunks[1].StartSeconds != 60.0 {
			t.Fatalf("unexpected chunk ordering: %+v", res.Chunks)
		}
	}

	// 5. Chapters endpoint synthesizes splits when no explicit chapters stored
	{
		req := authedRequest("GET", "/api/v1/ai/lessons/lesson-ai-1/chapters")
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d", rec.Code)
		}
		var res struct {
			Chapters []ChapterSplit `json:"chapters"`
		}
		if err := json.NewDecoder(rec.Body).Decode(&res); err != nil {
			t.Fatal(err)
		}
		if len(res.Chapters) < 3 {
			t.Fatalf("expected at least 3 synthesized chapter splits, got %d", len(res.Chapters))
		}
		if res.Chapters[0].Index != 1 || res.Chapters[0].StartSeconds != 0.0 {
			t.Fatalf("unexpected chapter 1 format: %+v", res.Chapters[0])
		}
	}

	// 6. Explicit stored chapters take precedence
	if _, err := aiSvc.Pool.Exec(ctx, `
		INSERT INTO transcript_chunks (id, lesson_id, kind, start_seconds, end_seconds, text)
		VALUES
		  ('chap-1', 'lesson-ai-1', 'chapter', 0.0, 300.0, 'Introduction & Cache Basics — Foundational caching concepts.'),
		  ('chap-2', 'lesson-ai-1', 'chapter', 300.0, 900.0, 'Eviction Strategies — Analysis of LRU and 2Q data structures.')
	`); err != nil {
		t.Fatal(err)
	}

	{
		req := authedRequest("GET", "/api/v1/ai/lessons/lesson-ai-1/chapters")
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d", rec.Code)
		}
		var res struct {
			Chapters []ChapterSplit `json:"chapters"`
		}
		if err := json.NewDecoder(rec.Body).Decode(&res); err != nil {
			t.Fatal(err)
		}
		if len(res.Chapters) != 2 {
			t.Fatalf("expected 2 stored chapters, got %d", len(res.Chapters))
		}
		if res.Chapters[0].Title != "Introduction & Cache Basics" || res.Chapters[0].Summary != "Foundational caching concepts." {
			t.Fatalf("unexpected chapter 1: %+v", res.Chapters[0])
		}
		if res.Chapters[1].Title != "Eviction Strategies" || res.Chapters[1].Summary != "Analysis of LRU and 2Q data structures." {
			t.Fatalf("unexpected chapter 2: %+v", res.Chapters[1])
		}
	}
}

func TestClassifySplitEndpoint(t *testing.T) {
	aiSvc, _, mux := setupTest(t)

	// Set up mock Ollama server that returns thinking tags + JSON array
	ollamaMock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"response": "<think>Analyzing transcript chunks and topics...</think>\n```json\n[\n  {\"title\": \"Cache Primitives\", \"start_seconds\": 0.0, \"end_seconds\": 300.0, \"summary\": \"Deep dive into primitive cache structures.\"},\n  {\"title\": \"Concurrency Controls\", \"start_seconds\": 300.0, \"end_seconds\": 900.0, \"summary\": \"Multi-threaded synchronization models.\"}\n]\n```",
		})
	}))
	defer ollamaMock.Close()
	aiSvc.OllamaURL = ollamaMock.URL

	req := authedRequest("POST", "/api/v1/ai/lessons/lesson-ai-1/classify-split")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	var res struct {
		LessonID string         `json:"lesson_id"`
		Chapters []ChapterSplit `json:"chapters"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&res); err != nil {
		t.Fatal(err)
	}

	if len(res.Chapters) != 2 {
		t.Fatalf("expected 2 classified chapters, got %d", len(res.Chapters))
	}
	if res.Chapters[0].Title != "Cache Primitives" || res.Chapters[1].Title != "Concurrency Controls" {
		t.Fatalf("unexpected chapters: %+v", res.Chapters)
	}
}
