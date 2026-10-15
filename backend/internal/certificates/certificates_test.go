package certificates_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"courseforge/backend/internal/api"
	"courseforge/backend/internal/certificates"
	"courseforge/backend/internal/identity"
	"courseforge/backend/internal/learning"
	"courseforge/backend/internal/testutil"

	"github.com/jackc/pgx/v5/pgxpool"
)

type fixture struct {
	pool *pgxpool.Pool
	mux  *http.ServeMux
	auth *identity.Service
}

func setup(t *testing.T) fixture {
	t.Helper()
	pool := testutil.Postgres(t)
	ctx := context.Background()
	for _, user := range []string{"alice", "bob", "outsider", "admin", "unverified"} {
		role := "student"
		if user == "admin" {
			role = "admin"
		}
		if _, err := pool.Exec(ctx, `INSERT INTO users(id,email,name,password_hash,role,verified)VALUES($1,$1||'@private.example.test',$1,'private-password-hash',$2,$3)`, user, role, user != "unverified"); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO auth_sessions(id,user_id,token_hash,csrf_token,expires_at)VALUES($1,$2,$3,'private-csrf',now()+interval '1 hour')`, user+"auth", user, identity.Digest(user+"token")); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(ctx, `INSERT INTO courses(id,title,published)VALUES('sql','SQL',true),('other','Other course',true),('empty','Empty',true),('hidden','Unpublished',false);
 INSERT INTO lessons(id,course_id,title,duration_seconds,status,sort_order)VALUES('lesson1','sql','First lesson',120,'done',1),('lesson2','sql','Pending lesson',120,'queued',2),('otherlesson','other','Other lesson',120,'done',1),('hiddenlesson','hidden','Hidden lesson',120,'done',1);
 INSERT INTO enrollments(user_id,course_id)VALUES('alice','sql'),('bob','sql'),('alice','empty'),('alice','hidden'),('bob','other');`); err != nil {
		t.Fatal(err)
	}
	auth, err := identity.New(pool, identity.Config{PublicOrigin: "http://test", PasswordConcurrency: 1})
	if err != nil {
		t.Fatal(err)
	}
	mux := api.New(pool, auth).Mux
	learning.New(pool, nil).Register(mux, auth)
	certificates.New(pool).Register(mux, auth)
	return fixture{pool, mux, auth}
}

func (f fixture) call(user, method, path, key string, body any) *httptest.ResponseRecorder {
	raw, err := json.Marshal(body)
	if err != nil {
		panic(err)
	}
	r := httptest.NewRequest(method, "http://test"+path, bytes.NewReader(raw))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", "http://test")
	r.Header.Set("X-CSRF-Token", "private-csrf")
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
		t.Fatalf("HTTP %d, expected %d: %s", w.Code, status, w.Body.String())
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

func (f fixture) progress(t *testing.T, user, lesson string, percent int) {
	t.Helper()
	w := f.call(user, "GET", "/api/v1/lessons/"+lesson+"/progress", "", nil)
	expect(t, w, 200)
	revision := read[struct {
		Revision int64 `json:"revision"`
	}](t, w).Revision
	w = f.call(user, "PUT", "/api/v1/lessons/"+lesson+"/progress", "", map[string]any{"percent": percent, "position": 120, "expected_revision": revision})
	expect(t, w, 200)
}

func question() learning.Question {
	correct := 0
	return learning.Question{ID: "question", Question: "Which action preserves a private record?", Options: []string{"Private transaction", "Public broadcast"}, CorrectIndex: &correct, Explanation: "Private explanation and secret answer", SourceStart: 0}
}

func (f fixture) quiz(t *testing.T, lesson string) learning.Quiz {
	t.Helper()
	w := f.call("admin", "POST", "/api/v1/admin/lessons/"+lesson+"/quiz", "quiz-"+lesson, map[string]any{"questions": []learning.Question{question()}, "status": "approved"})
	expect(t, w, 201)
	return read[learning.Quiz](t, w)
}

func (f fixture) attempt(t *testing.T, user string, quiz learning.Quiz, key string, correct bool) learning.QuizResult {
	t.Helper()
	answer := 1
	if correct {
		answer = 0
	}
	w := f.call(user, "POST", "/api/v1/lessons/"+quiz.LessonID+"/quiz/attempts", key, map[string]any{"quiz_id": quiz.ID, "revision": quiz.Revision, "answers": map[string]int{"question": answer}})
	expect(t, w, 201)
	result := read[learning.QuizResult](t, w)
	if result.Passed != correct {
		t.Fatalf("unexpected accepted grading result %+v", result)
	}
	return result
}

func (f fixture) eligible(t *testing.T, user string) {
	t.Helper()
	for _, lesson := range []string{"lesson1", "lesson2"} {
		f.progress(t, user, lesson, 100)
		f.attempt(t, user, f.quiz(t, lesson), "pass-"+lesson, true)
	}
}

func (f fixture) issue(t *testing.T, user, key string) certificates.Certificate {
	t.Helper()
	w := f.call(user, "POST", "/api/v1/courses/sql/certificate", key, map[string]any{})
	expect(t, w, 201)
	return read[certificates.Certificate](t, w)
}

func TestReadinessRequiresEveryLessonAndGETNeverIssues(t *testing.T) {
	f := setup(t)
	w := f.call("alice", "GET", "/api/v1/courses/sql/certificate", "", nil)
	expect(t, w, 200)
	v := read[certificates.Readiness](t, w)
	if v.Eligible || v.Issued || v.TotalLessons != 2 || v.RemainingLessons != 2 || v.RemainingQuizzes != 2 {
		t.Fatalf("initial readiness %+v", v)
	}
	f.progress(t, "alice", "lesson1", 100)
	f.attempt(t, "alice", f.quiz(t, "lesson1"), "pass-one", true)
	w = f.call("alice", "GET", "/api/v1/courses/sql/certificate", "", nil)
	expect(t, w, 200)
	v = read[certificates.Readiness](t, w)
	if v.Eligible || v.TotalLessons != 2 || v.CompletedLessons != 1 || v.PassedQuizzes != 1 {
		t.Fatalf("pending lesson omitted %+v", v)
	}
	f.progress(t, "alice", "lesson2", 100)
	w = f.call("alice", "POST", "/api/v1/courses/sql/certificate", "early", map[string]any{})
	expect(t, w, 200)
	if v = read[certificates.Readiness](t, w); v.Eligible || v.RemainingLessons != 0 || v.RemainingQuizzes != 1 {
		t.Fatalf("missing quiz exempted %+v", v)
	}
	f.attempt(t, "alice", f.quiz(t, "lesson2"), "pass-two", true)
	w = f.call("alice", "GET", "/api/v1/courses/sql/certificate", "", nil)
	expect(t, w, 200)
	if v = read[certificates.Readiness](t, w); !v.Eligible || v.Issued {
		t.Fatalf("eligible GET issued or denied %+v", v)
	}
	var count int
	if err := f.pool.QueryRow(context.Background(), `SELECT count(*) FROM course_certificates`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("GET created a credential count=%d err=%v", count, err)
	}
	w = f.call("alice", "POST", "/api/v1/courses/sql/certificate", "early", map[string]any{})
	expect(t, w, 200)
	if read[certificates.Readiness](t, w).Eligible {
		t.Fatal("retry changed an ineligible command snapshot")
	}
	f.issue(t, "alice", "after-completion")
	w = f.call("alice", "GET", "/api/v1/courses/empty/certificate", "", nil)
	expect(t, w, 200)
	if empty := read[certificates.Readiness](t, w); empty.Eligible || empty.Reason != "Course has no lessons" || empty.TotalLessons != 0 {
		t.Fatalf("empty course %+v", empty)
	}
}

func TestAnyPassedAttemptSurvivesLaterFailureAndQuizWithdrawal(t *testing.T) {
	f := setup(t)
	for _, lesson := range []string{"lesson1", "lesson2"} {
		f.progress(t, "alice", lesson, 100)
		quiz := f.quiz(t, lesson)
		f.attempt(t, "alice", quiz, "first-pass-"+lesson, true)
		f.attempt(t, "alice", quiz, "second-pass-"+lesson, true)
		f.attempt(t, "alice", quiz, "latest-failure-"+lesson, false)
		w := f.call("admin", "PUT", "/api/v1/admin/quizzes/"+quiz.ID, "withdraw-"+lesson, map[string]any{"questions": []learning.Question{question()}, "status": "withdrawn", "expected_revision": quiz.Revision})
		expect(t, w, 200)
	}
	w := f.call("alice", "GET", "/api/v1/courses/sql/certificate", "", nil)
	expect(t, w, 200)
	ready := read[certificates.Readiness](t, w)
	if !ready.Eligible || ready.PassedQuizzes != 2 || ready.CompletedLessons != 2 {
		t.Fatalf("latest failure/revision erased accepted passes: %+v", ready)
	}
	f.issue(t, "alice", "issue")
}

func TestQuizPassAloneAndOtherLearnersCannotCompleteCourse(t *testing.T) {
	f := setup(t)
	for _, lesson := range []string{"lesson1", "lesson2"} {
		quiz := f.quiz(t, lesson)
		f.attempt(t, "alice", quiz, "alice-pass-"+lesson, true)
		f.progress(t, "bob", lesson, 100)
	}
	w := f.call("alice", "GET", "/api/v1/courses/sql/certificate", "", nil)
	expect(t, w, 200)
	if v := read[certificates.Readiness](t, w); v.Eligible || v.CompletedLessons != 0 || v.PassedQuizzes != 2 {
		t.Fatalf("another learner's completion counted: %+v", v)
	}
	w = f.call("bob", "POST", "/api/v1/courses/sql/certificate", "issue", map[string]any{})
	expect(t, w, 200)
	if v := read[certificates.Readiness](t, w); v.Eligible || v.PassedQuizzes != 0 || v.CompletedLessons != 2 {
		t.Fatalf("another learner's quiz pass counted: %+v", v)
	}
	f.progress(t, "bob", "otherlesson", 100)
	f.attempt(t, "bob", f.quiz(t, "otherlesson"), "other-pass", true)
	w = f.call("bob", "GET", "/api/v1/courses/sql/certificate", "", nil)
	expect(t, w, 200)
	if v := read[certificates.Readiness](t, w); v.Eligible || v.PassedQuizzes != 0 {
		t.Fatalf("another course's pass counted: %+v", v)
	}
	expect(t, f.call("outsider", "GET", "/api/v1/courses/sql/certificate", "", nil), 404)
	expect(t, f.call("alice", "GET", "/api/v1/courses/hidden/certificate", "", nil), 404)
	w = f.call("admin", "GET", "/api/v1/courses/hidden/certificate", "", nil)
	expect(t, w, 200)
	if read[certificates.Readiness](t, w).Eligible {
		t.Fatal("admin role bypassed learning requirements")
	}
}

func TestConcurrentIssuanceAcrossServicesAndDurableRetries(t *testing.T) {
	f := setup(t)
	f.eligible(t, "alice")
	second := f
	second.mux = http.NewServeMux()
	certificates.New(f.pool).Register(second.mux, f.auth)
	type response struct {
		key string
		w   *httptest.ResponseRecorder
	}
	var wg sync.WaitGroup
	responses := make(chan response, 8)
	for i := range 8 {
		wg.Go(func() {
			client := f
			if i%2 == 1 {
				client = second
			}
			key := fmt.Sprintf("issue-%d", i)
			responses <- response{key, client.call("alice", "POST", "/api/v1/courses/sql/certificate", key, map[string]any{})}
		})
	}
	wg.Wait()
	close(responses)
	created, code, createdKey := 0, "", ""
	for result := range responses {
		if result.w.Code != 200 && result.w.Code != 201 {
			t.Fatalf("issuance race HTTP %d: %s", result.w.Code, result.w.Body.String())
		}
		cert := read[certificates.Certificate](t, result.w)
		if !cert.Issued || code != "" && cert.VerificationCode != code {
			t.Fatalf("concurrent issuance produced different codes %+v", cert)
		}
		code = cert.VerificationCode
		if result.w.Code == 201 {
			created++
			createdKey = result.key
		}
	}
	if created != 1 || !regexp.MustCompile(`^CF-[A-F0-9]{16}-[A-F0-9]{16}$`).MatchString(code) {
		t.Fatalf("created=%d code=%q", created, code)
	}
	var count int
	if err := f.pool.QueryRow(context.Background(), `SELECT count(*) FROM course_certificates`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("duplicate certificates count=%d err=%v", count, err)
	}
	responses = make(chan response, 8)
	for range 8 {
		wg.Go(func() {
			responses <- response{createdKey, second.call("alice", "POST", "/api/v1/courses/sql/certificate", createdKey, map[string]any{})}
		})
	}
	wg.Wait()
	close(responses)
	for result := range responses {
		expect(t, result.w, 201)
		if read[certificates.Certificate](t, result.w).VerificationCode != code {
			t.Fatal("command retry rotated code")
		}
	}
	expect(t, f.call("alice", "POST", "/api/v1/courses/empty/certificate", createdKey, map[string]any{}), 409)
	// Same key belongs to a different learner's independent command namespace.
	expect(t, f.call("bob", "POST", "/api/v1/courses/sql/certificate", createdKey, map[string]any{}), 200)
}

func TestIssuedSnapshotSurvivesProfileCurriculumAndProgressChanges(t *testing.T) {
	f := setup(t)
	f.eligible(t, "alice")
	original := f.issue(t, "alice", "issue")
	if _, err := f.pool.Exec(context.Background(), `UPDATE users SET name='Renamed learner' WHERE id='alice'; UPDATE courses SET title='Renamed course' WHERE id='sql'; INSERT INTO lessons(id,course_id,title,status)VALUES('new-incomplete','sql','New incomplete lesson','queued')`); err != nil {
		t.Fatal(err)
	}
	f.progress(t, "alice", "lesson1", 0)
	for _, request := range []struct{ method, key string }{{"GET", ""}, {"POST", "issue"}, {"POST", "new-key"}} {
		w := f.call("alice", request.method, "/api/v1/courses/sql/certificate", request.key, map[string]any{})
		status := 200
		if request.key == "issue" {
			status = 201
		}
		expect(t, w, status)
		if got := read[certificates.Certificate](t, w); !reflect.DeepEqual(got, original) {
			t.Fatalf("issued snapshot rewritten: before=%+v after=%+v", original, got)
		}
	}
	if _, err := f.pool.Exec(context.Background(), `UPDATE course_certificates SET student_name='Mutable' WHERE id=$1`, original.CertificateID); err == nil {
		t.Fatal("database allowed immutable issuance edit")
	}
	w := f.call("bob", "GET", "/api/v1/courses/sql/certificate", "", nil)
	expect(t, w, 200)
	if strings.Contains(w.Body.String(), original.CertificateID) || read[certificates.Readiness](t, w).TotalLessons != 3 {
		t.Fatal("other learner received issued credential or omitted new lesson")
	}
}

func TestCSRFAndInputDenialsDoNotIssue(t *testing.T) {
	f := setup(t)
	f.eligible(t, "alice")
	for _, headers := range [][2]string{{"http://evil.example", "private-csrf"}, {"http://test", "wrong"}, {"http://test", ""}} {
		r := httptest.NewRequest("POST", "http://test/api/v1/courses/sql/certificate", strings.NewReader(`{}`))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", headers[0])
		r.Header.Set("X-CSRF-Token", headers[1])
		r.Header.Set("Idempotency-Key", "bad-csrf")
		r.AddCookie(&http.Cookie{Name: identity.CookieName, Value: "alicetoken"})
		w := httptest.NewRecorder()
		f.mux.ServeHTTP(w, r)
		expect(t, w, 403)
	}
	expect(t, f.call("alice", "POST", "/api/v1/courses/sql/certificate", "", map[string]any{}), 400)
	expect(t, f.call("alice", "POST", "/api/v1/courses/sql/certificate", "null", nil), 400)
	expect(t, f.call("alice", "POST", "/api/v1/courses/sql/certificate", "invented", map[string]any{"student_name": "Mallory", "user_id": "bob", "eligible": true}), 400)
	expect(t, f.call("alice", "POST", "/api/v1/courses/sql/certificate", "oversized", map[string]any{"padding": strings.Repeat("x", 17<<10)}), 400)
	expect(t, f.call("", "POST", "/api/v1/courses/sql/certificate", "guest", map[string]any{}), 401)
	expect(t, f.call("unverified", "POST", "/api/v1/courses/sql/certificate", "unverified", map[string]any{}), 403)
	var certs, commands int
	if err := f.pool.QueryRow(context.Background(), `SELECT (SELECT count(*)FROM course_certificates),(SELECT count(*)FROM certificate_commands)`).Scan(&certs, &commands); err != nil || certs != 0 || commands != 0 {
		t.Fatalf("denied write persisted certs=%d commands=%d err=%v", certs, commands, err)
	}
}

func TestCurrentAccessRevocationAndRetention(t *testing.T) {
	f := setup(t)
	f.eligible(t, "alice")
	cert := f.issue(t, "alice", "issue")
	ctx := context.Background()
	for _, change := range []struct {
		apply, restore string
		status         int
	}{
		{`UPDATE auth_sessions SET revoked_at=now()WHERE id='aliceauth'`, `UPDATE auth_sessions SET revoked_at=NULL WHERE id='aliceauth'`, 401},
		{`UPDATE users SET suspended=true WHERE id='alice'`, `UPDATE users SET suspended=false WHERE id='alice'`, 401},
		{`UPDATE users SET verified=false WHERE id='alice'`, `UPDATE users SET verified=true WHERE id='alice'`, 403},
		{`DELETE FROM enrollments WHERE user_id='alice' AND course_id='sql'`, `INSERT INTO enrollments(user_id,course_id)VALUES('alice','sql')`, 404},
		{`UPDATE courses SET published=false WHERE id='sql'`, `UPDATE courses SET published=true WHERE id='sql'`, 404},
	} {
		if _, err := f.pool.Exec(ctx, change.apply); err != nil {
			t.Fatal(err)
		}
		expect(t, f.call("alice", "GET", "/api/v1/courses/sql/certificate", "", nil), change.status)
		expect(t, f.call("alice", "POST", "/api/v1/courses/sql/certificate", "issue", map[string]any{}), change.status)
		expect(t, f.call("", "GET", "/api/v1/certificates/verify/"+cert.VerificationCode, "", nil), 200)
		if _, err := f.pool.Exec(ctx, change.restore); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := f.pool.Exec(ctx, `DELETE FROM courses WHERE id='sql'`); err != nil {
		t.Fatal(err)
	}
	expect(t, f.call("alice", "GET", "/api/v1/courses/sql/certificate", "", nil), 404)
	expect(t, f.call("", "GET", "/api/v1/certificates/verify/"+cert.VerificationCode, "", nil), 200)
	if _, err := f.pool.Exec(ctx, `DELETE FROM users WHERE id='alice'`); err != nil {
		t.Fatal(err)
	}
	expect(t, f.call("", "GET", "/api/v1/certificates/verify/"+cert.VerificationCode, "", nil), 404)
	expect(t, f.call("", "GET", "/verify/"+cert.VerificationCode, "", nil), 404)
	var commands int
	if err := f.pool.QueryRow(ctx, `SELECT count(*) FROM certificate_commands WHERE user_id='alice'`).Scan(&commands); err != nil || commands != 0 {
		t.Fatalf("deleted account retained commands=%d err=%v", commands, err)
	}
}

func TestImportedCodesAndDuplicateSnapshotsRemainVerifiable(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	if _, err := f.pool.Exec(ctx, `INSERT INTO course_certificates(id,user_id,course_id,course_title,student_name,verification_code,completed_at,origin)VALUES
 ('cert_import_old','alice','sql','Original SQL','Original learner','CF-0123ABCD-4567EFAB','2019-03-15T12:00:00Z','legacy'),
 ('cert_import_duplicate','alice','sql','Another historical label','Another historical name','CF-8765ABCD-4321EFAB','2020-04-16T12:00:00Z','legacy')`); err != nil {
		t.Fatal(err)
	}
	w := f.call("alice", "POST", "/api/v1/courses/sql/certificate", "import-retrieve", map[string]any{})
	expect(t, w, 200)
	cert := read[certificates.Certificate](t, w)
	if cert.CertificateID != "cert_import_old" || cert.VerificationCode != "CF-0123ABCD-4567EFAB" || cert.StudentName != "Original learner" || cert.Course != "Original SQL" || !cert.CompletedAt.Equal(time.Date(2019, 3, 15, 12, 0, 0, 0, time.UTC)) {
		t.Fatalf("imported snapshot rotated/recomputed %+v", cert)
	}
	for _, code := range []string{cert.VerificationCode, "CF-8765ABCD-4321EFAB"} {
		w = f.call("", "GET", "/api/v1/certificates/verify/"+url.PathEscape(" "+code+" "), "", nil)
		expect(t, w, 200)
		if read[certificates.Verification](t, w).VerificationCode != code {
			t.Fatal("legacy code changed")
		}
	}
	expect(t, f.call("", "GET", "/api/v1/certificates/verify/"+strings.ToLower(cert.VerificationCode), "", nil), 404)
	var count int
	if err := f.pool.QueryRow(ctx, `SELECT count(*) FROM course_certificates WHERE user_id='alice'`).Scan(&count); err != nil || count != 2 {
		t.Fatalf("legacy rows collapsed or extra credential issued count=%d err=%v", count, err)
	}
}

func TestPublicVerificationIsMinimalAndHTMLEscapesSnapshots(t *testing.T) {
	f := setup(t)
	f.eligible(t, "alice")
	if _, err := f.pool.Exec(context.Background(), `UPDATE users SET name=$1 WHERE id='alice'`, `<img src=x onerror=alert(1)> & Ada`); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(context.Background(), `UPDATE courses SET title=$1 WHERE id='sql'`, `<script>alert('course')</script> & SQL`); err != nil {
		t.Fatal(err)
	}
	cert := f.issue(t, "alice", "issue")
	w := f.call("", "GET", "/api/v1/certificates/verify/"+cert.VerificationCode, "", nil)
	expect(t, w, 200)
	public := read[map[string]any](t, w)
	want := map[string]bool{"valid": true, "student_name": true, "course": true, "completed_at": true, "verification_code": true, "status": true}
	if len(public) != len(want) {
		t.Fatalf("unexpected public fields %v", public)
	}
	for key := range public {
		if !want[key] {
			t.Fatalf("private field exposed %q", key)
		}
	}
	if public["valid"] != true || public["student_name"] != cert.StudentName || public["status"] != "Verified Official CourseForge Certificate" {
		t.Fatalf("verification mismatch %v", public)
	}
	w = f.call("", "GET", cert.VerifyURL, "", nil)
	expect(t, w, 200)
	html := w.Body.String()
	if strings.Contains(html, `<img src=x`) || strings.Contains(html, `<script>alert`) || !strings.Contains(html, "&lt;img") || !strings.Contains(html, "&lt;script&gt;") || !strings.Contains(html, "Print / Save PDF") || !strings.Contains(html, "window.print()") {
		t.Fatalf("unsafe or incomplete verification page: %s", html)
	}
	nonce := regexp.MustCompile(`nonce="([a-f0-9]{32})"`).FindStringSubmatch(html)
	if len(nonce) != 2 || !strings.Contains(w.Header().Get("Content-Security-Policy"), "'nonce-"+nonce[1]+"'") || w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("Referrer-Policy") != "no-referrer" {
		t.Fatalf("missing safe page headers %v", w.Header())
	}
	for _, secret := range []string{"@private.example.test", "private-csrf", "private-password-hash", "Private explanation", cert.CertificateID, "criterion_version"} {
		if strings.Contains(html, secret) {
			t.Fatalf("public HTML leaked %q", secret)
		}
	}
	bad := url.PathEscape(`<svg onload=alert(1)>`)
	w = f.call("", "GET", "/verify/"+bad, "", nil)
	expect(t, w, 404)
	if strings.Contains(w.Body.String(), `<svg`) || strings.Contains(w.Body.String(), cert.StudentName) || !strings.Contains(w.Body.String(), "Certificate Not Found") {
		t.Fatalf("unsafe not-found page: %s", w.Body.String())
	}
	expect(t, f.call("", "GET", "/api/v1/certificates/verify/"+bad, "", nil), 404)
}

func TestIdentityRevocationBetweenAuthenticationAndWriteIsRechecked(t *testing.T) {
	f := setup(t)
	f.eligible(t, "alice")
	ctx := context.Background()
	tx, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	var pid int32
	if err = tx.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `SELECT id FROM users WHERE id='alice' FOR UPDATE`); err != nil {
		t.Fatal(err)
	}
	response := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		response <- f.call("alice", "POST", "/api/v1/courses/sql/certificate", "revocation-race", map[string]any{})
	}()
	deadline := time.Now().Add(time.Second)
	blocked := false
	for time.Now().Before(deadline) {
		if err = f.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)))`, pid).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if !blocked {
		t.Fatal("request did not reach authoritative identity lock")
	}
	if _, err = tx.Exec(ctx, `UPDATE users SET suspended=true WHERE id='alice'`); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case w := <-response:
		expect(t, w, 401)
	case <-time.After(time.Second):
		t.Fatal("revoked issuance request did not finish")
	}
	var count int
	if err = f.pool.QueryRow(ctx, `SELECT count(*) FROM course_certificates`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("revocation race issued certificate count=%d err=%v", count, err)
	}
}
