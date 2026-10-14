package knowledge

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
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
	if QdrantCollection != "courseforge_knowledge" {
		t.Fatalf("unexpected collection %q", QdrantCollection)
	}
	if QdrantCollection == "courseforge_chunks" {
		t.Fatal("must not use legacy chunk collection")
	}
}

type stubGenerator struct {
	answer string
}

func (g stubGenerator) Complete(ctx context.Context, system, user string) (string, error) {
	return g.answer, nil
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

func TestIndexChaptersAndAskWithCitations(t *testing.T) {
	f := setup(t)
	f.s.Generator = stubGenerator{answer: "Containers package apps [0:00]."}
	f.s.Qdrant = nil // BM25-only path for deterministic unit tests

	created := f.call("admin", "POST", "/api/v1/knowledge/jobs", "ask1", EnqueueRequest{
		LessonID: "lesson",
		Payload:  json.RawMessage(`{}`),
	})
	expect(t, created, 202)
	claim := f.worker("POST", "/api/v1/knowledge/worker/claim", ClaimRequest{WorkerID: "w1", LeaseSec: 60})
	expect(t, claim, 200)
	leased := read[Job](t, claim)

	ingest := f.worker("PUT", "/api/v1/knowledge/worker/jobs/"+leased.ID+"/ingest", map[string]any{
		"worker_id": "w1",
		"fence":     leased.Fence,
		"ingest": IngestPayload{
			ASREngine: "mock", SceneEngine: "mock", OCREngine: "mock",
			Segments: []Segment{
				{Ordinal: 0, StartMs: 0, EndMs: 4000, Text: "docker containers package applications"},
				{Ordinal: 1, StartMs: 4000, EndMs: 8000, Text: "postgres stores relational tables"},
			},
		},
	})
	expect(t, ingest, 200)

	index := f.worker("PUT", "/api/v1/knowledge/worker/jobs/"+leased.ID+"/index", map[string]any{
		"worker_id": "w1",
		"fence":     leased.Fence,
		"embedder":  "hash",
		"chapters": []Chapter{
			{Ordinal: 0, StartMs: 0, EndMs: 4000, Title: "Containers", Summary: "docker containers"},
			{Ordinal: 1, StartMs: 4000, EndMs: 8000, Title: "Postgres", Summary: "relational tables"},
		},
		"chunks": []Chunk{
			{ID: "kc_1", Ordinal: 0, StartMs: 0, EndMs: 4000, Text: "docker containers package applications", Source: "transcript"},
			{ID: "kc_2", Ordinal: 1, StartMs: 4000, EndMs: 8000, Text: "postgres stores relational tables", Source: "transcript"},
		},
	})
	expect(t, index, 200)
	doc := read[Document](t, index)
	if doc.ChapterCount != 2 || doc.ChunkCount != 2 {
		t.Fatalf("unexpected index counts %+v", doc)
	}

	chapters := f.call("alice", "GET", "/api/v1/knowledge/lessons/lesson/chapters", "", nil)
	expect(t, chapters, 200)
	var chapterBody struct {
		Chapters []Chapter `json:"chapters"`
	}
	if err := json.Unmarshal(chapters.Body.Bytes(), &chapterBody); err != nil {
		t.Fatal(err)
	}
	if len(chapterBody.Chapters) != 2 || chapterBody.Chapters[0].Title != "Containers" {
		t.Fatalf("unexpected chapters %+v", chapterBody.Chapters)
	}

	ask := f.call("alice", "POST", "/api/v1/knowledge/lessons/lesson/ask", "", AskRequest{
		Question: "How do docker containers package applications?",
	})
	expect(t, ask, 200)
	ans := read[AskResponse](t, ask)
	if ans.Abstained || ans.Support != "supported" || len(ans.Citations) == 0 {
		t.Fatalf("expected supported answer with citations %+v", ans)
	}
	if !strings.Contains(ans.Answer, "[0:00]") && !strings.Contains(ans.Answer, "[00:00]") {
		t.Fatalf("answer missing citation: %q", ans.Answer)
	}

	miss := f.call("alice", "POST", "/api/v1/knowledge/lessons/lesson/ask", "", AskRequest{
		Question: "What is quantum entanglement theory?",
	})
	expect(t, miss, 200)
	abstain := read[AskResponse](t, miss)
	if !abstain.Abstained || abstain.Support != "not_covered" {
		t.Fatalf("expected abstain %+v", abstain)
	}
	if !strings.Contains(strings.ToLower(abstain.Answer), "not covered in this video") {
		t.Fatalf("abstain message %q", abstain.Answer)
	}
}

func TestHashEmbedStable(t *testing.T) {
	a := HashEmbed("hello world", 32)
	b := HashEmbed("hello world", 32)
	if len(a) != 32 {
		t.Fatalf("dim %d", len(a))
	}
	for i := range a {
		if a[i] != b[i] {
			t.Fatal("hash embed not stable")
		}
	}
}

func TestLearningGraphRecallFeedbackAndFreshness(t *testing.T) {
	f := setup(t)
	f.s.Embedder = HashEmbedder{Dim: 32}
	f.s.Qdrant = nil

	created := f.call("admin", "POST", "/api/v1/knowledge/jobs", "learn1", EnqueueRequest{
		LessonID: "lesson",
		Payload:  json.RawMessage(`{}`),
	})
	expect(t, created, 202)
	claim := f.worker("POST", "/api/v1/knowledge/worker/claim", ClaimRequest{WorkerID: "w1", LeaseSec: 60})
	expect(t, claim, 200)
	leased := read[Job](t, claim)

	ingest := f.worker("PUT", "/api/v1/knowledge/worker/jobs/"+leased.ID+"/ingest", map[string]any{
		"worker_id": "w1",
		"fence":     leased.Fence,
		"ingest": IngestPayload{
			ASREngine: "mock", SceneEngine: "mock", OCREngine: "mock",
			Segments: []Segment{
				{Ordinal: 0, StartMs: 0, EndMs: 4000, Text: "docker containers package applications"},
				{Ordinal: 1, StartMs: 4000, EndMs: 8000, Text: "run docker-compose up for local stacks"},
			},
			Keyframes: []Keyframe{
				{Ordinal: 0, TimeMs: 4500, Path: "kf0.jpg", OCR: &OCRHit{Text: "docker-compose up -d", Tags: []string{"command"}}},
			},
		},
	})
	expect(t, ingest, 200)

	index := f.worker("PUT", "/api/v1/knowledge/worker/jobs/"+leased.ID+"/index", map[string]any{
		"worker_id": "w1",
		"fence":     leased.Fence,
		"embedder":  "hash",
		"embed_dim": 32,
		"chapters": []Chapter{
			{Ordinal: 0, StartMs: 0, EndMs: 4000, Title: "Containers", Summary: "docker containers"},
			{Ordinal: 1, StartMs: 4000, EndMs: 8000, Title: "Compose", Summary: "local stacks"},
		},
		"chunks": []Chunk{
			{ID: "kc_1", Ordinal: 0, StartMs: 0, EndMs: 4000, Text: "docker containers package applications", Source: "transcript"},
			{ID: "kc_2", Ordinal: 1, StartMs: 4000, EndMs: 8000, Text: "run docker-compose up for local stacks", Source: "multimodal"},
		},
	})
	expect(t, index, 200)

	concepts := f.call("alice", "GET", "/api/v1/knowledge/lessons/lesson/concepts", "", nil)
	expect(t, concepts, 200)
	var conceptBody struct {
		Concepts []Concept       `json:"concepts"`
		Prereqs  []ConceptPrereq `json:"prereqs"`
	}
	if err := json.Unmarshal(concepts.Body.Bytes(), &conceptBody); err != nil {
		t.Fatal(err)
	}
	if len(conceptBody.Concepts) != 2 || len(conceptBody.Prereqs) != 1 {
		t.Fatalf("concepts=%d prereqs=%d", len(conceptBody.Concepts), len(conceptBody.Prereqs))
	}

	recall := f.call("alice", "GET", "/api/v1/knowledge/lessons/lesson/recall", "", nil)
	expect(t, recall, 200)
	var recallBody struct {
		Questions []RecallQuestion `json:"questions"`
	}
	if err := json.Unmarshal(recall.Body.Bytes(), &recallBody); err != nil {
		t.Fatal(err)
	}
	if len(recallBody.Questions) != 2 || recallBody.Questions[0].Prompt == "" {
		t.Fatalf("unexpected recall %+v", recallBody.Questions)
	}

	fresh := f.call("alice", "GET", "/api/v1/knowledge/lessons/lesson/freshness", "", nil)
	expect(t, fresh, 200)
	var freshBody struct {
		Flags []FreshnessFlag `json:"flags"`
	}
	if err := json.Unmarshal(fresh.Body.Bytes(), &freshBody); err != nil {
		t.Fatal(err)
	}
	if len(freshBody.Flags) == 0 {
		t.Fatal("expected freshness flags for docker-compose")
	}

	fb := f.call("alice", "POST", "/api/v1/knowledge/lessons/lesson/feedback", "", FeedbackEventRequest{
		Kind: "rewind", TimeMs: 4500, Payload: json.RawMessage(`{}`),
	})
	expect(t, fb, 200)

	denied := f.call("alice", "GET", "/api/v1/knowledge/lessons/lesson/hotspots", "", nil)
	expect(t, denied, 404)
	hotspots := f.call("admin", "GET", "/api/v1/knowledge/lessons/lesson/hotspots", "", nil)
	expect(t, hotspots, 200)
	var hotBody struct {
		Hotspots []ConfusionHotspot `json:"hotspots"`
	}
	if err := json.Unmarshal(hotspots.Body.Bytes(), &hotBody); err != nil {
		t.Fatal(err)
	}
	if len(hotBody.Hotspots) != 1 || hotBody.Hotspots[0].RewindCount < 1 {
		t.Fatalf("unexpected hotspots %+v", hotBody.Hotspots)
	}

	ann := f.call("admin", "POST", "/api/v1/knowledge/lessons/lesson/hotspots/"+hotBody.Hotspots[0].ID+"/annotations", "", map[string]any{
		"author_type": "creator",
		"body":        "Add a callout about docker compose v2.",
	})
	expect(t, ann, 201)

	queue := f.call("alice", "GET", "/api/v1/knowledge/review-queue", "", nil)
	expect(t, queue, 200)
	var queueBody struct {
		Items []ReviewQueueItem `json:"items"`
	}
	if err := json.Unmarshal(queue.Body.Bytes(), &queueBody); err != nil {
		t.Fatal(err)
	}
	if len(queueBody.Items) == 0 {
		t.Fatal("expected review queue items from flashcards")
	}
	reviewed := f.call("alice", "POST", "/api/v1/knowledge/review/"+queueBody.Items[0].Card.ID, "", map[string]any{"rating": 3})
	expect(t, reviewed, 200)
	card := read[FSRSCard](t, reviewed)
	if card.Reps < 1 || card.State == "" {
		t.Fatalf("unexpected review state %+v", card)
	}

	bridge, err := f.s.ListConceptsForSkillGap(context.Background(), "lesson")
	if err != nil || len(bridge) != 2 {
		t.Fatalf("skill gap bridge %+v err=%v", bridge, err)
	}
}

func TestQueryEmbedRespectsHashFallback(t *testing.T) {
	t.Setenv("CF_KNOWLEDGE_EMBEDDER", "hash")
	s := &Service{Embedder: AIEmbedder{Model: "unused", Fn: func(ctx context.Context, text string) ([]float32, error) {
		t.Fatal("ollama must not be called in hash mode")
		return nil, nil
	}}}
	vec, name, dim := s.queryEmbed(context.Background(), "", "hello world")
	if name != "hash" || dim != 384 || len(vec) != 384 {
		t.Fatalf("name=%s dim=%d len=%d", name, dim, len(vec))
	}
}

func TestReciprocalRankFusionPrefersOverlap(t *testing.T) {
	bm25 := []Chunk{{ID: "a", Text: "a"}, {ID: "b", Text: "b"}}
	dense := []Chunk{{ID: "b", Text: "b"}, {ID: "c", Text: "c"}}
	fused := reciprocalRankFusion(bm25, dense)
	if len(fused) == 0 || fused[0].Chunk.ID != "b" {
		t.Fatalf("expected b first, got %+v", fused)
	}
}
