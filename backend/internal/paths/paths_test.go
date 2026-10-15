package paths

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
	"courseforge/backend/internal/planning"
	"courseforge/backend/internal/testutil"

	"github.com/jackc/pgx/v5"
)

type fixture struct {
	s   *Service
	mux *http.ServeMux
}

func setup(t *testing.T) fixture {
	t.Helper()
	pool := testutil.Postgres(t)
	ctx := context.Background()
	for _, u := range []string{"alice", "bob", "outsider", "admin", "unverified"} {
		role := "student"
		if u == "admin" {
			role = "admin"
		}
		if _, e := pool.Exec(ctx, `INSERT INTO users(id,email,name,password_hash,role,verified)VALUES($1,$1||'@example.test',$1,'disabled',$2,$3);`, u, role, u != "unverified"); e != nil {
			t.Fatal(e)
		}
		if _, e := pool.Exec(ctx, `INSERT INTO auth_sessions(id,user_id,token_hash,csrf_token,expires_at)VALUES($1,$2,$3,'csrf',now()+interval '1 hour')`, u+"auth", u, identity.Digest(u+"token")); e != nil {
			t.Fatal(e)
		}
	}
	if _, e := pool.Exec(ctx, `INSERT INTO courses(id,title,published)VALUES('course','Synthetic course',true),('other','Other course',true),('hidden','Hidden course',false);INSERT INTO lessons(id,course_id,title,duration_seconds)VALUES('lesson','course','First source lesson',600),('next','course','Second source lesson',600),('otherlesson','other','Unrelated source',600),('hiddenlesson','hidden','Hidden lesson',600);INSERT INTO enrollments(user_id,course_id)VALUES('alice','course'),('bob','course'),('alice','hidden');INSERT INTO transcript_chunks(id,lesson_id,start_seconds,end_seconds,text)VALUES('chunk','lesson',10,60,'Synthetic transactions source evidence: atomic operations preserve consistent database state.'),('nextchunk','next',20,60,'Synthetic dependent topic source evidence for advanced operations.'),('otherchunk','otherlesson',10,60,'Unrelated source belongs to another course.');`); e != nil {
		t.Fatal(e)
	}
	auth, e := identity.New(pool, identity.Config{PublicOrigin: "http://test", PasswordConcurrency: 1})
	if e != nil {
		t.Fatal(e)
	}
	q, e := jobs.New(pool, jobs.Config{MaxQueued: 100, MaxQueuedPerUser: 20, Lease: 30 * time.Second})
	if e != nil {
		t.Fatal(e)
	}
	s := New(pool, q)
	q.ResultProjector = ProjectResult
	mux := http.NewServeMux()
	s.Register(mux, auth)
	q.Register(mux, auth)
	return fixture{s, mux}
}
func (f fixture) call(user, method, path, key string, body any) *httptest.ResponseRecorder {
	raw, _ := json.Marshal(body)
	r := httptest.NewRequest(method, "http://test"+path, bytes.NewReader(raw))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", "http://test")
	r.Header.Set("X-CSRF-Token", "csrf")
	r.Header.Set("Idempotency-Key", key)
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
		t.Fatalf("HTTP status=%d expected=%d body=%s", w.Code, status, w.Body.String())
	}
}
func read[T any](t *testing.T, w *httptest.ResponseRecorder) T {
	t.Helper()
	var v T
	if e := json.Unmarshal(w.Body.Bytes(), &v); e != nil {
		t.Fatal(e)
	}
	return v
}
func definition(pathID string) Definition {
	return Definition{ID: pathID, Goal: "Learn database transactions", CourseIDs: []string{"course"}, Steps: []Step{{ID: "foundation", Title: "Transaction foundation", Objectives: []string{"Explain atomicity"}, Sources: []Source{{LessonID: "lesson", CourseID: "course", Start: 10, ChunkID: "chunk"}}, Prerequisites: []string{}}, {ID: "advanced", Title: "Advanced transaction topic", Sources: []Source{{LessonID: "next", CourseID: "course", Start: 20, ChunkID: "nextchunk"}}, Prerequisites: []string{"foundation"}}}}
}
func (f fixture) create(t *testing.T, user, pathID, key string) Path {
	t.Helper()
	w := f.call(user, "POST", "/api/v1/learning-paths/manual", key, definition(pathID))
	expect(t, w, 201)
	return read[Path](t, w)
}
func (f fixture) step(t *testing.T, pathID, step, key string, done bool, rev int64) Path {
	t.Helper()
	w := f.call("alice", "PUT", "/api/v1/learning-paths/"+pathID+"/steps/"+step, key, map[string]any{"completed": done, "expected_revision": rev})
	expect(t, w, 200)
	return read[Path](t, w)
}
func questions() []Question {
	qs := []Question{}
	for i := 0; i < 3; i++ {
		qs = append(qs, Question{ID: fmt.Sprintf("question%d", i), Question: fmt.Sprintf("What does transaction evidence establish in example %d?", i), Options: []string{"Atomic database change", "Unbounded network call", "No ownership checks", "Invented source data"}, CorrectIndex: 0, Explanation: "The synthetic source explicitly describes atomic operations.", Concept: "Transactions", Source: Source{LessonID: "lesson", CourseID: "course", Start: 10, ChunkID: "chunk"}, Excerpt: "atomic operations"})
	}
	return qs
}
func (f fixture) assessment(t *testing.T, pathID, key string, rev int64) string {
	t.Helper()
	w := f.call("alice", "POST", "/api/v1/learning-paths/"+pathID+"/steps/foundation/assessments/manual", key, map[string]any{"expected_revision": rev, "questions": questions()})
	expect(t, w, 201)
	a := read[map[string]any](t, w)
	return a["id"].(string)
}
func answers(v int) map[string]int {
	return map[string]int{"question0": v, "question1": v, "question2": v}
}
func p(user string) identity.Principal {
	return identity.Principal{UserID: user, SessionID: user + "auth", Role: "student", Verified: true}
}

func TestPrivateHTTPGuardsAndSourceScope(t *testing.T) {
	f := setup(t)
	for _, path := range []string{"/api/v1/learning-paths", "/api/v1/learning-paths/missing", "/api/v1/assessments/missing", "/api/v1/learning-paths/missing/assessment-history"} {
		expect(t, f.call("", "GET", path, "", nil), 401)
	}
	expect(t, f.call("unverified", "GET", "/api/v1/learning-paths", "", nil), 403)
	for _, guard := range []struct{ origin, csrf string }{{"http://hostile.test", "csrf"}, {"http://test", "wrong"}, {"http://test", ""}} {
		raw, _ := json.Marshal(definition("guarded"))
		r := httptest.NewRequest("POST", "http://test/api/v1/learning-paths/manual", bytes.NewReader(raw))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", guard.origin)
		r.Header.Set("X-CSRF-Token", guard.csrf)
		r.Header.Set("Idempotency-Key", "guard")
		r.AddCookie(&http.Cookie{Name: identity.CookieName, Value: "alicetoken"})
		w := httptest.NewRecorder()
		f.mux.ServeHTTP(w, r)
		expect(t, w, 403)
	}
	expect(t, f.call("outsider", "POST", "/api/v1/learning-paths/manual", "outside", definition("private")), 404)
	v := f.create(t, "alice", "private", "create")
	if v.Provenance != "manual" {
		t.Fatal("manual definition mislabeled")
	}
	for _, user := range []string{"bob", "admin", "outsider"} {
		expect(t, f.call(user, "GET", "/api/v1/learning-paths/private", "", nil), 404)
	}
	bad := definition("wrong")
	bad.Steps[0].Sources[0].LessonID = "otherlesson"
	expect(t, f.call("alice", "POST", "/api/v1/learning-paths/manual", "wrong", bad), 404)
	bad = definition("hidden")
	bad.CourseIDs = []string{"hidden"}
	bad.Steps = []Step{{ID: "topic", Title: "Hidden topic", Sources: []Source{{LessonID: "hiddenlesson", CourseID: "hidden", Start: 0}}}}
	expect(t, f.call("alice", "POST", "/api/v1/learning-paths/manual", "hidden", bad), 404)
}
func TestDefinitionBoundsDAGAndStablePaging(t *testing.T) {
	f := setup(t)
	for i, change := range []func(*Definition){func(d *Definition) { d.Steps[0].Prerequisites = []string{"advanced"} }, func(d *Definition) { d.Steps[0].Sources[0].Start = 601 }, func(d *Definition) { d.Steps[1].ID = "foundation" }, func(d *Definition) { d.CourseIDs = []string{"course", "course"} }, func(d *Definition) { d.Steps[0].Sources[0].ChunkID = "otherchunk" }} {
		d := definition(fmt.Sprintf("bad%d", i))
		change(&d)
		expect(t, f.call("alice", "POST", "/api/v1/learning-paths/manual", fmt.Sprintf("bad%d", i), d), 422)
	}
	a := f.create(t, "alice", "path_a", "create-a")
	b := f.create(t, "alice", "path_b", "create-b")
	if a.ID != "path_a" || a.Steps[0].ID != "foundation" || b.ID != "path_b" {
		t.Fatal("stable IDs changed")
	}
	w := f.call("alice", "GET", "/api/v1/learning-paths?limit=1", "", nil)
	expect(t, w, 200)
	page := read[struct {
		Paths []Path `json:"paths"`
		Next  string `json:"next_cursor"`
	}](t, w)
	if len(page.Paths) != 1 || page.Paths[0].ID != "path_b" || page.Next == "" {
		t.Fatal("unstable first page")
	}
	w = f.call("alice", "GET", "/api/v1/learning-paths?limit=1&cursor="+page.Next, "", nil)
	expect(t, w, 200)
	if !strings.Contains(w.Body.String(), "path_a") || strings.Contains(w.Body.String(), "path_b") {
		t.Fatal("unstable second page")
	}
	expect(t, f.call("alice", "GET", "/api/v1/learning-paths?limit=101", "", nil), 422)
}
func TestCompletionPrerequisitesCascadeAndRefresh(t *testing.T) {
	f := setup(t)
	v := f.create(t, "alice", "path", "create")
	expect(t, f.call("alice", "PUT", "/api/v1/learning-paths/path/steps/advanced", "locked", map[string]any{"completed": true, "expected_revision": v.Revision}), 409)
	v = f.step(t, "path", "foundation", "done-base", true, v.Revision)
	v = f.step(t, "path", "advanced", "done-next", true, v.Revision)
	if v.CompletedSteps != 2 || v.CompletionPercent != 100 {
		t.Fatal("manual completion incorrect")
	}
	refresh := definition("path")
	refresh.ExpectedRevision = v.Revision
	w := f.call("alice", "PUT", "/api/v1/learning-paths/path", "refresh", refresh)
	expect(t, w, 200)
	v = read[Path](t, w)
	if v.CompletedSteps != 2 {
		t.Fatal("unchanged step completion lost")
	}
	v = f.step(t, "path", "foundation", "clear", false, v.Revision)
	if v.CompletedSteps != 0 || v.NextStepID == nil || *v.NextStepID != "foundation" {
		t.Fatal("dependent completion not cleared")
	}
	expect(t, f.call("bob", "PUT", "/api/v1/learning-paths/path/steps/foundation", "stolen", map[string]any{"completed": true, "expected_revision": v.Revision}), 404)
}
func TestConcurrentExpectedRevisionHasOneWinner(t *testing.T) {
	f := setup(t)
	v := f.create(t, "alice", "path", "create")
	codes := make(chan int, 2)
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			codes <- f.call("alice", "PUT", "/api/v1/learning-paths/path/steps/foundation", fmt.Sprintf("race%d", i), map[string]any{"completed": true, "expected_revision": v.Revision}).Code
		}(i)
	}
	close(start)
	wg.Wait()
	close(codes)
	counts := map[int]int{}
	for code := range codes {
		counts[code]++
	}
	if counts[200] != 1 || counts[409] != 1 {
		t.Fatalf("concurrent statuses %+v", counts)
	}
}
func TestAssessmentPrivateProjectionImmutableAttemptAndMastery(t *testing.T) {
	f := setup(t)
	v := f.create(t, "alice", "path", "create")
	aid := f.assessment(t, "path", "assessment", v.Revision)
	w := f.call("alice", "GET", "/api/v1/assessments/"+aid, "", nil)
	expect(t, w, 200)
	if strings.Contains(w.Body.String(), "correct_index") || strings.Contains(w.Body.String(), "explanation") {
		t.Fatal("answer key leaked before attempt")
	}
	expect(t, f.call("bob", "GET", "/api/v1/assessments/"+aid, "", nil), 404)
	expect(t, f.call("bob", "POST", "/api/v1/assessments/"+aid+"/attempts", "stolen", map[string]any{"answers": answers(0)}), 404)
	w = f.call("alice", "POST", "/api/v1/assessments/"+aid+"/attempts", "grade", map[string]any{"answers": answers(0)})
	expect(t, w, 201)
	result := read[Result](t, w)
	if result.Score != 100 || result.Status != "ready_for_review" || len(result.Feedback) != 3 {
		t.Fatal("deterministic score/feedback incorrect")
	}
	again := f.call("alice", "POST", "/api/v1/assessments/"+aid+"/attempts", "grade", map[string]any{"answers": answers(0)})
	expect(t, again, 201)
	if read[Result](t, again).ID != result.ID {
		t.Fatal("duplicate attempt created")
	}
	expect(t, f.call("alice", "POST", "/api/v1/assessments/"+aid+"/attempts", "grade", map[string]any{"answers": answers(1)}), 409)
	w = f.call("alice", "GET", "/api/v1/learning-paths/path", "", nil)
	expect(t, w, 200)
	v = read[Path](t, w)
	if v.CompletedSteps != 0 || v.Steps[0].Mastery == nil || v.Steps[0].Mastery.Attempts != 1 {
		t.Fatal("mastery confused with manual completion")
	}
	w = f.call("alice", "POST", "/api/v1/assessments/"+aid+"/attempts", "fail", map[string]any{"answers": answers(1)})
	expect(t, w, 201)
	if read[Result](t, w).Status != "needs_practice" {
		t.Fatal("weak signal threshold incorrect")
	}
	w = f.call("alice", "GET", "/api/v1/learning-paths/path/assessment-history?limit=1", "", nil)
	expect(t, w, 200)
	if !strings.Contains(w.Body.String(), "next_cursor") || !strings.Contains(w.Body.String(), "feedback") {
		t.Fatal("immutable history/paging absent")
	}
	expect(t, f.call("bob", "GET", "/api/v1/learning-paths/path/assessment-history", "", nil), 404)
}
func TestAssessmentMalformedAnswersAndQuestions(t *testing.T) {
	f := setup(t)
	v := f.create(t, "alice", "path", "create")
	q := questions()
	q[0].Source.ChunkID = "otherchunk"
	expect(t, f.call("alice", "POST", "/api/v1/learning-paths/path/steps/foundation/assessments/manual", "bad-source", map[string]any{"expected_revision": v.Revision, "questions": q}), 422)
	aid := f.assessment(t, "path", "assessment", v.Revision)
	for i, body := range []any{map[string]any{"answers": map[string]int{"question0": 0}}, map[string]any{"answers": map[string]int{"question0": 4, "question1": 0, "question2": 0}}, map[string]any{"answers": map[string]any{"question0": nil, "question1": 0, "question2": 0}}, map[string]any{"answers": map[string]int{"invented": 0, "question1": 0, "question2": 0}}} {
		expect(t, f.call("alice", "POST", "/api/v1/assessments/"+aid+"/attempts", fmt.Sprintf("bad%d", i), body), 422)
	}
	raw, _ := json.Marshal(questions())
	raw = bytes.Replace(raw, []byte(`"correct_index":0`), []byte(`"correct_index":null`), 1)
	var output []Question
	if json.Unmarshal(raw, &output) == nil {
		t.Fatal("null answer index accepted")
	}
}
func TestSourceChangeBlocksNewAttemptsRetainsHistoricalSnapshots(t *testing.T) {
	f := setup(t)
	v := f.create(t, "alice", "path", "create")
	aid := f.assessment(t, "path", "assessment", v.Revision)
	body := map[string]any{"answers": answers(0)}
	w := f.call("alice", "POST", "/api/v1/assessments/"+aid+"/attempts", "original", body)
	expect(t, w, 201)
	original := read[Result](t, w)
	if _, e := f.s.Pool.Exec(context.Background(), `UPDATE transcript_chunks SET text='Changed source text at the same authorized source' WHERE id='chunk'`); e != nil {
		t.Fatal(e)
	}
	w = f.call("alice", "GET", "/api/v1/learning-paths/path", "", nil)
	expect(t, w, 200)
	if !read[Path](t, w).Outdated {
		t.Fatal("changed source not outdated")
	}
	expect(t, f.call("alice", "POST", "/api/v1/assessments/"+aid+"/attempts", "new", body), 409)
	w = f.call("alice", "POST", "/api/v1/assessments/"+aid+"/attempts", "original", body)
	expect(t, w, 201)
	if digest(read[Result](t, w)) != digest(original) {
		t.Fatal("historical immutable feedback changed")
	}
}
func TestCommandReplayDeniesDeletedMovedOrRevokedSources(t *testing.T) {
	for _, change := range []string{"delete", "move", "revoke", "chunk"} {
		t.Run(change, func(t *testing.T) {
			f := setup(t)
			d := definition("path")
			f.create(t, "alice", "path", "create")
			query := map[string]string{"delete": `DELETE FROM lessons WHERE id='lesson'`, "move": `UPDATE lessons SET course_id='other' WHERE id='lesson'`, "revoke": `DELETE FROM enrollments WHERE user_id='alice' AND course_id='course'`, "chunk": `DELETE FROM transcript_chunks WHERE id='chunk'`}[change]
			if _, e := f.s.Pool.Exec(context.Background(), query); e != nil {
				t.Fatal(e)
			}
			w := f.call("alice", "POST", "/api/v1/learning-paths/manual", "create", d)
			expect(t, w, 404)
			if strings.Contains(w.Body.String(), "foundation") {
				t.Fatal("inaccessible snapshot content leaked")
			}
		})
	}
}
func TestDeletedAndEditedPathReplayDoesNotResurrectState(t *testing.T) {
	f := setup(t)
	v := f.create(t, "alice", "path", "create")
	changed := definition("path")
	changed.ExpectedRevision = v.Revision
	changed.Steps = changed.Steps[:1]
	w := f.call("alice", "PUT", "/api/v1/learning-paths/path", "trim", changed)
	expect(t, w, 200)
	v = read[Path](t, w)
	w = f.call("alice", "POST", "/api/v1/learning-paths/manual", "create", definition("path"))
	expect(t, w, 201)
	if len(read[Path](t, w).Steps) != 2 {
		t.Fatal("original acknowledgment was silently rewritten")
	}
	w = f.call("alice", "GET", "/api/v1/learning-paths/path", "", nil)
	expect(t, w, 200)
	if len(read[Path](t, w).Steps) != 1 {
		t.Fatal("replay resurrected removed step")
	}
	body := map[string]any{"expected_revision": v.Revision}
	expect(t, f.call("alice", "DELETE", "/api/v1/learning-paths/path", "delete", body), 200)
	expect(t, f.call("alice", "DELETE", "/api/v1/learning-paths/path", "delete", body), 200)
	expect(t, f.call("alice", "POST", "/api/v1/learning-paths/manual", "create", definition("path")), 201)
	expect(t, f.call("alice", "GET", "/api/v1/learning-paths/path", "", nil), 404)
}
func TestUnavailableGenerationNeverQueuesOrFabricates(t *testing.T) {
	f := setup(t)
	body := map[string]any{"course_ids": []string{"course"}, "goal": "Learn source topics", "expected_revision": 0}
	w := f.call("alice", "POST", "/api/v1/learning-paths", "unavailable", body)
	expect(t, w, 503)
	if !strings.Contains(w.Body.String(), "generation_unavailable") {
		t.Fatal("generation error not honest")
	}
	v := f.create(t, "alice", "path", "create")
	expect(t, f.call("alice", "POST", "/api/v1/learning-paths/path/steps/foundation/assessments", "no-assessment", map[string]any{"count": 3, "expected_revision": v.Revision}), 503)
	var count int
	if e := f.s.Pool.QueryRow(context.Background(), `SELECT count(*) FROM jobs`).Scan(&count); e != nil || count != 0 {
		t.Fatalf("unavailable generation queued=%d error=%v", count, e)
	}
}
func publish(t *testing.T, f fixture, lease jobs.Lease, result GenerationResult) error {
	t.Helper()
	raw, _ := json.Marshal(result)
	return f.s.Queue.Complete(context.Background(), lease, raw, func(ctx context.Context, tx pgx.Tx) error { return f.s.PublishResult(ctx, tx, lease.Job, raw) })
}
func TestTypedPathGenerationPublisherRejectsInventedAndStaleSources(t *testing.T) {
	f := setup(t)
	f.s.ExecutorAvailable = true
	body := map[string]any{"course_ids": []string{"course"}, "goal": "Learn source topics", "expected_revision": 0}
	w := f.call("alice", "POST", "/api/v1/learning-paths", "generate", body)
	expect(t, w, 202)
	job := read[jobs.Job](t, w)
	again := f.call("alice", "POST", "/api/v1/learning-paths", "generate", body)
	expect(t, again, 202)
	if read[jobs.Job](t, again).ID != job.ID {
		t.Fatal("generation duplicated")
	}
	lease, e := f.s.Queue.Claim(context.Background(), "ai", "worker")
	if e != nil {
		t.Fatal(e)
	}
	var payload GenerationPayload
	if e = json.Unmarshal(lease.Job.Payload, &payload); e != nil {
		t.Fatal(e)
	}
	valid := GenerationResult{Version: 1, Product: "learning_path", Steps: []Step{{ID: "stable-topic", Title: "Real source topic", Sources: []Source{payload.Sources[0]}, Prerequisites: []string{}}}}
	bad := valid
	bad.Steps = append([]Step(nil), valid.Steps...)
	bad.Steps[0].Sources = []Source{{LessonID: "otherlesson", CourseID: "other", Start: 10, ChunkID: "otherchunk"}}
	if e = publish(t, f, lease, bad); !errors.Is(e, jobs.ErrInvalid) {
		t.Fatalf("invented publication error=%v", e)
	}
	expect(t, f.call("alice", "GET", "/api/v1/learning-paths/"+payload.PathID, "", nil), 404)
	if e = publish(t, f, lease, valid); e != nil {
		t.Fatal(e)
	}
	w = f.call("alice", "GET", "/api/v1/learning-paths/"+payload.PathID, "", nil)
	expect(t, w, 200)
	v := read[Path](t, w)
	if v.Provenance != "generated" || v.Steps[0].ID != "stable-topic" {
		t.Fatal("generated provenance/ID invalid")
	}
	if e = publish(t, f, lease, valid); !errors.Is(e, jobs.ErrStale) {
		t.Fatal("stale completion accepted")
	}
}
func TestTypedAssessmentPublisherFencingScopeAndSnapshot(t *testing.T) {
	f := setup(t)
	f.s.ExecutorAvailable = true
	v := f.create(t, "alice", "path", "create")
	w := f.call("alice", "POST", "/api/v1/learning-paths/path/steps/foundation/assessments", "generate-assessment", map[string]any{"count": 3, "expected_revision": v.Revision})
	expect(t, w, 202)
	lease, e := f.s.Queue.Claim(context.Background(), "ai", "worker")
	if e != nil {
		t.Fatal(e)
	}
	result := GenerationResult{Version: 1, Product: "topic_assessment", Questions: questions()}
	bad := result
	bad.Questions = append([]Question(nil), result.Questions...)
	bad.Questions[0].Source.ChunkID = "otherchunk"
	if e = publish(t, f, lease, bad); !errors.Is(e, jobs.ErrInvalid) {
		t.Fatalf("foreign assessment source accepted %v", e)
	}
	if e = publish(t, f, lease, result); e != nil {
		t.Fatal(e)
	}
	var aid string
	if e = f.s.Pool.QueryRow(context.Background(), `SELECT id FROM topic_assessments WHERE provenance='generated'`).Scan(&aid); e != nil {
		t.Fatal(e)
	}
	expect(t, f.call("alice", "GET", "/api/v1/assessments/"+aid, "", nil), 200)
	expect(t, f.call("bob", "GET", "/api/v1/assessments/"+aid, "", nil), 404)
}
func TestRevokedOrCanceledGeneratedResultCannotPublish(t *testing.T) {
	for _, reason := range []string{"revoked", "canceled", "changed"} {
		t.Run(reason, func(t *testing.T) {
			f := setup(t)
			f.s.ExecutorAvailable = true
			v := f.create(t, "alice", "path", "create")
			w := f.call("alice", "POST", "/api/v1/learning-paths/path/steps/foundation/assessments", "generated", map[string]any{"count": 3, "expected_revision": v.Revision})
			expect(t, w, 202)
			j := read[jobs.Job](t, w)
			lease, e := f.s.Queue.Claim(context.Background(), "ai", "worker")
			if e != nil {
				t.Fatal(e)
			}
			switch reason {
			case "revoked":
				_, e = f.s.Pool.Exec(context.Background(), `DELETE FROM enrollments WHERE user_id='alice' AND course_id='course'`)
			case "changed":
				_, e = f.s.Pool.Exec(context.Background(), `UPDATE transcript_chunks SET text='changed' WHERE id='chunk'`)
			case "canceled":
				expect(t, f.call("alice", "POST", "/api/v1/jobs/"+j.ID+"/cancel", "", map[string]any{}), 200)
			}
			if e != nil {
				t.Fatal(e)
			}
			if e = publish(t, f, lease, GenerationResult{Version: 1, Product: "topic_assessment", Questions: questions()}); e == nil {
				t.Fatal("invalidated publication accepted")
			}
			var count int
			if e = f.s.Pool.QueryRow(context.Background(), `SELECT count(*) FROM topic_assessments`).Scan(&count); e != nil || count != 0 {
				t.Fatalf("invalid result persisted count=%d error=%v", count, e)
			}
		})
	}
}
func TestPlanningAdapterUsesPrivateUnlockedAuthorizedSource(t *testing.T) {
	f := setup(t)
	f.create(t, "alice", "path", "create")
	ctx := context.Background()
	tx, e := f.s.Pool.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback(ctx)
	a := PlanningAdapter{Service: f.s}
	course, e := a.Validate(ctx, tx, p("alice"), "path")
	if e != nil || course != "course" {
		t.Fatalf("adapter scope=%s error=%v", course, e)
	}
	items, warnings, e := a.Candidates(ctx, tx, p("alice"), "path", time.Now(), "UTC")
	if e != nil || len(items) != 1 || len(warnings) == 0 || items[0].Action.LessonID == nil || *items[0].Action.LessonID != "lesson" {
		t.Fatalf("candidates=%+v warnings=%+v error=%v", items, warnings, e)
	}
	if e = a.ValidateCandidate(ctx, tx, p("alice"), "path", items[0]); e != nil {
		t.Fatal(e)
	}
	if _, e = a.Validate(ctx, tx, p("bob"), "path"); !errors.Is(e, pgx.ErrNoRows) {
		t.Fatal("adapter leaked another learner path")
	}
	bad := items[0]
	lesson := "otherlesson"
	bad.Action.LessonID = &lesson
	if e = a.ValidateCandidate(ctx, tx, p("alice"), "path", bad); !errors.Is(e, pgx.ErrNoRows) {
		t.Fatal("adapter accepted unrelated lesson")
	}
	var _ planning.PathAdapter = a
}

func TestConcurrentIdenticalAssessmentAttemptHasOneDurableResult(t *testing.T) {
	f := setup(t)
	v := f.create(t, "alice", "path", "create")
	aid := f.assessment(t, "path", "assessment", v.Revision)
	output := make(chan *httptest.ResponseRecorder, 2)
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			output <- f.call("alice", "POST", "/api/v1/assessments/"+aid+"/attempts", "same-command", map[string]any{"answers": answers(0)})
		}()
	}
	close(start)
	wg.Wait()
	close(output)
	ids := map[string]bool{}
	for w := range output {
		expect(t, w, 201)
		ids[read[Result](t, w).ID] = true
	}
	var count int
	if e := f.s.Pool.QueryRow(context.Background(), `SELECT count(*) FROM topic_assessment_attempts`).Scan(&count); e != nil || count != 1 || len(ids) != 1 {
		t.Fatalf("duplicate durable results count=%d ids=%d error=%v", count, len(ids), e)
	}
}

func TestAssessmentAndHistoryRecheckArchivedCitationScopeAfterPathRefresh(t *testing.T) {
	f := setup(t)
	v := f.create(t, "alice", "path", "create")
	aid := f.assessment(t, "path", "assessment", v.Revision)
	body := map[string]any{"answers": answers(0)}
	expect(t, f.call("alice", "POST", "/api/v1/assessments/"+aid+"/attempts", "attempt", body), 201)
	d := definition("path")
	d.ExpectedRevision = v.Revision
	d.Steps = []Step{{ID: "newtopic", Title: "Replacement source topic", Sources: []Source{{LessonID: "next", CourseID: "course", Start: 20, ChunkID: "nextchunk"}}, Prerequisites: []string{}}}
	expect(t, f.call("alice", "PUT", "/api/v1/learning-paths/path", "refresh", d), 200)
	// Definitions can stop referencing a lesson; archived feedback still must check
	// that lesson's current course binding before it is returned.
	if _, e := f.s.Pool.Exec(context.Background(), `UPDATE lessons SET course_id='other' WHERE id='lesson'`); e != nil {
		t.Fatal(e)
	}
	expect(t, f.call("alice", "GET", "/api/v1/assessments/"+aid, "", nil), 404)
	expect(t, f.call("alice", "POST", "/api/v1/assessments/"+aid+"/attempts", "attempt", body), 404)
	w := f.call("alice", "GET", "/api/v1/learning-paths/path/assessment-history", "", nil)
	expect(t, w, 200)
	if strings.Contains(w.Body.String(), "atomic operations") || strings.Contains(w.Body.String(), aid) {
		t.Fatal("inaccessible archived feedback/citation leaked")
	}
}

func TestGeneratedPublisherReadsAuthoritativeQueueScope(t *testing.T) {
	f := setup(t)
	f.s.ExecutorAvailable = true
	v := f.create(t, "alice", "path", "create")
	expect(t, f.call("alice", "POST", "/api/v1/learning-paths/path/steps/foundation/assessments", "gen", map[string]any{"count": 3, "expected_revision": v.Revision}), 202)
	lease, e := f.s.Queue.Claim(context.Background(), "ai", "worker")
	if e != nil {
		t.Fatal(e)
	}
	raw, _ := json.Marshal(GenerationResult{Version: 1, Product: "topic_assessment", Questions: questions()})
	forged := lease.Job
	forged.UserID = "bob"
	e = f.s.Queue.Complete(context.Background(), lease, raw, func(ctx context.Context, tx pgx.Tx) error { return f.s.PublishResult(ctx, tx, forged, raw) })
	if !errors.Is(e, jobs.ErrDenied) {
		t.Fatalf("forged passed-in job owner accepted error=%v", e)
	}
	if e = publish(t, f, lease, GenerationResult{Version: 1, Product: "topic_assessment", Questions: questions()}); e != nil {
		t.Fatal(e)
	}
}

func TestStablePathIDMatchesLegacyNamespaceIncludingUnicode(t *testing.T) {
	for _, tc := range []struct {
		user           string
		courses        []string
		goal, expected string
	}{
		{"alice", []string{"course"}, "Learn source topics", "lp_fb422d7f22e2e9d58266"},
		{"alice", []string{"Zoo", "école"}, "Straße 🐍 <SQL>", "lp_99315a55b9dbe9f308df"},
	} {
		if actual := StablePathID(tc.user, tc.courses, tc.goal); actual != tc.expected {
			t.Fatalf("stable legacy namespace mismatch got=%s expected=%s", actual, tc.expected)
		}
	}
	if StablePathID("alice", []string{"course"}, "LEARN SOURCE TOPICS") != StablePathID("alice", []string{"course"}, "learn source topics") {
		t.Fatal("goal casing changed stable ID")
	}
}

func TestTopicMasteryThresholdsRemainPracticeSignals(t *testing.T) {
	for score, expected := range map[int]string{0: "needs_practice", 69: "needs_practice", 70: "developing", 84: "developing", 85: "ready_for_review", 100: "ready_for_review"} {
		if masteryStatus(score) != expected {
			t.Fatalf("score=%d expected=%s", score, expected)
		}
	}
}

func TestJobResultProjectionHidesTopicKeysAndPreservesOtherProducts(t *testing.T) {
	raw, _ := json.Marshal(GenerationResult{Version: 1, Product: "topic_assessment", Questions: questions()})
	for _, state := range []string{"completed", "running"} {
		scope, _ := json.Marshal(GenerationPayload{Version: 1, Product: "topic_assessment"})
		job := jobs.Job{ID: "job_fixture", Kind: "quiz", State: state, Payload: scope, Result: raw}
		public := ProjectJobResult(job)
		if strings.Contains(string(public.Result), "correct_index") || strings.Contains(string(public.Result), "explanation") || strings.Contains(string(public.Result), "questions") {
			t.Fatal("job result bypassed assessment answer-key projection")
		}
		if !strings.Contains(string(public.Result), GeneratedAssessmentID(job.ID)) {
			t.Fatal("stable assessment reference missing")
		}
		if !bytes.Equal(job.Result, raw) {
			t.Fatal("private durable result was mutated")
		}
	}
	scope, _ := json.Marshal(GenerationPayload{Version: 1, Product: "learning_path", PathID: "private_path"})
	job := jobs.Job{ID: "pathjob", Kind: "path", Payload: scope, Result: json.RawMessage(`{"steps":[{"id":"topic","title":"Private generated content"}]}`)}
	public, handled := ProjectResult(job)
	if !handled || !strings.Contains(string(public), `"path_id":"private_path"`) || strings.Contains(string(public), "Private generated content") || strings.Contains(string(public), "steps") {
		t.Fatal("path status must carry only the resource reference")
	}
	job = jobs.Job{ID: "otherjob", Kind: "tutor", Payload: json.RawMessage(`{"question":"synthetic"}`), Result: json.RawMessage(`{"answer":"source-backed explanation"}`)}
	if _, handled := ProjectResult(job); handled || !bytes.Equal(ProjectJobResult(job).Result, job.Result) {
		t.Fatal("unrelated product output claimed or changed")
	}
	queued := jobs.Job{ID: "queued", Payload: json.RawMessage(`{"product":"topic_assessment"}`)}
	if ProjectJobResult(queued).Result != nil {
		t.Fatal("queued job acquired invented completion result")
	}
	for _, payload := range []string{`{"version":9,"product":"topic_assessment"}`, `{"version":1,"product":"learning_path","path_id":"invalid/path"}`} {
		job := jobs.Job{ID: "malformed", Kind: "quiz", Payload: json.RawMessage(payload), Result: raw}
		if public, handled := ProjectResult(job); !handled || len(public) != 0 {
			t.Fatal("known malformed namespace returned a result")
		}
	}
}

func TestCompletedTopicJobHTTPStatusAndEnqueueReplayCannotRevealAnswers(t *testing.T) {
	f := setup(t)
	f.s.ExecutorAvailable = true
	v := f.create(t, "alice", "private_path", "create")
	body := map[string]any{"count": 3, "expected_revision": v.Revision}
	route := "/api/v1/learning-paths/private_path/steps/foundation/assessments"
	w := f.call("alice", "POST", route, "generated", body)
	expect(t, w, 202)
	job := read[jobs.Job](t, w)
	lease, err := f.s.Queue.Claim(context.Background(), "ai", "worker")
	if err != nil {
		t.Fatal(err)
	}
	if err = publish(t, f, lease, GenerationResult{Version: 1, Product: "topic_assessment", Questions: questions()}); err != nil {
		t.Fatal(err)
	}
	f.step(t, "private_path", "foundation", "complete", true, v.Revision)
	if _, err = f.s.Pool.Exec(context.Background(), `UPDATE transcript_chunks SET text='Changed source text after accepted generation' WHERE id='chunk'`); err != nil {
		t.Fatal(err)
	}
	f.s.ExecutorAvailable = false // Retry must not require starting a new executor.
	for _, req := range []struct {
		method, route, key string
		body               any
	}{
		{"GET", "/api/v1/jobs/" + job.ID, "", nil},
		{"GET", "/api/v1/jobs", "", nil},
		{"POST", route, "generated", body},
	} {
		w = f.call("alice", req.method, req.route, req.key, req.body)
		status := 200
		if req.method == "POST" {
			status = 202
		}
		expect(t, w, status)
		if !strings.Contains(w.Body.String(), GeneratedAssessmentID(job.ID)) || strings.Contains(w.Body.String(), "correct_index") || strings.Contains(w.Body.String(), "explanation") || strings.Contains(w.Body.String(), "questions") {
			t.Fatalf("public job response exposed private executor content: %s", w.Body.String())
		}
	}
	expect(t, f.call("bob", "GET", "/api/v1/jobs/"+job.ID, "", nil), 404)
	for _, changed := range []map[string]any{{"count": 4, "expected_revision": v.Revision}, {"count": 3, "expected_revision": v.Revision + 1}} {
		expect(t, f.call("alice", "POST", route, "generated", changed), 409)
	}
	aid := GeneratedAssessmentID(job.ID)
	w = f.call("alice", "GET", "/api/v1/assessments/"+aid, "", nil)
	expect(t, w, 200)
	if strings.Contains(w.Body.String(), "correct_index") || strings.Contains(w.Body.String(), "explanation") {
		t.Fatal("assessment reference bypassed private question projection")
	}
	if _, err = f.s.Pool.Exec(context.Background(), `DELETE FROM enrollments WHERE user_id='alice' AND course_id='course'`); err != nil {
		t.Fatal(err)
	}
	expect(t, f.call("alice", "GET", "/api/v1/assessments/"+aid, "", nil), 404)
	expect(t, f.call("alice", "POST", route, "generated", body), 404)
}

func TestGeneratedPathReplayRetainsOriginalCommandAfterRefreshAndRechecksSources(t *testing.T) {
	f := setup(t)
	f.s.ExecutorAvailable = true
	body := map[string]any{"course_ids": []string{"course"}, "goal": "Learn source topics", "expected_revision": 0}
	w := f.call("alice", "POST", "/api/v1/learning-paths", "generated", body)
	expect(t, w, 202)
	job := read[jobs.Job](t, w)
	lease, err := f.s.Queue.Claim(context.Background(), "ai", "worker")
	if err != nil {
		t.Fatal(err)
	}
	var payload GenerationPayload
	if err = json.Unmarshal(lease.Job.Payload, &payload); err != nil {
		t.Fatal(err)
	}
	result := GenerationResult{Version: 1, Product: "learning_path", Steps: []Step{{ID: "foundation", Title: "Original generated topic", Sources: []Source{payload.Sources[0]}}}}
	if err = publish(t, f, lease, result); err != nil {
		t.Fatal(err)
	}
	d := Definition{ID: payload.PathID, Goal: "Updated learner goal", CourseIDs: []string{"course"}, ExpectedRevision: 1, Steps: result.Steps}
	expect(t, f.call("alice", "PUT", "/api/v1/learning-paths/"+payload.PathID, "refresh", d), 200)
	if _, err = f.s.Pool.Exec(context.Background(), `UPDATE transcript_chunks SET text='Changed original source text' WHERE id=$1`, payload.Sources[0].ChunkID); err != nil {
		t.Fatal(err)
	}
	f.s.ExecutorAvailable = false
	w = f.call("alice", "POST", "/api/v1/learning-paths", "generated", body)
	expect(t, w, 202)
	if replay := read[jobs.Job](t, w); replay.ID != job.ID || replay.State != "completed" || strings.Contains(string(replay.Result), "steps") {
		t.Fatal("generation replay lost original safe acknowledgment")
	}
	expect(t, f.call("alice", "POST", "/api/v1/learning-paths", "generated", map[string]any{"course_ids": []string{"course"}, "goal": "Different request goal", "expected_revision": 0}), 409)
	var count int
	if err = f.s.Pool.QueryRow(context.Background(), `SELECT count(*) FROM jobs`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("retry changed job count=%d error=%v", count, err)
	}
	if _, err = f.s.Pool.Exec(context.Background(), `DELETE FROM transcript_chunks WHERE id=$1`, payload.Sources[0].ChunkID); err != nil {
		t.Fatal(err)
	}
	expect(t, f.call("alice", "POST", "/api/v1/learning-paths", "generated", body), 404)
}
