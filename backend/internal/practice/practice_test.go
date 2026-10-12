package practice

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"courseforge/backend/internal/identity"
	"courseforge/backend/internal/paths"
	"courseforge/backend/internal/testutil"
	"github.com/jackc/pgx/v5"
)

type fixture struct {
	s   *Service
	p   *paths.Service
	mux *http.ServeMux
}

// This SQL-only synthetic adapter proves the evidence boundary. It does not run
// a lab and cannot establish restricted runner/workspace correctness.
type storedLabs struct{}

func (storedLabs) Start(ctx context.Context, tx pgx.Tx, p identity.Principal, slug, key string) (LabSession, error) {
	id := p.UserID + "_" + hash(key)[:12]
	_, e := tx.Exec(ctx, `INSERT INTO fixture_lab_sessions(id,user_id,slug)VALUES($1,$2,$3)`, id, p.UserID, slug)
	return LabSession{SessionID: id, OwnerID: p.UserID, Slug: slug, Status: "started", Title: curated[slug].Title, Type: curated[slug].Type}, e
}
func (storedLabs) Grade(ctx context.Context, tx pgx.Tx, p identity.Principal, session, id string) (GradeEvidence, error) {
	var raw []byte
	var value GradeEvidence
	e := tx.QueryRow(ctx, `SELECT evidence FROM fixture_grades WHERE id=$1 AND user_id=$2 AND session_id=$3`, id, p.UserID, session).Scan(&raw)
	if e == nil {
		e = json.Unmarshal(raw, &value)
	}
	return value, e
}
func setup(t *testing.T) fixture {
	t.Helper()
	pool := testutil.Postgres(t)
	ctx := context.Background()
	for _, user := range []string{"alice", "bob", "admin", "outsider", "unverified"} {
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
	if _, e := pool.Exec(ctx, `INSERT INTO courses(id,title,published)VALUES('course','Synthetic SQL',true),('other','Other course',true);INSERT INTO lessons(id,course_id,title,duration_seconds)VALUES('lesson','course','SQL source',600),('otherlesson','other','Other source',600);INSERT INTO enrollments(user_id,course_id)VALUES('alice','course'),('bob','course'),('alice','other');INSERT INTO transcript_chunks(id,lesson_id,start_seconds,end_seconds,text)VALUES('chunk','lesson',10,50,'Synthetic SQL database join transactions source.'),('otherchunk','otherlesson',10,50,'Other private source content.');CREATE TABLE fixture_lab_sessions(id text PRIMARY KEY,user_id text NOT NULL,slug text NOT NULL);CREATE TABLE fixture_grades(id text PRIMARY KEY,user_id text NOT NULL,session_id text NOT NULL,evidence jsonb NOT NULL);`); e != nil {
		t.Fatal(e)
	}
	auth, e := identity.New(pool, identity.Config{PublicOrigin: "http://test", PasswordConcurrency: 1})
	if e != nil {
		t.Fatal(e)
	}
	pathService := paths.New(pool, nil)
	service := New(pool, pathService)
	mux := http.NewServeMux()
	pathService.Register(mux, auth)
	service.Register(mux, auth)
	return fixture{service, pathService, mux}
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
		t.Fatalf("status=%d expected=%d body=%s", w.Code, status, w.Body.String())
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
func definition(id string) paths.Definition {
	return paths.Definition{ID: id, Goal: "Learn database transactions", CourseIDs: []string{"course"}, Steps: []paths.Step{{ID: "sql", Title: "SQL database join", Objectives: []string{"Understand relational query aggregation"}, Sources: []paths.Source{{LessonID: "lesson", CourseID: "course", ChunkID: "chunk", Start: 10}}}, {ID: "unknown", Title: "Geometry shapes", Sources: []paths.Source{{LessonID: "lesson", CourseID: "course", ChunkID: "chunk", Start: 10}}}}}
}
func (f fixture) create(t *testing.T, id string) paths.Path {
	t.Helper()
	w := f.call("alice", "POST", "/api/v1/learning-paths/manual", "create_"+id, definition(id))
	expect(t, w, 201)
	return read[paths.Path](t, w)
}
func (f fixture) start(t *testing.T, path, key string) LabSession {
	t.Helper()
	f.s.Labs = storedLabs{}
	w := f.call("alice", "POST", "/api/v1/learning-paths/"+path+"/steps/sql/practice/sql-customer-revenue/start", key, map[string]any{})
	expect(t, w, 201)
	return read[LabSession](t, w)
}
func (f fixture) evidence(t *testing.T, id, session string, pass bool, checks ...bool) GradeEvidence {
	t.Helper()
	g := GradeEvidence{ID: id, OwnerID: "alice", SessionID: session, Slug: "sql-customer-revenue", Accepted: true, Passed: pass, GraderVersion: "fixture-grader-v1", SubmissionHash: hash("fixture-submission"), CompletedAt: time.Now().UTC()}
	for i, ok := range checks {
		g.Checks = append(g.Checks, Check{ID: fmt.Sprintf("check_%d", i), Passed: ok})
	}
	raw, _ := json.Marshal(g)
	if _, e := f.s.Pool.Exec(context.Background(), `INSERT INTO fixture_grades(id,user_id,session_id,evidence)VALUES($1,'alice',$2,$3)`, id, session, raw); e != nil {
		t.Fatal(e)
	}
	return g
}
func (f fixture) accept(t *testing.T, session, evidence, key string) Attempt {
	t.Helper()
	w := f.call("alice", "POST", "/api/v1/practice/sessions/"+session+"/verified-attempts", key, map[string]any{"evidence_id": evidence})
	expect(t, w, 201)
	return read[Attempt](t, w)
}
func (f fixture) assessment(t *testing.T, path string, answer int) {
	t.Helper()
	qs := []paths.Question{}
	for i := 0; i < 3; i++ {
		qs = append(qs, paths.Question{ID: fmt.Sprintf("q%d", i), Question: fmt.Sprintf("Which SQL database concept is supported by source %d?", i), Options: []string{"Database join", "No ownership", "Random URL", "Unbounded code"}, CorrectIndex: 0, Explanation: "The synthetic source discusses SQL database join transactions.", Source: paths.Source{LessonID: "lesson", CourseID: "course", ChunkID: "chunk", Start: 10}, Excerpt: "SQL database"})
	}
	w := f.call("alice", "POST", "/api/v1/learning-paths/"+path+"/steps/sql/assessments/manual", fmt.Sprintf("assessment_%d", answer), map[string]any{"expected_revision": 1, "questions": qs})
	expect(t, w, 201)
	a := read[map[string]any](t, w)
	w = f.call("alice", "POST", "/api/v1/assessments/"+a["id"].(string)+"/attempts", fmt.Sprintf("attempt_%d", answer), map[string]any{"answers": map[string]int{"q0": answer, "q1": answer, "q2": answer}})
	expect(t, w, 201)
}

func TestPracticePrivateHTTPAndCSRFGuards(t *testing.T) {
	f := setup(t)
	f.create(t, "path")
	for _, route := range []string{"practice-recommendations", "practice-history", "practice-status"} {
		expect(t, f.call("", "GET", "/api/v1/learning-paths/path/"+route, "", nil), 401)
		for _, user := range []string{"bob", "admin", "outsider"} {
			expect(t, f.call(user, "GET", "/api/v1/learning-paths/path/"+route, "", nil), 404)
		}
		expect(t, f.call("unverified", "GET", "/api/v1/learning-paths/path/"+route, "", nil), 403)
	}
	for _, entry := range []struct{ origin, csrf string }{{"http://hostile", "csrf"}, {"http://test", ""}, {"http://test", "bad"}} {
		r := httptest.NewRequest("POST", "http://test/api/v1/learning-paths/path/steps/sql/practice/sql-customer-revenue/start", strings.NewReader(`{}`))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", entry.origin)
		r.Header.Set("X-CSRF-Token", entry.csrf)
		r.AddCookie(&http.Cookie{Name: identity.CookieName, Value: "alicetoken"})
		w := httptest.NewRecorder()
		f.mux.ServeHTTP(w, r)
		expect(t, w, 403)
	}
}
func TestCuratedUnicodeWordBoundaries(t *testing.T) {
	for _, tc := range []struct {
		text  string
		score int
	}{{"SQL", 2}, {"NoSQL", 0}, {"nosql query", 2}, {"éSQL", 0}, {"SQLé", 0}, {"SQL_", 0}, {"(sql)", 2}, {"SQL SQL", 2}, {"database join", 4}} {
		if got := topicScore(paths.Step{Title: tc.text}, curated["sql-customer-revenue"].Terms); got != tc.score {
			t.Fatalf("%q score=%d expected=%d", tc.text, got, tc.score)
		}
	}
}
func TestNilAdapterHasTruthfulRecommendationsAndNoFakeSession(t *testing.T) {
	f := setup(t)
	f.create(t, "path")
	w := f.call("alice", "GET", "/api/v1/learning-paths/path/practice-recommendations", "", nil)
	expect(t, w, 200)
	var value struct {
		Recommendations []Recommendation   `json:"recommendations"`
		Lessons         []LessonSuggestion `json:"source_suggestions"`
		Without         []string           `json:"topics_without_recommendations"`
	}
	value = read[struct {
		Recommendations []Recommendation   `json:"recommendations"`
		Lessons         []LessonSuggestion `json:"source_suggestions"`
		Without         []string           `json:"topics_without_recommendations"`
	}](t, w)
	if len(value.Recommendations) != 1 || value.Recommendations[0].Available || value.Recommendations[0].UnavailableReason == "" || value.Recommendations[0].Priority != 20 || value.Recommendations[0].AssessmentScore != nil {
		t.Fatal("unavailable recommendation incorrectly claimed execution or signal")
	}
	if len(value.Lessons) != 2 || value.Lessons[0].GrantsMastery || len(value.Without) != 1 || value.Without[0] != "unknown" {
		t.Fatal("source fallback or missing-topic explanation wrong")
	}
	expect(t, f.call("alice", "POST", "/api/v1/learning-paths/path/steps/sql/practice/sql-customer-revenue/start", "start", map[string]any{}), 503)
	var count int
	if e := f.s.Pool.QueryRow(context.Background(), `SELECT count(*) FROM practice_sessions`).Scan(&count); e != nil || count != 0 {
		t.Fatal("nil adapter created a session", count, e)
	}
}
func TestActualAssessmentReviewAndWatchSignalsRemainSeparate(t *testing.T) {
	f := setup(t)
	f.create(t, "path")
	f.assessment(t, "path", 1)
	if _, e := f.s.Pool.Exec(context.Background(), `INSERT INTO review_cards(id,user_id,course_id,lesson_id,question,answer,due_at)VALUES('alice_due','alice','course','lesson','Synthetic due question?','Private answer',now()-interval '1 day'),('bob_due','bob','course','lesson','Another due question?','Other private answer',now()-interval '1 day'),('alice_future','alice','course','lesson','Future question?','Not due',now()+interval '1 day');INSERT INTO progress(user_id,lesson_id,percent,completed)VALUES('alice','lesson',100,true);`); e != nil {
		t.Fatal(e)
	}
	w := f.call("alice", "GET", "/api/v1/learning-paths/path/practice-recommendations", "", nil)
	expect(t, w, 200)
	var value struct {
		Recommendations []Recommendation   `json:"recommendations"`
		Lessons         []LessonSuggestion `json:"source_suggestions"`
	}
	value = read[struct {
		Recommendations []Recommendation   `json:"recommendations"`
		Lessons         []LessonSuggestion `json:"source_suggestions"`
	}](t, w)
	if len(value.Recommendations) != 1 || *value.Recommendations[0].AssessmentScore != 0 || value.Recommendations[0].Priority != 108 || value.Recommendations[0].Action != "Practice weak concept" {
		t.Fatal("real weak assessment not used")
	}
	if value.Lessons[0].DueReviews != 1 || value.Lessons[0].WatchedSources != 1 || value.Lessons[0].GrantsMastery {
		t.Fatal("private review/watch signals mixed")
	}
	if strings.Contains(w.Body.String(), "Private answer") || strings.Contains(w.Body.String(), "correct_index") {
		t.Fatal("private answers leaked")
	}
}
func TestStartIsCuratedOwnedAndDurableAfterPathRefresh(t *testing.T) {
	f := setup(t)
	f.create(t, "path")
	session := f.start(t, "path", "start")
	if session.PracticeContext.PathID != "path" || session.PracticeContext.StepID != "sql" {
		t.Fatal("practice link absent")
	}
	route := "/api/v1/learning-paths/path/steps/sql/practice/sql-customer-revenue/start"
	w := f.call("alice", "POST", route, "start", map[string]any{})
	expect(t, w, 201)
	if read[LabSession](t, w).SessionID != session.SessionID {
		t.Fatal("retry duplicated session")
	}
	d := definition("path")
	d.ExpectedRevision = 1
	d.Goal = "Changed private goal"
	expect(t, f.call("alice", "PUT", "/api/v1/learning-paths/path", "refresh", d), 200)
	f.s.Labs = nil
	w = f.call("alice", "POST", route, "start", map[string]any{})
	expect(t, w, 201)
	if read[LabSession](t, w).SessionID != session.SessionID {
		t.Fatal("refresh changed durable start ack")
	}
	expect(t, f.call("alice", "POST", "/api/v1/learning-paths/path/steps/unknown/practice/sql-customer-revenue/start", "start", map[string]any{}), 409)
	expect(t, f.call("alice", "POST", route, "other", map[string]any{"passed": true}), 400)
}
func TestUnmatchedUnknownAndOutdatedStartDenied(t *testing.T) {
	f := setup(t)
	f.create(t, "path")
	f.s.Labs = storedLabs{}
	for _, tc := range []struct {
		step, slug string
		status     int
	}{{"sql", "unreviewed-code", 404}, {"missing", "sql-customer-revenue", 404}, {"unknown", "sql-customer-revenue", 409}} {
		expect(t, f.call("alice", "POST", "/api/v1/learning-paths/path/steps/"+tc.step+"/practice/"+tc.slug+"/start", "bad", map[string]any{}), tc.status)
	}
	if _, e := f.s.Pool.Exec(context.Background(), `UPDATE transcript_chunks SET text='Changed source' WHERE id='chunk'`); e != nil {
		t.Fatal(e)
	}
	expect(t, f.call("alice", "POST", "/api/v1/learning-paths/path/steps/sql/practice/sql-customer-revenue/start", "outdated", map[string]any{}), 409)
}
func TestVerifiedEvidenceOnlyAndAllChecksRequired(t *testing.T) {
	f := setup(t)
	f.create(t, "path")
	session := f.start(t, "path", "start")
	f.evidence(t, "grade", session.SessionID, true, true, false)
	a := f.accept(t, session.SessionID, "grade", "accept")
	if a.Passed || a.ChecksPassed != 1 || a.ChecksTotal != 2 {
		t.Fatal("top-level pass overrode failing check")
	}
	expect(t, f.call("alice", "POST", "/api/v1/practice/sessions/"+session.SessionID+"/verified-attempts", "forged", map[string]any{"evidence_id": "grade", "passed": true, "checks": []any{}}), 400)
	expect(t, f.call("bob", "POST", "/api/v1/practice/sessions/"+session.SessionID+"/verified-attempts", "foreign", map[string]any{"evidence_id": "grade"}), 404)
	expect(t, f.call("alice", "POST", "/api/v1/practice/sessions/"+session.SessionID+"/verified-attempts", "missing", map[string]any{"evidence_id": "unknown"}), 404)
	var credits int
	if e := f.s.Pool.QueryRow(context.Background(), `SELECT count(*) FROM learning_credits`).Scan(&credits); e != nil || credits != 0 {
		t.Fatal("practice issued unrelated learning credit", credits, e)
	}
}
func TestInvalidAcceptedGradeProvenanceRejected(t *testing.T) {
	for _, reason := range []string{"owner", "session", "slug", "unaccepted", "empty", "duplicate", "future", "provenance"} {
		t.Run(reason, func(t *testing.T) {
			f := setup(t)
			f.create(t, "path")
			session := f.start(t, "path", "start")
			g := f.evidence(t, "grade", session.SessionID, true, true)
			switch reason {
			case "owner":
				g.OwnerID = "bob"
			case "session":
				g.SessionID = "other_session"
			case "slug":
				g.Slug = "python-log-analysis"
			case "unaccepted":
				g.Accepted = false
			case "empty":
				g.Checks = nil
			case "duplicate":
				g.Checks = append(g.Checks, g.Checks[0])
			case "future":
				g.CompletedAt = time.Now().Add(time.Hour)
			case "provenance":
				g.GraderVersion = ""
			}
			raw, _ := json.Marshal(g)
			if _, e := f.s.Pool.Exec(context.Background(), `UPDATE fixture_grades SET evidence=$1 WHERE id='grade'`, raw); e != nil {
				t.Fatal(e)
			}
			expect(t, f.call("alice", "POST", "/api/v1/practice/sessions/"+session.SessionID+"/verified-attempts", "accept", map[string]any{"evidence_id": "grade"}), 422)
		})
	}
}
func TestConcurrentDuplicateEvidenceHasOneImmutableAttempt(t *testing.T) {
	f := setup(t)
	f.create(t, "path")
	session := f.start(t, "path", "start")
	f.evidence(t, "grade", session.SessionID, true, true, true)
	const count = 8
	var wg sync.WaitGroup
	responses := make(chan *httptest.ResponseRecorder, count)
	for i := 0; i < count; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			responses <- f.call("alice", "POST", "/api/v1/practice/sessions/"+session.SessionID+"/verified-attempts", fmt.Sprintf("accept_%d", i), map[string]any{"evidence_id": "grade"})
		}(i)
	}
	wg.Wait()
	close(responses)
	id := ""
	for w := range responses {
		expect(t, w, 201)
		a := read[Attempt](t, w)
		if !a.Passed {
			t.Fatal("valid checks did not pass")
		}
		if id != "" && id != a.ID {
			t.Fatal("evidence credited multiple attempts")
		}
		id = a.ID
	}
	var total int
	if e := f.s.Pool.QueryRow(context.Background(), `SELECT count(*) FROM practice_attempts`).Scan(&total); e != nil || total != 1 {
		t.Fatal("duplicate evidence rows", total, e)
	}
	if _, e := f.s.Pool.Exec(context.Background(), `UPDATE practice_attempts SET passed=false`); e == nil {
		t.Fatal("immutable attempt updated")
	}
}
func TestLatestAcceptedFailureReopensStrongAssessmentGap(t *testing.T) {
	f := setup(t)
	f.create(t, "path")
	f.assessment(t, "path", 0)
	w := f.call("alice", "GET", "/api/v1/learning-paths/path/practice-recommendations", "", nil)
	expect(t, w, 200)
	if strings.Contains(w.Body.String(), `"lab_slug"`) {
		t.Fatal("strong untested topic became a false current gap")
	}
	session := f.start(t, "path", "start")
	passedGrade := f.evidence(t, "pass", session.SessionID, true, true)
	f.accept(t, session.SessionID, "pass", "accept_pass")
	w = f.call("alice", "GET", "/api/v1/learning-paths/path/practice-recommendations", "", nil)
	expect(t, w, 200)
	if strings.Contains(w.Body.String(), `"lab_slug"`) {
		t.Fatal("passed lab + strong assessment did not close gap")
	}
	g := f.evidence(t, "fail", session.SessionID, false, false)
	g.CompletedAt = passedGrade.CompletedAt.Add(-time.Microsecond)
	raw, _ := json.Marshal(g)
	if _, e := f.s.Pool.Exec(context.Background(), `UPDATE fixture_grades SET evidence=$1 WHERE id='fail'`, raw); e != nil {
		t.Fatal(e)
	}
	f.accept(t, session.SessionID, "fail", "accept_fail")
	w = f.call("alice", "GET", "/api/v1/learning-paths/path/practice-recommendations", "", nil)
	expect(t, w, 200)
	var value struct {
		Items []Recommendation `json:"recommendations"`
	}
	value = read[struct {
		Items []Recommendation `json:"recommendations"`
	}](t, w)
	if len(value.Items) != 1 || value.Items[0].Action != "Retry graded lab" || value.Items[0].LastPassed || value.Items[0].Attempts != 2 || value.Items[0].Priority != 61 {
		t.Fatal("latest accepted failure not preserved", w.Body.String())
	}
	w = f.call("alice", "GET", "/api/v1/learning-paths/path/practice-status", "", nil)
	expect(t, w, 200)
	if strings.Contains(w.Body.String(), `"passed_labs":["sql-customer-revenue"]`) {
		t.Fatal("older pass overrode latest failure")
	}
}
func TestHistoryPagingAndDurableAckAfterLaterGrades(t *testing.T) {
	f := setup(t)
	f.create(t, "path")
	session := f.start(t, "path", "start")
	f.evidence(t, "pass", session.SessionID, true, true)
	original := f.accept(t, session.SessionID, "pass", "accept")
	f.evidence(t, "fail", session.SessionID, false, false)
	f.accept(t, session.SessionID, "fail", "later")
	same := f.accept(t, session.SessionID, "pass", "accept")
	if same.ID != original.ID || !same.Passed {
		t.Fatal("later state changed exact ack")
	}
	w := f.call("alice", "GET", "/api/v1/learning-paths/path/practice-history?limit=1", "", nil)
	expect(t, w, 200)
	var page struct {
		Items  []Attempt `json:"attempts"`
		Cursor string    `json:"next_cursor"`
	}
	page = read[struct {
		Items  []Attempt `json:"attempts"`
		Cursor string    `json:"next_cursor"`
	}](t, w)
	if len(page.Items) != 1 || page.Cursor == "" {
		t.Fatal("history not paginated")
	}
	w = f.call("alice", "GET", "/api/v1/learning-paths/path/practice-history?limit=1&cursor="+page.Cursor, "", nil)
	expect(t, w, 200)
	next := read[struct {
		Items []Attempt `json:"attempts"`
	}](t, w)
	if len(next.Items) != 1 || next.Items[0].ID == page.Items[0].ID {
		t.Fatal("cursor duplicated attempt")
	}
	for _, route := range []string{"practice-history?limit=101", "practice-history?cursor=bad", "practice-history?step_id=missing", "practice-recommendations?limit=0"} {
		status := 422
		if strings.Contains(route, "step_id") {
			status = 404
		}
		expect(t, f.call("alice", "GET", "/api/v1/learning-paths/path/"+route, "", nil), status)
	}
	if strings.Contains(w.Body.String(), "grader_version") || strings.Contains(w.Body.String(), "submission_hash") {
		t.Fatal("raw grader provenance exposed")
	}
}
func TestHistoricalScopeAndRefreshDoNotRelabelPractice(t *testing.T) {
	f := setup(t)
	f.create(t, "path")
	session := f.start(t, "path", "start")
	f.evidence(t, "pass", session.SessionID, true, true)
	f.accept(t, session.SessionID, "pass", "accept")
	d := definition("path")
	d.ExpectedRevision = 1
	d.CourseIDs = []string{"other"}
	for i := range d.Steps {
		d.Steps[i].Sources = []paths.Source{{LessonID: "otherlesson", CourseID: "other", ChunkID: "otherchunk", Start: 10}}
	}
	expect(t, f.call("alice", "PUT", "/api/v1/learning-paths/path", "refresh", d), 200)
	w := f.call("alice", "GET", "/api/v1/learning-paths/path/practice-status", "", nil)
	expect(t, w, 200)
	if !strings.Contains(w.Body.String(), `"outdated":true`) {
		t.Fatal("old practice relabeled as refreshed source")
	}
	if _, e := f.s.Pool.Exec(context.Background(), `UPDATE transcript_chunks SET text='Changed original source' WHERE id='chunk'`); e != nil {
		t.Fatal(e)
	}
	expect(t, f.call("alice", "GET", "/api/v1/learning-paths/path/practice-history", "", nil), 200)
	if _, e := f.s.Pool.Exec(context.Background(), `DELETE FROM enrollments WHERE user_id='alice' AND course_id='course'`); e != nil {
		t.Fatal(e)
	}
	w = f.call("alice", "GET", "/api/v1/learning-paths/path/practice-history", "", nil)
	expect(t, w, 200)
	if strings.Contains(w.Body.String(), originalMarker(session.SessionID)) {
		t.Fatal("archived revoked session leaked")
	}
	expect(t, f.call("alice", "POST", "/api/v1/practice/sessions/"+session.SessionID+"/verified-attempts", "accept", map[string]any{"evidence_id": "pass"}), 404)
}
func originalMarker(id string) string { return `"session_id":"` + id + `"` }

func TestNilAdapterReconciliationAndSessionRevocation(t *testing.T) {
	f := setup(t)
	f.create(t, "path")
	session := f.start(t, "path", "start")
	f.evidence(t, "grade", session.SessionID, true, true)
	f.s.Labs = nil
	expect(t, f.call("alice", "POST", "/api/v1/practice/sessions/"+session.SessionID+"/verified-attempts", "accept", map[string]any{"evidence_id": "grade"}), 503)
	if _, e := f.s.Pool.Exec(context.Background(), `UPDATE auth_sessions SET revoked_at=now() WHERE id='aliceauth'`); e != nil {
		t.Fatal(e)
	}
	expect(t, f.call("alice", "GET", "/api/v1/learning-paths/path/practice-history", "", nil), 401)
}

func TestCommandBoundsAndNoNewEvidenceUnderRevokedCurrentPath(t *testing.T) {
	f := setup(t)
	f.create(t, "path")
	route := "/api/v1/learning-paths/path/steps/sql/practice/sql-customer-revenue/start"
	expect(t, f.call("alice", "POST", route, "", map[string]any{}), 422)
	expect(t, f.call("alice", "POST", route, "null", nil), 400)
	session := f.start(t, "path", "start")
	f.evidence(t, "grade", session.SessionID, true, true)
	d := definition("path")
	d.ExpectedRevision = 1
	d.CourseIDs = []string{"other"}
	for i := range d.Steps {
		d.Steps[i].Sources = []paths.Source{{LessonID: "otherlesson", CourseID: "other", ChunkID: "otherchunk", Start: 10}}
	}
	expect(t, f.call("alice", "PUT", "/api/v1/learning-paths/path", "refresh", d), 200)
	if _, e := f.s.Pool.Exec(context.Background(), `UPDATE courses SET published=false WHERE id='other'`); e != nil {
		t.Fatal(e)
	}
	expect(t, f.call("alice", "POST", "/api/v1/practice/sessions/"+session.SessionID+"/verified-attempts", "accept", map[string]any{"evidence_id": "grade"}), 404)
	var count int
	if e := f.s.Pool.QueryRow(context.Background(), `SELECT count(*) FROM practice_attempts`).Scan(&count); e != nil || count != 0 {
		t.Fatal("revoked current path accepted grade", count, e)
	}
}

func TestUnchangedTopicKeepsVerifiedSignalButChangedSourceDoesNot(t *testing.T) {
	f := setup(t)
	f.create(t, "path")
	session := f.start(t, "path", "start")
	f.evidence(t, "grade", session.SessionID, true, true)
	f.accept(t, session.SessionID, "grade", "accept")
	d := definition("path")
	d.ExpectedRevision = 1
	d.Goal = "Only the overall goal changes"
	expect(t, f.call("alice", "PUT", "/api/v1/learning-paths/path", "refresh", d), 200)
	w := f.call("alice", "GET", "/api/v1/learning-paths/path/practice-status", "", nil)
	expect(t, w, 200)
	if !strings.Contains(w.Body.String(), `"passed_labs":["sql-customer-revenue"]`) || strings.Contains(w.Body.String(), `"outdated":true`) {
		t.Fatal("unchanged topic lost real verified signal after unrelated goal refresh")
	}
	if _, e := f.s.Pool.Exec(context.Background(), `UPDATE transcript_chunks SET text='Different SQL source content' WHERE id='chunk'`); e != nil {
		t.Fatal(e)
	}
	d.ExpectedRevision = 2
	expect(t, f.call("alice", "PUT", "/api/v1/learning-paths/path", "refresh_again", d), 200)
	w = f.call("alice", "GET", "/api/v1/learning-paths/path/practice-status", "", nil)
	expect(t, w, 200)
	if strings.Contains(w.Body.String(), `"passed_labs":["sql-customer-revenue"]`) || !strings.Contains(w.Body.String(), `"outdated":true`) {
		t.Fatal("changed source inherited old verified outcome")
	}
	w = f.call("alice", "GET", "/api/v1/learning-paths/path/practice-history", "", nil)
	expect(t, w, 200)
	if !strings.Contains(w.Body.String(), `"passed":true`) {
		t.Fatal("source change rewrote immutable historical pass")
	}
}
