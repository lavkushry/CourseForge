package knowledge

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"courseforge/backend/internal/identity"
	"courseforge/backend/internal/testutil"
)

type fixture struct {
	s   *Service
	mux *http.ServeMux
}

func setup(t *testing.T) fixture {
	t.Helper()
	pool := testutil.Postgres(t)
	ctx := context.Background()
	for _, user := range []string{"alice", "admin"} {
		role := "student"
		if user == "admin" {
			role = "admin"
		}
		if _, err := pool.Exec(ctx, `INSERT INTO users(id,email,name,password_hash,role,verified)VALUES($1,$1||'@example.test',$1,'disabled',$2,true)`, user, role); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO auth_sessions(id,user_id,token_hash,csrf_token,expires_at)VALUES($1,$2,$3,'csrf',now()+interval '1 hour')`, user+"auth", user, identity.Digest(user+"token")); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO courses(id,title,published)VALUES('course','Knowledge Course',true);
		INSERT INTO lessons(id,course_id,title,duration_seconds)VALUES('lesson','course','Lecture',120);
		INSERT INTO enrollments(user_id,course_id)VALUES('alice','course');`); err != nil {
		t.Fatal(err)
	}
	auth, err := identity.New(pool, identity.Config{PublicOrigin: "http://test", PasswordConcurrency: 1})
	if err != nil {
		t.Fatal(err)
	}
	svc := New(pool)
	svc.WorkerToken = "worker-secret"
	mux := http.NewServeMux()
	svc.Register(mux, auth)
	return fixture{s: svc, mux: mux}
}

func (f fixture) call(user, method, route, key string, body any) *httptest.ResponseRecorder {
	raw, _ := json.Marshal(body)
	r := httptest.NewRequest(method, "http://test"+route, bytes.NewReader(raw))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", "http://test")
	r.Header.Set("X-CSRF-Token", "csrf")
	if key != "" {
		r.Header.Set("Idempotency-Key", key)
	}
	if user != "" {
		r.AddCookie(&http.Cookie{Name: identity.CookieName, Value: user + "token"})
	}
	w := httptest.NewRecorder()
	f.mux.ServeHTTP(w, r)
	return w
}

func (f fixture) worker(method, route string, body any) *httptest.ResponseRecorder {
	raw, _ := json.Marshal(body)
	r := httptest.NewRequest(method, "http://test"+route, bytes.NewReader(raw))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Authorization", "Bearer worker-secret")
	w := httptest.NewRecorder()
	f.mux.ServeHTTP(w, r)
	return w
}

func expect(t *testing.T, w *httptest.ResponseRecorder, status int) {
	t.Helper()
	if w.Code != status {
		t.Fatalf("status=%d expected=%d body=%s", w.Code, status, w.Body.String())
	}
}

func read[T any](t *testing.T, w *httptest.ResponseRecorder) T {
	t.Helper()
	var value T
	if err := json.Unmarshal(w.Body.Bytes(), &value); err != nil {
		t.Fatal(err)
	}
	return value
}

func TestQdrantCollectionIsolation(t *testing.T) {
	if QdrantCollection != "courseforge_living_video" {
		t.Fatalf("unexpected collection %q", QdrantCollection)
	}
	if QdrantCollection == "courseforge_chunks" {
		t.Fatal("must not use legacy chunk collection")
	}
}

func TestIngestJobRoundTrip(t *testing.T) {
	f := setup(t)

	denied := f.call("alice", "POST", "/api/v1/knowledge/jobs", "k1", EnqueueRequest{
		LessonID: "lesson",
		Payload:  json.RawMessage(`{"source_path":"/tmp/tiny.mp4"}`),
	})
	expect(t, denied, 404)

	created := f.call("admin", "POST", "/api/v1/knowledge/jobs", "k1", EnqueueRequest{
		LessonID: "lesson",
		Payload:  json.RawMessage(`{"source_path":"/tmp/tiny.mp4"}`),
	})
	expect(t, created, 202)
	job := read[Job](t, created)
	if job.State != "queued" || job.LessonID != "lesson" {
		t.Fatalf("unexpected job %+v", job)
	}

	replay := f.call("admin", "POST", "/api/v1/knowledge/jobs", "k1", EnqueueRequest{
		LessonID: "lesson",
		Payload:  json.RawMessage(`{"source_path":"/tmp/tiny.mp4"}`),
	})
	expect(t, replay, 202)
	if read[Job](t, replay).ID != job.ID {
		t.Fatal("idempotent enqueue must return same job")
	}

	conflict := f.call("admin", "POST", "/api/v1/knowledge/jobs", "k1", EnqueueRequest{
		LessonID: "lesson",
		Payload:  json.RawMessage(`{"source_path":"/tmp/other.mp4"}`),
	})
	expect(t, conflict, 409)

	claim := f.worker("POST", "/api/v1/knowledge/worker/claim", ClaimRequest{WorkerID: "w1", LeaseSec: 60})
	expect(t, claim, 200)
	leased := read[Job](t, claim)
	if leased.State != "running" || leased.Fence < 1 || leased.WorkerID == nil || *leased.WorkerID != "w1" {
		t.Fatalf("bad lease %+v", leased)
	}

	conf := 0.91
	ingest := f.worker("PUT", "/api/v1/knowledge/worker/jobs/"+leased.ID+"/ingest", map[string]any{
		"worker_id": "w1",
		"fence":     leased.Fence,
		"ingest": IngestPayload{
			ASREngine:   "mock-whisper",
			SceneEngine: "mock-scenedetect",
			OCREngine:   "mock-tesseract",
			Words: []Word{
				{Ordinal: 0, StartMs: 0, EndMs: 200, Text: "hello", Confidence: &conf},
				{Ordinal: 1, StartMs: 200, EndMs: 450, Text: "world"},
			},
			Segments: []Segment{
				{Ordinal: 0, StartMs: 0, EndMs: 450, Text: "hello world"},
			},
			Keyframes: []Keyframe{
				{
					Ordinal: 0, TimeMs: 100, Path: "frames/0.jpg", Width: 64, Height: 36,
					OCR: &OCRHit{Text: "ls -la", Tags: []string{"command", "code"}, Confidence: &conf},
				},
			},
		},
	})
	expect(t, ingest, 200)
	doc := read[Document](t, ingest)
	if doc.Status != "ready" || doc.WordCount != 2 || doc.KeyframeCount != 1 {
		t.Fatalf("unexpected document %+v", doc)
	}

	done := f.worker("POST", "/api/v1/knowledge/worker/jobs/"+leased.ID+"/complete", map[string]any{
		"worker_id": "w1",
		"fence":     leased.Fence,
		"result":    map[string]any{"ok": true},
	})
	expect(t, done, 200)

	lesson := f.call("alice", "GET", "/api/v1/knowledge/lessons/lesson", "", nil)
	expect(t, lesson, 200)
	body := read[LessonKnowledge](t, lesson)
	if len(body.Words) != 2 || len(body.Segments) != 1 || len(body.Keyframes) != 1 {
		t.Fatalf("unexpected knowledge %+v", body)
	}
	if body.Keyframes[0].OCR == nil || body.Keyframes[0].OCR.Text != "ls -la" {
		t.Fatalf("missing OCR %+v", body.Keyframes[0])
	}
	if body.Document.ASREngine != "mock-whisper" {
		t.Fatalf("asr engine %q", body.Document.ASREngine)
	}
}

func TestWorkerAuthAndEmptyClaim(t *testing.T) {
	f := setup(t)
	raw, _ := json.Marshal(ClaimRequest{WorkerID: "w1"})
	r := httptest.NewRequest("POST", "http://test/api/v1/knowledge/worker/claim", bytes.NewReader(raw))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Authorization", "Bearer wrong")
	w := httptest.NewRecorder()
	f.mux.ServeHTTP(w, r)
	expect(t, w, 401)

	empty := f.worker("POST", "/api/v1/knowledge/worker/claim", ClaimRequest{WorkerID: "w1"})
	expect(t, empty, 503)
}

func TestClaimLeaseHeartbeat(t *testing.T) {
	f := setup(t)
	created := f.call("admin", "POST", "/api/v1/knowledge/jobs", "hb", EnqueueRequest{
		LessonID: "lesson",
		Payload:  json.RawMessage(`{}`),
	})
	expect(t, created, 202)
	claim := f.worker("POST", "/api/v1/knowledge/worker/claim", ClaimRequest{WorkerID: "w2", LeaseSec: 30})
	expect(t, claim, 200)
	leased := read[Job](t, claim)

	ok := f.worker("POST", "/api/v1/knowledge/worker/jobs/"+leased.ID+"/heartbeat", map[string]any{
		"worker_id": "w2", "fence": leased.Fence, "lease_seconds": 30,
	})
	expect(t, ok, 200)

	stale := f.worker("POST", "/api/v1/knowledge/worker/jobs/"+leased.ID+"/heartbeat", map[string]any{
		"worker_id": "w2", "fence": leased.Fence + 1, "lease_seconds": 30,
	})
	expect(t, stale, 409)

	fail := f.worker("POST", "/api/v1/knowledge/worker/jobs/"+leased.ID+"/fail", map[string]any{
		"worker_id": "w2", "fence": leased.Fence, "error_code": "asr_failed", "retry": true,
	})
	expect(t, fail, 200)

	// available_at is +15s; force available for reclaim in unit test via pool.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := f.s.Pool.Exec(ctx, `UPDATE knowledge_jobs SET available_at=now()-interval '1 second' WHERE id=$1`, leased.ID); err != nil {
		t.Fatal(err)
	}
	reclaim := f.worker("POST", "/api/v1/knowledge/worker/claim", ClaimRequest{WorkerID: "w3", LeaseSec: 30})
	expect(t, reclaim, 200)
	if read[Job](t, reclaim).Attempt < 2 {
		t.Fatal("retry should increment attempt")
	}
}
