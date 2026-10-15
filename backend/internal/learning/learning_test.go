package learning

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"courseforge/backend/internal/identity"
	"courseforge/backend/internal/jobs"
	"courseforge/backend/internal/testutil"

	"github.com/jackc/pgx/v5"
)

type fixture struct {
	service *Service
	mux     *http.ServeMux
}

func setup(t *testing.T) fixture {
	t.Helper()
	pool := testutil.Postgres(t)
	ctx := context.Background()
	for _, user := range []string{"alice", "bob", "outsider", "unverified", "admin"} {
		role := "student"
		if user == "admin" {
			role = "admin"
		}
		if _, err := pool.Exec(ctx, `INSERT INTO users(id,email,name,password_hash,role,verified)VALUES($1,$1||'@example.test',$1,'disabled',$2,$3)`, user, role, user != "unverified"); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO auth_sessions(id,user_id,token_hash,csrf_token,expires_at)VALUES($1,$2,$3,'csrf',now()+interval '1 hour')`, user+"auth", user, identity.Digest(user+"token")); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(ctx, `INSERT INTO courses(id,title,published)VALUES('course','Synthetic course',true),('other','Other course',true),('hidden','Unpublished',false);
	INSERT INTO lessons(id,course_id,title,duration_seconds)VALUES('lesson','course','Lesson',100),('otherlesson','other','Other lesson',100),('hiddenlesson','hidden','Hidden lesson',100);
	INSERT INTO enrollments(user_id,course_id)VALUES('alice','course'),('bob','course'),('alice','hidden');
	INSERT INTO transcript_chunks(id,lesson_id,start_seconds,end_seconds,text)VALUES('chunk','lesson',0,50,'Synthetic source for grounded review and quiz generation.'),('otherchunk','otherlesson',0,50,'Unrelated private course source.');`); err != nil {
		t.Fatal(err)
	}
	auth, err := identity.New(pool, identity.Config{PublicOrigin: "http://test", PasswordConcurrency: 1})
	if err != nil {
		t.Fatal(err)
	}
	queue, err := jobs.New(pool, jobs.Config{MaxQueued: 100, MaxQueuedPerUser: 20, Lease: 30 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	s := New(pool, queue)
	mux := http.NewServeMux()
	s.Register(mux, auth)
	queue.Register(mux, auth)
	return fixture{s, mux}
}

func (f fixture) call(user, method, path, key string, body any) *httptest.ResponseRecorder {
	raw, _ := json.Marshal(body)
	r := httptest.NewRequest(method, "http://test"+path, bytes.NewReader(raw))
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
func expect(t *testing.T, w *httptest.ResponseRecorder, status int) {
	t.Helper()
	if w.Code != status {
		t.Fatalf("status %d expected %d: %s", w.Code, status, w.Body.String())
	}
}
func read[T any](t *testing.T, w *httptest.ResponseRecorder) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(w.Body.Bytes(), &v); err != nil {
		t.Fatal(err)
	}
	return v
}
func p(user string) identity.Principal {
	role := "student"
	if user == "admin" {
		role = "admin"
	}
	return identity.Principal{UserID: user, SessionID: user + "auth", Role: role, Verified: true}
}
func cardInput() CardInput {
	lesson, chunk := "lesson", "chunk"
	return CardInput{CourseID: "course", LessonID: &lesson, Question: "What is a transaction?", Answer: "A bounded atomic operation.", SourceStart: 10, SourceChunkID: &chunk}
}
func (f fixture) createCard(t *testing.T, user, key string) Card {
	t.Helper()
	w := f.call(user, "POST", "/api/v1/reviews/cards", key, cardInput())
	expect(t, w, 201)
	return read[Card](t, w)
}

func TestBookmarksIsolationBoundsPagingAndAccess(t *testing.T) {
	f := setup(t)
	path := "/api/v1/lessons/lesson/bookmarks"
	w := f.call("alice", "POST", path, "bookmark-one", map[string]any{"position": 10, "label": "First marker"})
	expect(t, w, 201)
	b := read[Bookmark](t, w)
	expect(t, f.call("alice", "POST", path, "bookmark-one", map[string]any{"position": 10, "label": "First marker"}), 201)
	expect(t, f.call("alice", "POST", path, "bookmark-one", map[string]any{"position": 11, "label": "Different marker"}), 409)
	expect(t, f.call("alice", "POST", path, "", map[string]any{"position": 10, "label": "Missing key"}), 400)
	expect(t, f.call("alice", "POST", path, "outofbounds", map[string]any{"position": 101, "label": "Outside lesson"}), 422)
	w = f.call("bob", "GET", path, "", nil)
	expect(t, w, 200)
	if strings.Contains(w.Body.String(), b.ID) {
		t.Fatal("another learner bookmark leaked")
	}
	expect(t, f.call("bob", "DELETE", "/api/v1/bookmarks/"+b.ID, "", nil), 404)
	for _, user := range []string{"outsider", ""} {
		status := 404
		if user == "" {
			status = 401
		}
		expect(t, f.call(user, "GET", path, "", nil), status)
	}
	expect(t, f.call("unverified", "GET", path, "", nil), 403)
	expect(t, f.call("alice", "POST", "/api/v1/lessons/hiddenlesson/bookmarks", "hidden", map[string]any{"position": 1, "label": "Denied"}), 404)
	expect(t, f.call("alice", "POST", path, "bookmark-two", map[string]any{"position": 20, "label": "Second marker"}), 201)
	w = f.call("alice", "GET", path+"?limit=1", "", nil)
	expect(t, w, 200)
	page1 := read[struct {
		Bookmarks []Bookmark `json:"bookmarks"`
		Next      string     `json:"next_cursor"`
	}](t, w)
	if len(page1.Bookmarks) != 1 || page1.Bookmarks[0].ID != b.ID || page1.Next == "" {
		t.Fatalf("first page %+v", page1)
	}
	w = f.call("alice", "GET", path+"?limit=1&cursor="+page1.Next, "", nil)
	expect(t, w, 200)
	page2 := read[struct {
		Bookmarks []Bookmark `json:"bookmarks"`
		Next      string     `json:"next_cursor"`
	}](t, w)
	if len(page2.Bookmarks) != 1 || page2.Bookmarks[0].Position != 20 || page2.Next != "" {
		t.Fatalf("second page %+v", page2)
	}
	expect(t, f.call("alice", "DELETE", "/api/v1/bookmarks/"+b.ID, "", nil), 200)
	// The original command remains replayable without resurrecting its deleted row.
	expect(t, f.call("alice", "POST", path, "bookmark-one", map[string]any{"position": 10, "label": "First marker"}), 201)
	var count int
	if err := f.service.Pool.QueryRow(context.Background(), `SELECT count(*) FROM bookmarks`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("resurrected bookmark count=%d error=%v", count, err)
	}
}

func TestLearningMutationsUseRealCSRFAuthorization(t *testing.T) {
	f := setup(t)
	for _, tc := range []struct{ origin, csrf string }{{"http://hostile.example", "csrf"}, {"http://test", "wrong"}, {"http://test", ""}} {
		r := httptest.NewRequest("POST", "http://test/api/v1/reviews/cards", strings.NewReader(`{"course_id":"course","question":"What is this?","answer":"A test"}`))
		r.AddCookie(&http.Cookie{Name: identity.CookieName, Value: "alicetoken"})
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", tc.origin)
		r.Header.Set("X-CSRF-Token", tc.csrf)
		r.Header.Set("Idempotency-Key", "deny")
		w := httptest.NewRecorder()
		f.mux.ServeHTTP(w, r)
		expect(t, w, 403)
	}
	var count int
	if err := f.service.Pool.QueryRow(context.Background(), `SELECT count(*) FROM review_cards`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("denied writes=%d error=%v", count, err)
	}
}

func TestReviewSourcesGradesDeduplicationAndCompletion(t *testing.T) {
	f := setup(t)
	in := cardInput()
	wrong := "otherchunk"
	in.SourceChunkID = &wrong
	expect(t, f.call("alice", "POST", "/api/v1/reviews/cards", "badsource", in), 422)
	in = cardInput()
	wrong = "otherlesson"
	in.LessonID = &wrong
	expect(t, f.call("alice", "POST", "/api/v1/reviews/cards", "badcourse", in), 422)
	c := f.createCard(t, "alice", "card")
	expect(t, f.call("bob", "POST", "/api/v1/reviews/"+c.ID+"/grade", "foreign", map[string]any{"quality": 5, "expected_revision": 1}), 404)
	expect(t, f.call("alice", "POST", "/api/v1/reviews/"+c.ID+"/grade", "missingrevision", map[string]any{"quality": 5}), 422)
	var wg sync.WaitGroup
	responses := make(chan *httptest.ResponseRecorder, 8)
	for range 8 {
		wg.Go(func() {
			responses <- f.call("alice", "POST", "/api/v1/reviews/"+c.ID+"/grade", "onegrade", map[string]any{"quality": 5, "expected_revision": 1})
		})
	}
	wg.Wait()
	close(responses)
	attempt := ""
	for w := range responses {
		expect(t, w, 200)
		v := read[map[string]any](t, w)
		if v["revision"] != float64(2) || v["interval_days"] != float64(1) {
			t.Fatalf("schedule %v", v)
		}
		id := v["attempt_id"].(string)
		if attempt != "" && attempt != id {
			t.Fatal("duplicate grade attempts")
		}
		attempt = id
	}
	expect(t, f.call("alice", "POST", "/api/v1/reviews/"+c.ID+"/grade", "stalegrade", map[string]any{"quality": 5, "expected_revision": 1}), 409)
	w := f.call("alice", "GET", "/api/v1/reviews/due", "", nil)
	expect(t, w, 200)
	if strings.Contains(w.Body.String(), c.ID) {
		t.Fatal("future card appeared in due list")
	}
	finish := map[string]any{"course": "course", "attempt_ids": []string{attempt}}
	w = f.call("alice", "POST", "/api/v1/reviews/complete", "complete", finish)
	expect(t, w, 201)
	first := read[map[string]any](t, w)
	if first["habit_credited"] != true {
		t.Fatalf("no first review credit %v", first)
	}
	w = f.call("alice", "POST", "/api/v1/reviews/complete", "complete", finish)
	expect(t, w, 201)
	if read[map[string]any](t, w)["session_id"] != first["session_id"] {
		t.Fatal("duplicate session")
	}
	expect(t, f.call("alice", "POST", "/api/v1/reviews/complete", "complete-again", finish), 409)
	expect(t, f.call("bob", "POST", "/api/v1/reviews/complete", "foreign-complete", finish), 404)
	w = f.call("bob", "GET", "/api/v1/reviews/history", "", nil)
	expect(t, w, 200)
	if strings.Contains(w.Body.String(), attempt) {
		t.Fatal("private attempt leaked")
	}
	var attempts, sessions, credits int
	err := f.service.Pool.QueryRow(context.Background(), `SELECT (SELECT count(*) FROM review_attempts),(SELECT count(*) FROM review_sessions),(SELECT count(*) FROM learning_credits)`).Scan(&attempts, &sessions, &credits)
	if err != nil || attempts != 1 || sessions != 1 || credits != 1 {
		t.Fatalf("counts %d %d %d error=%v", attempts, sessions, credits, err)
	}
}

func TestConcurrentReviewRevisionsHaveOneWinner(t *testing.T) {
	f := setup(t)
	c := f.createCard(t, "alice", "card")
	var wg sync.WaitGroup
	responses := make(chan int, 2)
	for i := range 2 {
		wg.Go(func() {
			responses <- f.call("alice", "POST", "/api/v1/reviews/"+c.ID+"/grade", fmt.Sprintf("grade-%d", i), map[string]any{"quality": 5, "expected_revision": 1}).Code
		})
	}
	wg.Wait()
	close(responses)
	counts := map[int]int{}
	for code := range responses {
		counts[code]++
	}
	if counts[200] != 1 || counts[409] != 1 {
		t.Fatalf("revision winners %v", counts)
	}
}

func questions() []Question {
	zero, one := 0, 1
	chunk := "chunk"
	return []Question{{ID: "q1", Question: "What provides atomicity?", Options: []string{"Transactions", "Random writes"}, CorrectIndex: &zero, Explanation: "Private solution one", Concept: "Atomicity", SourceStart: 10, SourceChunkID: &chunk}, {ID: "q2", Question: "Which behavior protects data?", Options: []string{"Shared secrets", "Explicit ownership"}, CorrectIndex: &one, Explanation: "Private solution two", Concept: "Isolation", SourceStart: 20, SourceChunkID: &chunk}}
}
func (f fixture) createQuiz(t *testing.T) Quiz {
	t.Helper()
	w := f.call("admin", "POST", "/api/v1/admin/lessons/lesson/quiz", "quiz", quizInput{Questions: questions(), Status: "approved"})
	expect(t, w, 201)
	return read[Quiz](t, w)
}

func TestQuizzesHideSolutionsKeepImmutableVersionsAndPrivateAttempts(t *testing.T) {
	f := setup(t)
	q := f.createQuiz(t)
	path := "/api/v1/lessons/lesson/quiz"
	w := f.call("alice", "GET", path, "", nil)
	expect(t, w, 200)
	for _, secret := range []string{"correct_index", "explanation", "source_chunk_id", "Private solution"} {
		if strings.Contains(w.Body.String(), secret) {
			t.Fatalf("solution field exposed %s", secret)
		}
	}
	expect(t, f.call("alice", "GET", "/api/v1/admin/quizzes/"+q.ID, "", nil), 403)
	bad := map[string]any{"quiz_id": q.ID, "revision": 1, "answers": map[string]int{"q1": 0, "q2": 8}}
	expect(t, f.call("alice", "POST", path+"/attempts", "badanswer", bad), 422)
	fail := map[string]any{"quiz_id": q.ID, "revision": 1, "answers": map[string]int{"q1": 1, "q2": 1}}
	w = f.call("alice", "POST", path+"/attempts", "attempt-one", fail)
	expect(t, w, 201)
	failed := read[QuizResult](t, w)
	if failed.Score != 50 || failed.Passed || failed.HabitCredited || len(failed.Feedback) != 2 {
		t.Fatalf("failed grading %+v", failed)
	}
	pass := map[string]any{"quiz_id": q.ID, "revision": 1, "answers": map[string]int{"q1": 0, "q2": 1}}
	w = f.call("alice", "POST", path+"/attempts", "attempt-pass", pass)
	expect(t, w, 201)
	passed := read[QuizResult](t, w)
	if !passed.Passed || passed.Score != 100 || !passed.HabitCredited {
		t.Fatalf("passed grading %+v", passed)
	}
	w = f.call("alice", "POST", path+"/attempts", "attempt-pass", pass)
	expect(t, w, 201)
	if read[QuizResult](t, w).AttemptID != passed.AttemptID {
		t.Fatal("retried attempt duplicated")
	}
	w = f.call("alice", "POST", path+"/attempts", "attempt-pass-again", pass)
	expect(t, w, 201)
	if read[QuizResult](t, w).HabitCredited {
		t.Fatal("daily credit duplicated")
	}
	w = f.call("bob", "GET", path+"/attempts", "", nil)
	expect(t, w, 200)
	if strings.Contains(w.Body.String(), passed.AttemptID) {
		t.Fatal("attempt history crossed learners")
	}
	updated := questions()
	updated[0].Explanation = "New private solution"
	body := map[string]any{"questions": updated, "status": "approved", "expected_revision": 1}
	w = f.call("admin", "PUT", "/api/v1/admin/quizzes/"+q.ID, "quiz-edit", body)
	expect(t, w, 200)
	if read[Quiz](t, w).Revision != 2 {
		t.Fatal("quiz version did not advance")
	}
	expect(t, f.call("admin", "PUT", "/api/v1/admin/quizzes/"+q.ID, "stale-edit", body), 409)
	expect(t, f.call("alice", "POST", path+"/attempts", "stale-attempt", pass), 409)
	// An acknowledged attempt retries with its immutable original feedback.
	w = f.call("alice", "POST", path+"/attempts", "attempt-pass", pass)
	expect(t, w, 201)
	if read[QuizResult](t, w).Feedback[0].Explanation != "Private solution one" {
		t.Fatal("old feedback changed with current quiz")
	}
	var versions, cards, credits int
	err := f.service.Pool.QueryRow(context.Background(), `SELECT (SELECT count(*) FROM quiz_versions),(SELECT count(*) FROM review_cards),(SELECT count(*) FROM learning_credits)`).Scan(&versions, &cards, &credits)
	if err != nil || versions != 2 || cards != 1 || credits != 1 {
		t.Fatalf("counts versions=%d cards=%d credits=%d err=%v", versions, cards, credits, err)
	}
	var audits int
	var secret bool
	if err = f.service.Pool.QueryRow(context.Background(), `SELECT count(*),COALESCE(bool_or(resource LIKE '%Private solution%'),false) FROM admin_audit`).Scan(&audits, &secret); err != nil || audits != 2 || secret {
		t.Fatalf("audit count=%d solution leaked=%v err=%v", audits, secret, err)
	}
}

func TestLearningTimezoneIsAnchoredAndCreditsRespectDST(t *testing.T) {
	f := setup(t)
	w := f.call("alice", "PUT", "/api/v1/me/learning-preferences", "", map[string]string{"timezone": "America/Los_Angeles"})
	expect(t, w, 200)
	w = f.call("alice", "PUT", "/api/v1/me/learning-preferences", "", map[string]string{"timezone": "Asia/Kolkata"})
	expect(t, w, 200)
	if read[map[string]any](t, w)["timezone"] != "America/Los_Angeles" {
		t.Fatal("timezone changed after anchoring")
	}
	expect(t, f.call("alice", "PUT", "/api/v1/me/learning-preferences", "", map[string]string{"timezone": "Local"}), 422)
	ctx := context.Background()
	tx, err := f.service.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	for _, tc := range []struct {
		at       time.Time
		resource string
		expected bool
	}{{time.Date(2026, 1, 1, 0, 30, 0, 0, time.UTC), "lesson", true}, {time.Date(2026, 1, 1, 7, 30, 0, 0, time.UTC), "lesson", false}, {time.Date(2026, 1, 1, 8, 30, 0, 0, time.UTC), "lesson", true}, {time.Date(2026, 11, 1, 8, 30, 0, 0, time.UTC), "dst", true}, {time.Date(2026, 11, 1, 9, 30, 0, 0, time.UTC), "dst", false}} {
		ok, err := credit(ctx, tx, "alice", "quiz", tc.resource, tc.at)
		if err != nil || ok != tc.expected {
			t.Fatalf("time %v credit=%v wanted=%v err=%v", tc.at, ok, tc.expected, err)
		}
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	var day string
	if err = f.service.Pool.QueryRow(ctx, `SELECT day::text FROM learning_credits WHERE resource='lesson' ORDER BY day LIMIT 1`).Scan(&day); err != nil || day != "2025-12-31" {
		t.Fatalf("local date=%s err=%v", day, err)
	}
}

func TestGenerationCountDefaultDoesNotAcceptExplicitInvalidValues(t *testing.T) {
	f := setup(t)
	for _, count := range []any{0, -1, 21, nil, "2", 1.5} {
		t.Run(fmt.Sprint(count), func(t *testing.T) {
			expect(t, f.call("alice", "POST", "/api/v1/reviews/generate", "invalid-review-count", map[string]any{"lesson_id": "lesson", "count": count}), 422)
			expect(t, f.call("admin", "POST", "/api/v1/admin/lessons/lesson/quiz/regenerate", "invalid-quiz-count", map[string]any{"expected_revision": 0, "count": count}), 422)
		})
	}
	var count int
	if err := f.service.Pool.QueryRow(context.Background(), "SELECT count(*) FROM jobs").Scan(&count); err != nil || count != 0 {
		t.Fatalf("invalid count consumed queue slots: %d, %v", count, err)
	}
	expect(t, f.call("alice", "POST", "/api/v1/reviews/generate", "default-review-count", map[string]any{"lesson_id": "lesson"}), 202)
	expect(t, f.call("admin", "POST", "/api/v1/admin/lessons/lesson/quiz/regenerate", "default-quiz-count", map[string]any{"expected_revision": 0}), 202)
}

func TestGenerationUsesFencedJobsAndTransactionalPrivatePublication(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	expect(t, f.call("alice", "POST", "/api/v1/admin/lessons/lesson/quiz/regenerate", "student-quiz", map[string]any{"count": 2, "expected_revision": 0}), 403)
	w := f.call("alice", "POST", "/api/v1/reviews/generate", "generate", map[string]any{"lesson_id": "lesson", "count": 1})
	expect(t, w, 202)
	job := read[jobs.Job](t, w)
	lease, err := f.service.Queue.Claim(ctx, "ai", "worker")
	if err != nil {
		t.Fatal(err)
	}
	if lease.Job.ID != job.ID {
		t.Fatal("unexpected job")
	}
	bad := cardInput()
	wrong := "otherchunk"
	bad.SourceChunkID = &wrong
	raw, _ := json.Marshal(GenerationResult{Version: 1, LessonID: "lesson", Cards: []CardInput{bad}})
	err = f.service.Queue.Complete(ctx, lease, raw, func(ctx context.Context, tx pgx.Tx) error { return f.service.PublishResult(ctx, tx, lease.Job, raw) })
	if !errors.Is(err, ErrInvalid) {
		t.Fatalf("foreign source published %v", err)
	}
	var cards, outbox int
	if err = f.service.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM review_cards),(SELECT count(*) FROM job_outbox)`).Scan(&cards, &outbox); err != nil || cards != 0 || outbox != 0 {
		t.Fatalf("rollback counts %d %d err=%v", cards, outbox, err)
	}
	raw, _ = json.Marshal(GenerationResult{Version: 1, LessonID: "lesson", Cards: []CardInput{cardInput()}})
	if err = f.service.Queue.Complete(ctx, lease, raw, func(ctx context.Context, tx pgx.Tx) error { return f.service.PublishResult(ctx, tx, lease.Job, raw) }); err != nil {
		t.Fatal(err)
	}
	if err = f.service.Queue.Complete(ctx, lease, raw, func(ctx context.Context, tx pgx.Tx) error { return f.service.PublishResult(ctx, tx, lease.Job, raw) }); !errors.Is(err, jobs.ErrStale) {
		t.Fatalf("duplicate publication %v", err)
	}
	expect(t, f.call("bob", "GET", "/api/v1/jobs/"+job.ID, "", nil), 404)
	w = f.call("bob", "GET", "/api/v1/reviews/cards", "", nil)
	expect(t, w, 200)
	if strings.Contains(w.Body.String(), "What is a transaction?") {
		t.Fatal("generated card crossed owner")
	}
	if err = f.service.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM review_cards),(SELECT count(*) FROM job_outbox)`).Scan(&cards, &outbox); err != nil || cards != 1 || outbox != 1 {
		t.Fatalf("publication counts %d %d err=%v", cards, outbox, err)
	}
}

func TestGeneratedQuizRequiresCurationAndCannotOverwriteEdits(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	w := f.call("admin", "POST", "/api/v1/admin/lessons/lesson/quiz/regenerate", "generate-quiz", map[string]any{"count": 2, "expected_revision": 0})
	expect(t, w, 202)
	lease, err := f.service.Queue.Claim(ctx, "ai", "worker")
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(GenerationResult{Version: 1, LessonID: "lesson", Questions: questions()})
	if err = f.service.Queue.Complete(ctx, lease, raw, func(ctx context.Context, tx pgx.Tx) error { return f.service.PublishResult(ctx, tx, lease.Job, raw) }); err != nil {
		t.Fatal(err)
	}
	w = f.call("alice", "GET", "/api/v1/lessons/lesson/quiz", "", nil)
	expect(t, w, 200)
	if read[map[string]any](t, w)["state"] != "pending" {
		t.Fatal("unapproved generated quiz became visible")
	}
	w = f.call("admin", "GET", "/api/v1/admin/courses/course/quizzes", "", nil)
	expect(t, w, 200)
	items := read[struct {
		Quizzes []Quiz `json:"quizzes"`
	}](t, w)
	if len(items.Quizzes) != 1 || items.Quizzes[0].Status != "draft" {
		t.Fatalf("curation %+v", items)
	}
	q := items.Quizzes[0]
	w = f.call("admin", "POST", "/api/v1/admin/lessons/lesson/quiz/regenerate", "regenerate-old", map[string]any{"count": 2, "expected_revision": 1})
	expect(t, w, 202)
	w = f.call("admin", "PUT", "/api/v1/admin/quizzes/"+q.ID, "approve", map[string]any{"questions": questions(), "status": "approved", "expected_revision": 1})
	expect(t, w, 200)
	lease, err = f.service.Queue.Claim(ctx, "ai", "worker2")
	if err != nil {
		t.Fatal(err)
	}
	err = f.service.Queue.Complete(ctx, lease, raw, func(ctx context.Context, tx pgx.Tx) error { return f.service.PublishResult(ctx, tx, lease.Job, raw) })
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("stale generation overwrote edit %v", err)
	}
	w = f.call("admin", "GET", "/api/v1/admin/quizzes/"+q.ID, "", nil)
	expect(t, w, 200)
	current := read[Quiz](t, w)
	if current.Revision != 2 || current.Status != "approved" {
		t.Fatalf("curation overwritten %+v", current)
	}
}

func TestSM2AndGradeValidation(t *testing.T) {
	for _, tc := range []struct {
		reps, interval         int
		ease                   float64
		quality                int
		wantReps, wantInterval int
		wantEase               float64
	}{{0, 0, 2.5, 5, 1, 1, 2.6}, {1, 1, 2.6, 4, 2, 6, 2.6}, {2, 5, 2.5, 5, 3, 12, 2.6}, {3, 12, 1.3, 0, 0, 1, 1.3}} {
		r, d, e, err := SM2(tc.reps, tc.interval, tc.ease, tc.quality)
		if err != nil || r != tc.wantReps || d != tc.wantInterval || e != tc.wantEase {
			t.Fatalf("SM2 %+v => %d,%d,%v %v", tc, r, d, e, err)
		}
	}
	if _, _, _, err := SM2(0, 0, 2.5, 6); !errors.Is(err, ErrInvalid) {
		t.Fatalf("invalid quality %v", err)
	}
	q := Quiz{Questions: questions()}
	negative := -1
	q.Questions[0].CorrectIndex = &negative
	if _, err := GradeQuiz(q, map[string]int{"q1": 0, "q2": 1}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("corrupt solution %v", err)
	}
}

type executorFunc func(context.Context, jobs.Envelope) (json.RawMessage, error)

func (f executorFunc) Execute(ctx context.Context, envelope jobs.Envelope) (json.RawMessage, error) {
	return f(ctx, envelope)
}

func TestWorkerPublisherRejectsInvalidResultAndRetriesWithoutDuplicateEffects(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	payload, _ := json.Marshal(GenerationPayload{Version: 1, Count: 1})
	job, err := f.service.Queue.Submit(ctx, p("alice"), "worker-generation", jobs.Command{Kind: "review", LessonID: "lesson", Payload: payload})
	if err != nil {
		t.Fatal(err)
	}
	lease, err := f.service.Queue.Claim(ctx, "ai", "worker")
	if err != nil {
		t.Fatal(err)
	}
	bad := cardInput()
	wrong := "otherchunk"
	bad.SourceChunkID = &wrong
	raw, _ := json.Marshal(GenerationResult{Version: 1, LessonID: "lesson", Cards: []CardInput{bad}})
	executor := executorFunc(func(context.Context, jobs.Envelope) (json.RawMessage, error) { return raw, nil })
	if err = f.service.Queue.ExecuteLeaseWithPublisher(ctx, lease, executor, f.service.PublishResult); !errors.Is(err, jobs.ErrExecutor) {
		t.Fatalf("bad execution result %v", err)
	}
	current, err := f.service.Queue.Get(ctx, p("alice"), job.ID)
	if err != nil || current.State != "queued" || current.ErrorCode == nil || *current.ErrorCode != "invalid_result" {
		t.Fatalf("retry status %+v err=%v", current, err)
	}
	if _, err = f.service.Pool.Exec(ctx, `UPDATE jobs SET available_at=now()-interval '1 second' WHERE id=$1`, job.ID); err != nil {
		t.Fatal(err)
	}
	lease, err = f.service.Queue.Claim(ctx, "ai", "worker-retry")
	if err != nil {
		t.Fatal(err)
	}
	raw, _ = json.Marshal(GenerationResult{Version: 1, LessonID: "lesson", Cards: []CardInput{cardInput()}})
	if err = f.service.Queue.ExecuteLeaseWithPublisher(ctx, lease, executor, f.service.PublishResult); err != nil {
		t.Fatal(err)
	}
	current, err = f.service.Queue.Get(ctx, p("alice"), job.ID)
	if err != nil || current.State != "completed" || current.Attempt != 2 {
		t.Fatalf("completion %+v error=%v", current, err)
	}
	var cards, outbox int
	if err = f.service.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM review_cards),(SELECT count(*) FROM job_outbox)`).Scan(&cards, &outbox); err != nil || cards != 1 || outbox != 1 {
		t.Fatalf("effects %d %d err=%v", cards, outbox, err)
	}
}

func TestQuizVersionsCannotBeMutatedInPlace(t *testing.T) {
	f := setup(t)
	q := f.createQuiz(t)
	ctx := context.Background()
	if _, err := f.service.Pool.Exec(ctx, `UPDATE quiz_versions SET questions='[]'::jsonb WHERE quiz_id=$1`, q.ID); err == nil {
		t.Fatal("immutable quiz version accepted UPDATE")
	}
	// Retention can remove a lesson and its dependent private records atomically.
	if _, err := f.service.Pool.Exec(ctx, `DELETE FROM lessons WHERE id='lesson'`); err != nil {
		t.Fatalf("version immutability blocked retention: %v", err)
	}
}
