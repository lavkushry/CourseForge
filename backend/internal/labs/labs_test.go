package labs

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
	s   *Service
	mux *http.ServeMux
}

func setup(t *testing.T) fixture {
	t.Helper()
	pool := testutil.Postgres(t)
	ctx := context.Background()
	for _, user := range []string{"alice", "bob", "admin", "unverified"} {
		role := "student"
		if user == "admin" {
			role = "admin"
		}
		if _, e := pool.Exec(ctx, `INSERT INTO users(id,email,name,password_hash,role,verified)VALUES($1,$1||'@example.test',$1,'disabled',$2,$3)`, user, role, user != "unverified"); e != nil {
			t.Fatal(e)
		}
		if _, e := pool.Exec(ctx, `INSERT INTO auth_sessions(id,user_id,token_hash,csrf_token,expires_at)VALUES($1,$2,$3,'csrf',now()+interval '1 hour')`, user+"auth", user, identity.Digest(user+"token")); e != nil {
			t.Fatal(e)
		}
	}
	auth, e := identity.New(pool, identity.Config{PublicOrigin: "http://test", PasswordConcurrency: 1})
	if e != nil {
		t.Fatal(e)
	}
	service := New(pool)
	mux := http.NewServeMux()
	service.Register(mux, auth)
	return fixture{service, mux}
}
func (f fixture) call(user, method, route, key string, body any) *httptest.ResponseRecorder {
	raw, _ := json.Marshal(body)
	r := httptest.NewRequest(method, "http://test"+route, bytes.NewReader(raw))
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
		t.Fatalf("HTTP%d expected%d body=%s", w.Code, status, w.Body.String())
	}
}
func read[T any](t *testing.T, w *httptest.ResponseRecorder) T {
	t.Helper()
	var value T
	if e := json.Unmarshal(w.Body.Bytes(), &value); e != nil {
		t.Fatal(e)
	}
	return value
}
func (f fixture) start(t *testing.T, user, slug, key string) Session {
	t.Helper()
	w := f.call(user, "POST", "/api/v1/labs/"+slug+"/start", key, map[string]any{})
	expect(t, w, 201)
	return read[Session](t, w)
}
func (f fixture) save(t *testing.T, id, key, content string, rev int64) *httptest.ResponseRecorder {
	t.Helper()
	return f.call("alice", "PUT", "/api/v1/lab-sessions/"+id+"/file", key, map[string]any{"content": content, "expected_revision": rev})
}
func (f fixture) seedSubmittedSnapshot(t *testing.T, session Session, id string, passed bool) {
	// Explicit historical fixtures exercise private immutable storage/read behavior.
	// These have NO queued job/runner and cannot prove execution or publication.
	t.Helper()
	ctx := context.Background()
	if _, e := f.s.Pool.Exec(ctx, `INSERT INTO lab_submissions(id,user_id,session_id,revision,content_hash,grader_version)VALUES($1,'alice',$2,$3,$4,'legacy-fixture-version')`, id, session.SessionID, session.Revision, session.ContentHash); e != nil {
		t.Fatal(e)
	}
	checks, _ := json.Marshal([]Check{{Name: "Historical fixture check", Passed: passed, Details: "Retained feedback"}})
	if _, e := f.s.Pool.Exec(ctx, `INSERT INTO lab_grades(id,user_id,submission_id,passed,checks,provenance,completed_at)VALUES($1,'alice',$2,$3,$4,'{"origin":"legacy-fixture"}',now())`, "grade_"+id, id, passed, checks); e != nil {
		t.Fatal(e)
	}
}

func TestEightCuratedCatalogDefinitionsAndUnavailableGrading(t *testing.T) {
	f := setup(t)
	w := f.call("alice", "GET", "/api/v1/labs", "", nil)
	expect(t, w, 200)
	var result struct {
		Labs      []Definition `json:"labs"`
		Available bool         `json:"grading_available"`
		Kind      bool         `json:"kind_available"`
	}
	result = read[struct {
		Labs      []Definition `json:"labs"`
		Available bool         `json:"grading_available"`
		Kind      bool         `json:"kind_available"`
	}](t, w)
	want := map[string]string{"python-log-analysis": "solution.py", "shell-http-analysis": "solution.sh", "k8s-resilient-service": "manifest.yaml", "sql-customer-revenue": "solution.sql", "pyspark-order-analytics": "solution.py", "docker-hardened-service": "Dockerfile", "ansible-idempotent-web": "playbook.yml", "backend-request-handler": "solution.py"}
	if len(result.Labs) != 8 || result.Available || result.Kind {
		t.Fatal("catalog or capability claim wrong")
	}
	previous := ""
	for _, value := range result.Labs {
		if want[value.Slug] != value.Filename || value.Title == "" || value.Objective == "" || value.Starter != "" || value.Slug <= previous {
			t.Fatal("curated metadata changed or starter leaked", value.Slug)
		}
		previous = value.Slug
	}
	if definitions["docker-hardened-service"].Type != "static" || definitions["sql-customer-revenue"].Type != "sql" || definitions["pyspark-order-analytics"].Type != "pyspark" {
		t.Fatal("execution/static semantics collapsed")
	}
}
func TestWorkspacePrivateIdentityAndCSRFGuards(t *testing.T) {
	f := setup(t)
	v := f.start(t, "alice", "sql-customer-revenue", "start")
	for _, route := range []string{"/api/v1/labs", "/api/v1/lab-sessions", "/api/v1/lab-sessions/" + v.SessionID, "/api/v1/lab-sessions/" + v.SessionID + "/submissions", "/api/v1/lab-submissions/missing"} {
		expect(t, f.call("", "GET", route, "", nil), 401)
	}
	for _, user := range []string{"bob", "admin"} {
		expect(t, f.call(user, "GET", "/api/v1/lab-sessions/"+v.SessionID, "", nil), 404)
		expect(t, f.call(user, "PUT", "/api/v1/lab-sessions/"+v.SessionID+"/file", "foreign", map[string]any{"content": "private", "expected_revision": 1}), 404)
		expect(t, f.call(user, "POST", "/api/v1/lab-sessions/"+v.SessionID+"/submit", "foreign", map[string]any{"expected_revision": 1}), 404)
	}
	expect(t, f.call("unverified", "GET", "/api/v1/labs", "", nil), 403)
	for _, guard := range []struct{ origin, csrf string }{{"http://hostile", "csrf"}, {"http://test", ""}, {"http://test", "bad"}} {
		r := httptest.NewRequest("POST", "http://test/api/v1/labs/sql-customer-revenue/start", strings.NewReader(`{}`))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", guard.origin)
		r.Header.Set("X-CSRF-Token", guard.csrf)
		r.AddCookie(&http.Cookie{Name: identity.CookieName, Value: "alicetoken"})
		w := httptest.NewRecorder()
		f.mux.ServeHTTP(w, r)
		expect(t, w, 403)
	}
}
func TestStandaloneStarterSessionsAndExactSourceHashes(t *testing.T) {
	f := setup(t)
	for slug, d := range definitions {
		v := f.start(t, "alice", slug, "start_"+slug)
		if v.Content != d.Starter || v.Filename != d.Filename || v.ContentHash != bytesHash([]byte(v.Content)) || v.Revision != 1 || v.Status != "started" || v.GradingAvailable || v.Result != nil {
			t.Fatal("starter or owned SQL workspace behavior changed", slug)
		}
		w := f.call("alice", "GET", "/api/v1/lab-sessions/"+v.SessionID, "", nil)
		expect(t, w, 200)
		if read[Session](t, w).Content != v.Content {
			t.Fatal("starter not durable")
		}
	}
	var courses int
	if e := f.s.Pool.QueryRow(context.Background(), `SELECT count(*) FROM courses`).Scan(&courses); e != nil || courses != 0 {
		t.Fatal("standalone labs invented course/lesson scope")
	}
}
func TestIdempotentStartAndFileReplayNeverOverwriteLaterWork(t *testing.T) {
	f := setup(t)
	v := f.start(t, "alice", "sql-customer-revenue", "start")
	same := f.start(t, "alice", "sql-customer-revenue", "start")
	if same.SessionID != v.SessionID {
		t.Fatal("start duplicated workspace")
	}
	expect(t, f.call("alice", "POST", "/api/v1/labs/python-log-analysis/start", "start", map[string]any{}), 409)
	expect(t, f.save(t, v.SessionID, "edit", "SELECT customer_name FROM source;", 1), 200)
	expect(t, f.save(t, v.SessionID, "next", "SELECT current_solution FROM source;", 2), 200)
	w := f.save(t, v.SessionID, "edit", "SELECT customer_name FROM source;", 1)
	expect(t, w, 200)
	if read[map[string]any](t, w)["revision"] != float64(2) {
		t.Fatal("retry changed original ack")
	}
	w = f.call("alice", "GET", "/api/v1/lab-sessions/"+v.SessionID, "", nil)
	expect(t, w, 200)
	current := read[Session](t, w)
	if current.Revision != 3 || current.Content != "SELECT current_solution FROM source;" {
		t.Fatal("old retry overwrote later source")
	}
	original := f.start(t, "alice", "sql-customer-revenue", "start")
	if original.Revision != 1 || original.Content != v.Content {
		t.Fatal("start replay silently mutated original snapshot")
	}
	expect(t, f.save(t, v.SessionID, "edit", "Different request", 1), 409)
}
func TestConcurrentSourceRevisionHasOneWinner(t *testing.T) {
	f := setup(t)
	v := f.start(t, "alice", "backend-request-handler", "start")
	var wg sync.WaitGroup
	responses := make(chan *httptest.ResponseRecorder, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			responses <- f.call("alice", "PUT", "/api/v1/lab-sessions/"+v.SessionID+"/file", fmt.Sprintf("edit_%d", i), map[string]any{"content": fmt.Sprintf("# source revision %d", i), "expected_revision": 1})
		}(i)
	}
	wg.Wait()
	close(responses)
	winners := 0
	for w := range responses {
		if w.Code == 200 {
			winners++
		} else {
			expect(t, w, 409)
		}
	}
	if winners != 1 {
		t.Fatal("optimistic revision had multiple winners", winners)
	}
	var revisions int
	if e := f.s.Pool.QueryRow(context.Background(), `SELECT count(*) FROM lab_revisions WHERE session_id=$1`, v.SessionID).Scan(&revisions); e != nil || revisions != 2 {
		t.Fatal("losing writes persisted revisions", revisions, e)
	}
}
func TestLegacyHundredKilobyteUTF8FileLimitAndEscapedTransport(t *testing.T) {
	f := setup(t)
	v := f.start(t, "alice", "python-log-analysis", "start")
	large := strings.Repeat("x", 100000)
	expect(t, f.save(t, v.SessionID, "large", large, 1), 200)
	expect(t, f.save(t, v.SessionID, "too_large", large+"x", 2), 422)
	multi := strings.Repeat("界", 33333)
	expect(t, f.save(t, v.SessionID, "unicode", multi, 2), 200)
	expect(t, f.save(t, v.SessionID, "unicode_large", multi+"界", 3), 422)
	escaped := strings.Repeat("\x01", 100000)
	expect(t, f.save(t, v.SessionID, "escaped", escaped, 3), 200)
	w := f.call("alice", "GET", "/api/v1/lab-sessions/"+v.SessionID, "", nil)
	expect(t, w, 200)
	current := read[Session](t, w)
	if current.Content != escaped || current.ContentHash != bytesHash([]byte(escaped)) {
		t.Fatal("escaped100KB source not preserved exactly")
	}
	expect(t, f.save(t, v.SessionID, "nul", "a\x00b", 4), 422)
}
func TestFileAndSessionCommandBodyBounds(t *testing.T) {
	f := setup(t)
	v := f.start(t, "alice", "sql-customer-revenue", "start")
	route := "/api/v1/lab-sessions/" + v.SessionID + "/file"
	for _, body := range []map[string]any{{"content": nil, "expected_revision": 1}, {"content": "x", "expected_revision": 0}, {"content": "x", "expected_revision": 1, "filename": "../../etc/passwd"}, {"content": "x", "expected_revision": 1, "user_id": "bob"}} {
		status := 422
		if len(body) == 3 {
			status = 400
		}
		expect(t, f.call("alice", "PUT", route, "invalid", body), status)
	}
	expect(t, f.call("alice", "POST", "/api/v1/labs/sql-customer-revenue/start", "null", nil), 400)
	expect(t, f.call("alice", "POST", "/api/v1/labs/learner-executable/start", "invalid", map[string]any{}), 404)
	expect(t, f.call("alice", "PUT", route, "", map[string]any{"content": "x", "expected_revision": 1}), 422)
	r := httptest.NewRequest("PUT", "http://test"+route, strings.NewReader(`{"content":"x","expected_revision":1} {}`))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", "http://test")
	r.Header.Set("X-CSRF-Token", "csrf")
	r.AddCookie(&http.Cookie{Name: identity.CookieName, Value: "alicetoken"})
	w := httptest.NewRecorder()
	f.mux.ServeHTTP(w, r)
	expect(t, w, 400)
}
func TestUnavailableSubmitCreatesNoFakeJobOrSubmission(t *testing.T) {
	f := setup(t)
	v := f.start(t, "alice", "python-log-analysis", "start")
	route := "/api/v1/lab-sessions/" + v.SessionID + "/submit"
	expect(t, f.call("alice", "POST", route, "submit", map[string]any{"expected_revision": 1}), 503)
	expect(t, f.call("alice", "POST", route, "kind", map[string]any{"expected_revision": 1, "validate_in_kind": true}), 422)
	expect(t, f.call("alice", "POST", route, "stale", map[string]any{"expected_revision": 2}), 409)
	k := f.start(t, "alice", "k8s-resilient-service", "k8s")
	expect(t, f.call("alice", "POST", "/api/v1/lab-sessions/"+k.SessionID+"/submit", "kind", map[string]any{"expected_revision": 1, "validate_in_kind": true}), 503)
	for _, table := range []string{"jobs", "lab_submissions", "lab_grades"} {
		var count int
		if e := f.s.Pool.QueryRow(context.Background(), "SELECT count(*) FROM "+table).Scan(&count); e != nil || count != 0 {
			t.Fatal("unavailable executor invented durable execution", table, count, e)
		}
	}
}

type receiptOnlyQueue struct{}

func (receiptOnlyQueue) Enqueue(_ context.Context, _ pgx.Tx, p identity.Principal, _ string, _ Submission) (jobs.Job, error) {
	return jobs.Job{ID: "invented_job", UserID: p.UserID, Kind: "lab", State: "queued"}, nil
}

type fixtureVerifier struct{}

func (fixtureVerifier) Verify(context.Context, pgx.Tx, jobs.Job, Submission, ExecutionResult) error {
	return nil
}
func TestQueueReceiptWithoutRealOwnedDurableJobIsRejected(t *testing.T) {
	f := setup(t)
	v := f.start(t, "alice", "sql-customer-revenue", "start")
	f.s.ExecutorAvailable = true
	f.s.Queue = receiptOnlyQueue{}
	f.s.Verifier = fixtureVerifier{}
	expect(t, f.call("alice", "POST", "/api/v1/lab-sessions/"+v.SessionID+"/submit", "submit", map[string]any{"expected_revision": 1}), 422)
	var count int
	if e := f.s.Pool.QueryRow(context.Background(), `SELECT count(*) FROM lab_submissions`).Scan(&count); e != nil || count != 0 {
		t.Fatal("invented receipt left orphaned submission", count, e)
	}
}
func TestOwnedHistoricalSubmissionSnapshotsAndFeedbackSurviveEdits(t *testing.T) {
	f := setup(t)
	v := f.start(t, "alice", "sql-customer-revenue", "start")
	f.seedSubmittedSnapshot(t, v, "historic", true)
	w := f.call("alice", "GET", "/api/v1/lab-sessions/"+v.SessionID, "", nil)
	expect(t, w, 200)
	prior := read[Session](t, w)
	if prior.Status != "passed" || prior.Result == nil || !prior.Result.Passed {
		t.Fatal("retained historical feedback unavailable")
	}
	expect(t, f.save(t, v.SessionID, "edit", "New private input", 1), 200)
	w = f.call("alice", "GET", "/api/v1/lab-sessions/"+v.SessionID, "", nil)
	expect(t, w, 200)
	current := read[Session](t, w)
	if current.Result != nil || current.Status != "started" || current.Revision != 2 {
		t.Fatal("old grade applied to new source")
	}
	w = f.call("alice", "GET", "/api/v1/lab-submissions/historic", "", nil)
	expect(t, w, 200)
	old := read[Submission](t, w)
	if old.ContentHash != v.ContentHash || old.Revision != 1 || old.Result == nil || !old.Result.Passed {
		t.Fatal("old input/feedback changed")
	}
	if strings.Contains(w.Body.String(), "legacy-fixture") || strings.Contains(w.Body.String(), "owner_id") {
		t.Fatal("private provenance leaked")
	}
	for _, user := range []string{"bob", "admin"} {
		expect(t, f.call(user, "GET", "/api/v1/lab-submissions/historic", "", nil), 404)
	}
	if _, e := f.s.Pool.Exec(context.Background(), `UPDATE lab_revisions SET content='changed'`); e == nil {
		t.Fatal("source snapshot was editable")
	}
	if _, e := f.s.Pool.Exec(context.Background(), `UPDATE lab_grades SET passed=false`); e == nil {
		t.Fatal("grade snapshot was editable")
	}
}
func TestPrivateSessionAndSubmissionPagination(t *testing.T) {
	f := setup(t)
	first := f.start(t, "alice", "sql-customer-revenue", "first")
	f.start(t, "alice", "backend-request-handler", "second")
	f.start(t, "bob", "python-log-analysis", "foreign")
	w := f.call("alice", "GET", "/api/v1/lab-sessions?limit=1", "", nil)
	expect(t, w, 200)
	result := read[struct {
		Sessions []map[string]any `json:"sessions"`
		Cursor   string           `json:"next_cursor"`
	}](t, w)
	if len(result.Sessions) != 1 || result.Cursor == "" {
		t.Fatal("session page unbounded")
	}
	w = f.call("alice", "GET", "/api/v1/lab-sessions?limit=1&cursor="+result.Cursor, "", nil)
	expect(t, w, 200)
	next := read[struct {
		Sessions []map[string]any `json:"sessions"`
	}](t, w)
	if len(next.Sessions) != 1 || next.Sessions[0]["session_id"] == result.Sessions[0]["session_id"] {
		t.Fatal("cursor repeated session")
	}
	f.seedSubmittedSnapshot(t, first, "one", true)
	f.seedSubmittedSnapshot(t, first, "two", false)
	w = f.call("alice", "GET", "/api/v1/lab-sessions/"+first.SessionID+"/submissions?limit=1", "", nil)
	expect(t, w, 200)
	page := read[struct {
		Items  []Submission `json:"submissions"`
		Cursor string       `json:"next_cursor"`
	}](t, w)
	if len(page.Items) != 1 || page.Cursor == "" {
		t.Fatal("submission page missing cursor")
	}
	w = f.call("alice", "GET", "/api/v1/lab-sessions/"+first.SessionID+"/submissions?limit=1&cursor="+page.Cursor, "", nil)
	expect(t, w, 200)
	page2 := read[struct {
		Items []Submission `json:"submissions"`
	}](t, w)
	if len(page2.Items) != 1 || page2.Items[0].ID == page.Items[0].ID {
		t.Fatal("submission page repeated row")
	}
	for _, route := range []string{"/api/v1/lab-sessions?limit=101", "/api/v1/lab-sessions?cursor=bad", "/api/v1/lab-sessions/" + first.SessionID + "/submissions?limit=0"} {
		expect(t, f.call("alice", "GET", route, "", nil), 422)
	}
}
func TestSuspensionRevocationAndAccountDeletion(t *testing.T) {
	f := setup(t)
	v := f.start(t, "alice", "sql-customer-revenue", "start")
	f.seedSubmittedSnapshot(t, v, "historic", true)
	if _, e := f.s.Pool.Exec(context.Background(), `UPDATE users SET suspended=true WHERE id='alice'`); e != nil {
		t.Fatal(e)
	}
	expect(t, f.call("alice", "GET", "/api/v1/lab-sessions/"+v.SessionID, "", nil), 401)
	if _, e := f.s.Pool.Exec(context.Background(), `UPDATE users SET suspended=false WHERE id='alice';UPDATE auth_sessions SET revoked_at=now() WHERE id='aliceauth'`); e != nil {
		t.Fatal(e)
	}
	expect(t, f.call("alice", "POST", "/api/v1/labs/sql-customer-revenue/start", "start", map[string]any{}), 401)
	if _, e := f.s.Pool.Exec(context.Background(), `DELETE FROM users WHERE id='alice'`); e != nil {
		t.Fatal(e)
	}
	var count int
	if e := f.s.Pool.QueryRow(context.Background(), `SELECT count(*) FROM lab_sessions`).Scan(&count); e != nil || count != 0 {
		t.Fatal("account deletion retained workspace", count, e)
	}
	if e := f.s.Pool.QueryRow(context.Background(), `SELECT count(*) FROM lab_grades`).Scan(&count); e != nil || count != 0 {
		t.Fatal("account deletion retained grade", count, e)
	}
}
func TestNoVerifierOrCurrentFenceMeansNoTrustedGrade(t *testing.T) {
	f := setup(t)
	tx, e := f.s.Pool.Begin(context.Background())
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback(context.Background())
	if e = f.s.PublishResult(context.Background(), tx, jobs.Job{ID: "missing", Kind: "lab"}, json.RawMessage(`{"passed":true}`)); !errors.Is(e, ErrUnavailable) {
		t.Fatal("unconfigured executor accepted a grade", e)
	}
	f.s.ExecutorAvailable = true
	f.s.Verifier = fixtureVerifier{}
	if e = f.s.PublishResult(context.Background(), tx, jobs.Job{ID: "missing", Kind: "lab"}, json.RawMessage(`{"version":1,"product":"curated_lab","runner_receipt_id":"invented","checks":[{"name":"check","passed":true}]}`)); !errors.Is(e, jobs.ErrDenied) {
		t.Fatal("unleased invented result accepted", e)
	}
}
func TestPublicJobProjectionAndStrictCheckBoolean(t *testing.T) {
	job := jobs.Job{ID: "fixture_job", Kind: "lab", Payload: json.RawMessage(`{"version":1,"product":"curated_lab","submission_id":"owned_submission"}`), Result: json.RawMessage(`{"checks":[{"name":"Private check","passed":true,"details":"Private execution output"}]}`)}
	raw, handled := ProjectResult(job)
	if !handled || !strings.Contains(string(raw), "owned_submission") || strings.Contains(string(raw), "Private") || strings.Contains(string(raw), "checks") {
		t.Fatal("generic job leaked grader output")
	}
	job.Kind = "tutor"
	if raw, handled := ProjectResult(job); !handled || raw != nil {
		t.Fatal("wrong job kind acquired a lab result")
	}
	for _, raw := range []string{`{"name":"check"}`, `{"name":"check","passed":null}`, `{"name":"check","passed":true,"unexpected":1}`} {
		var check Check
		if json.Unmarshal([]byte(raw), &check) == nil {
			t.Fatal("malformed check boolean accepted")
		}
	}
}
func TestPracticeReadsExactOwnedHistoricalGradeEvidence(t *testing.T) {
	f := setup(t)
	v := f.start(t, "alice", "sql-customer-revenue", "start")
	f.seedSubmittedSnapshot(t, v, "historic", true)
	tx, e := f.s.Pool.Begin(context.Background())
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback(context.Background())
	grade, submission, e := f.s.ReadGrade(context.Background(), tx, identity.Principal{UserID: "alice"}, v.SessionID, "grade_historic")
	if e != nil || grade.ID != "grade_historic" || submission.ContentHash != v.ContentHash || submission.GraderVersion != "legacy-fixture-version" || !grade.Passed {
		t.Fatal("accepted grade evidence binding changed", e)
	}
	if _, _, e = f.s.ReadGrade(context.Background(), tx, identity.Principal{UserID: "bob"}, v.SessionID, "grade_historic"); !errors.Is(e, pgx.ErrNoRows) {
		t.Fatal("another learner acquired grade evidence", e)
	}
	var revisions int
	if e = tx.QueryRow(context.Background(), `SELECT count(*) FROM lab_revisions`).Scan(&revisions); e != nil || revisions != 1 {
		t.Fatal("read duplicated source snapshot", revisions, e)
	}
}

var _ = time.Second
