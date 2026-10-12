package administration

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"courseforge/backend/internal/activity"
	"courseforge/backend/internal/api"
	"courseforge/backend/internal/identity"
	"courseforge/backend/internal/playback"
	"courseforge/backend/internal/testutil"
)

type fixture struct {
	s     *Service
	mux   *http.ServeMux
	clock *atomic.Int64
}

func setup(t *testing.T) fixture {
	t.Helper()
	pool := testutil.Postgres(t)
	ctx := context.Background()
	for _, user := range []string{"admin", "otheradmin", "alice", "bob", "unverified"} {
		role := "student"
		if strings.Contains(user, "admin") {
			role = "admin"
		}
		if _, err := pool.Exec(ctx, `INSERT INTO users(id,email,name,password_hash,role,verified)VALUES($1,$1||'@example.test',$1,'secret-password-hash',$2,$3)`, user, role, user != "unverified"); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO auth_sessions(id,user_id,token_hash,csrf_token,expires_at,device,ip)VALUES($1,$2,$3,'csrf-secret',now()+interval '12 hours','Synthetic device','192.0.2.1')`, user+"auth", user, identity.Digest(user+"token")); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(ctx, `INSERT INTO courses(id,title,published)VALUES('course','Synthetic course',true),('hidden','Hidden course',false);INSERT INTO lessons(id,course_id,title,duration_seconds)VALUES('lesson1','course','Synthetic lecture',100),('lesson2','course','Second lecture',100),('hiddenlesson','hidden','Hidden lecture',100);INSERT INTO enrollments(user_id,course_id)VALUES('alice','course'),('bob','course'),('alice','hidden');`); err != nil {
		t.Fatal(err)
	}
	auth, err := identity.New(pool, identity.Config{PublicOrigin: "http://test", PasswordConcurrency: 1})
	if err != nil {
		t.Fatal(err)
	}
	clock := &atomic.Int64{}
	clock.Store(time.Now().UTC().Truncate(time.Microsecond).UnixNano())
	now := func() time.Time { return time.Unix(0, clock.Load()).UTC() }
	s := New(pool)
	s.Now = now
	mux := api.New(pool, auth).Mux
	s.Register(mux, auth)
	a := activity.New(pool)
	a.Now = now
	a.Register(mux, auth)
	p := playback.New(pool, auth)
	p.Now = now
	p.Register(mux)
	return fixture{s, mux, clock}
}
func (f fixture) now() time.Time  { return time.Unix(0, f.clock.Load()).UTC() }
func (f fixture) advance(sec int) { f.clock.Add(int64(time.Duration(sec) * time.Second)) }
func (f fixture) exec(t *testing.T, query string, args ...any) {
	t.Helper()
	if _, err := f.s.Pool.Exec(context.Background(), query, args...); err != nil {
		t.Fatal(err)
	}
}
func (f fixture) call(user, method, path string, body any) *httptest.ResponseRecorder {
	raw, _ := json.Marshal(body)
	r := httptest.NewRequest(method, "http://test"+path, strings.NewReader(string(raw)))
	r.Header.Set("Origin", "http://test")
	r.Header.Set("X-CSRF-Token", "csrf-secret")
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Idempotency-Key", "command-"+path)
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
		t.Fatalf("status%d expected%d: %s", w.Code, status, w.Body.String())
	}
}
func read[T any](t *testing.T, w *httptest.ResponseRecorder) T {
	t.Helper()
	var result T
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	return result
}
func (f fixture) get(t *testing.T, path string) map[string]any {
	t.Helper()
	w := f.call("admin", "GET", path, nil)
	expect(t, w, 200)
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("private report cached")
	}
	return read[map[string]any](t, w)
}
func (f fixture) open(t *testing.T, user, lesson string, bound string) string {
	t.Helper()
	body := map[string]any{}
	if bound != "" {
		body["player_session_id"] = bound
	}
	w := f.call(user, "POST", "/api/v1/lessons/"+lesson+"/activity-session", body)
	expect(t, w, 201)
	return read[struct{ ID string }](t, w).ID
}
func (f fixture) player(t *testing.T, user string) string {
	t.Helper()
	w := f.call(user, "POST", "/api/v1/playback/sessions", map[string]any{"lesson_id": "lesson1"})
	expect(t, w, 201)
	return read[struct{ ID string }](t, w).ID
}
func (f fixture) credit(t *testing.T, user, id string, sequence int) {
	t.Helper()
	expect(t, f.call(user, "POST", "/api/v1/activity/"+id+"/heartbeat", map[string]any{"sequence": sequence, "visible": true, "elapsed_seconds": 10}), 200)
}
func (f fixture) replica(t *testing.T) fixture {
	t.Helper()
	auth, err := identity.New(f.s.Pool, identity.Config{PublicOrigin: "http://test", PasswordConcurrency: 1})
	if err != nil {
		t.Fatal(err)
	}
	s := New(f.s.Pool)
	s.Now = f.s.Now
	mux := http.NewServeMux()
	s.Register(mux, auth)
	return fixture{s, mux, f.clock}
}

func TestAllReportsRequireCurrentAdministrator(t *testing.T) {
	f := setup(t)
	paths := []string{"/overview", "/course-funnels", "/learner-reports", "/users/alice/learning-report", "/users/alice/reports/progress", "/player-activity", "/playback", "/player-activity/export", "/playback/export", "/audit", "/access-events", "/system"}
	for _, path := range paths {
		for _, entry := range []struct {
			user   string
			status int
		}{{"", 401}, {"alice", 403}, {"unverified", 403}} {
			expect(t, f.call(entry.user, "GET", "/api/v1/admin"+path, nil), entry.status)
		}
	}
	f.exec(t, `UPDATE auth_sessions SET revoked_at=now() WHERE id='adminauth'`)
	expect(t, f.call("admin", "GET", "/api/v1/admin/overview", nil), 401)
	f.exec(t, `UPDATE users SET role='student' WHERE id='otheradmin'`)
	expect(t, f.call("otheradmin", "GET", "/api/v1/admin/system", nil), 403)
	f.exec(t, `UPDATE users SET suspended=true WHERE id='otheradmin'`)
	expect(t, f.call("otheradmin", "GET", "/api/v1/admin/playback/export", nil), 401)
	var count int
	if err := f.s.Pool.QueryRow(context.Background(), `SELECT count(*) FROM admin_audit`).Scan(&count); err != nil || count != 0 {
		t.Fatal("denied reports audited as exports", count, err)
	}
}

func TestOverviewLearnerProjectionIndependentTotalsAndLiteralSearch(t *testing.T) {
	f := setup(t)
	f.exec(t, `INSERT INTO lesson_activity_totals(user_id,lesson_id,activity_seconds,updated_at)VALUES('alice','lesson1',10,now()),('alice','lesson2',5,now()),('bob','lesson1',77,now());
 INSERT INTO playback_totals(user_id,lesson_id,watched_seconds,coverage)VALUES('alice','lesson1',20,'[[0,10]]'),('bob','lesson1',88,'[]');
 INSERT INTO progress(user_id,lesson_id,completed,explicit_completed,percent,position)VALUES('alice','lesson1',true,true,20,10),('alice','lesson2',true,false,90,95),('bob','lesson1',true,true,100,100);
 INSERT INTO notes(id,user_id,lesson_id,content,idempotency_key)VALUES('n1','alice','lesson1','private-note-sentinel','n1'),('n2','alice','lesson2','private-note-sentinel','n2');
 INSERT INTO bookmarks(id,user_id,lesson_id,position,label)VALUES('b1','alice','lesson1',0,'private-bookmark');`)
	f.exec(t, `INSERT INTO focus_sessions(id,user_id,mode,status,duration_seconds,elapsed_seconds,run_started_at,title)VALUES('f1','alice','focus','running',60,10,$1,'Focus'),('f2','alice','focus','cancelled',60,50,NULL,'Cancelled'),('f3','alice','break','finished',60,60,NULL,'Break'),('f4','bob','focus','finished',60,30,NULL,'Other learner')`, f.now().Add(-100*time.Second))
	learner := f.get(t, "/api/v1/admin/users/alice/learning-report")["user"].(map[string]any)
	for k, want := range map[string]float64{"enrollments": 2, "completed_lessons": 2, "activity_seconds": 15, "watched_seconds": 20, "measured_focus_seconds": 60, "note_count": 2, "bookmark_count": 1} {
		if learner[k] != want {
			t.Fatal("learner projection", k, learner[k], want)
		}
	}
	playback := f.get(t, "/api/v1/admin/users/alice/reports/playback")["items"].([]any)[0].(map[string]any)
	if playback["watched_seconds"] != float64(20) || playback["coverage_percent"] != float64(10) || playback["position"] != float64(10) {
		t.Fatal("wall watch, coverage and resume were conflated", playback)
	}
	overview := f.get(t, "/api/v1/admin/overview")["summary"].(map[string]any)
	for k, want := range map[string]float64{"students": 3, "enrollments": 3, "completed_lessons": 3, "activity_seconds": 92, "watched_seconds": 108, "measured_focus_seconds": 90, "lectures": 3} {
		if overview[k] != want {
			t.Fatal("multiplied overview aggregate", k, overview[k], want)
		}
	}
	f.exec(t, `UPDATE users SET name='100%_literal' WHERE id='alice'`)
	for _, q := range []string{"%25", "_literal"} {
		result := f.get(t, "/api/v1/admin/learner-reports?q="+q)
		if result["total"] != float64(1) {
			t.Fatal("search treated wildcard", result)
		}
	}
	result := f.get(t, "/api/v1/admin/learner-reports?q=ZZZ")
	if result["total"] != float64(0) {
		t.Fatal(result)
	}
	expect(t, f.call("admin", "GET", "/api/v1/admin/users/missing/learning-report", nil), 404)
}

func TestAllLearnerSectionsAreScopedAndExcludeGradingSecrets(t *testing.T) {
	f := setup(t)
	f.exec(t, `INSERT INTO lesson_quizzes(id,lesson_id,course_id,status)VALUES('q1','lesson1','course','approved');INSERT INTO quiz_versions(quiz_id,revision,questions)VALUES('q1',1,'[{"correct_index":0,"explanation":"grading-secret-sentinel"}]');
 INSERT INTO quiz_attempts(id,user_id,lesson_id,quiz_id,quiz_revision,score,correct_count,total_count,passed,answers,result)VALUES('qa1','alice','lesson1','q1',1,100,1,1,true,'{"secret":"grading-secret-sentinel"}','{"secret":"grading-secret-sentinel"}'),('qa2','bob','lesson1','q1',1,0,0,1,false,'{}','{}');
 INSERT INTO review_cards(id,user_id,course_id,lesson_id,question,answer)VALUES('rc1','alice','course','lesson1','Question long enough?','grading-secret-sentinel');INSERT INTO review_attempts(id,user_id,card_id,course_id,quality,card_revision,schedule)VALUES('ra1','alice','rc1','course',5,1,'{}');
 INSERT INTO learning_paths(id,user_id,goal,course_ids,definition,provenance,source_fingerprint)VALUES('path1','alice','Synthetic goal',ARRAY['course'],'{}','manual','fingerprint');
 INSERT INTO topic_assessments(id,user_id,path_id,step_id,source_fingerprint,content,provenance)VALUES('ta1','alice','path1','step1','fingerprint','{"secret":"grading-secret-sentinel"}','manual');
 INSERT INTO topic_assessment_attempts(id,user_id,assessment_id,score,correct_count,total_count,answers,result)VALUES('taa1','alice','ta1',100,3,3,'{"secret":"grading-secret-sentinel"}','{"secret":"grading-secret-sentinel"}');
 INSERT INTO daily_plans(id,user_id,study_date,budget_minutes,timezone)VALUES('day1','alice',CURRENT_DATE,45,'UTC');
 INSERT INTO access_events(user_id,event_type)VALUES('alice','sign_in'),('bob','sign_in');`)
	f.open(t, "alice", "lesson1", "")
	for _, kind := range sectionNames {
		w := f.call("admin", "GET", "/api/v1/admin/users/alice/reports/"+kind, nil)
		expect(t, w, 200)
		body := w.Body.String()
		for _, secret := range []string{"grading-secret-sentinel", "secret-password-hash", "csrf-secret", "bob", "token_hash", "correct_index"} {
			if strings.Contains(body, secret) {
				t.Fatal("private section leaked foreign/secret field", kind, secret)
			}
		}
	}
	for kind, want := range map[string]int{"quizzes": 1, "reviews": 1, "assessments": 1, "plans": 1, "access": 1} {
		result := f.get(t, "/api/v1/admin/users/alice/reports/"+kind)
		if len(result["items"].([]any)) != want {
			t.Fatal("missing owned section row", kind, result)
		}
	}
	for _, kind := range []string{"labs", "events"} {
		w := f.call("admin", "GET", "/api/v1/admin/users/alice/reports/"+kind, nil)
		expect(t, w, 503)
		if !strings.Contains(w.Body.String(), "report_adapter_unavailable") {
			t.Fatal("unavailable section fabricated")
		}
	}
	expect(t, f.call("admin", "GET", "/api/v1/admin/users/alice/reports/unknown", nil), 404)
	expect(t, f.call("admin", "GET", "/api/v1/admin/users/missing/reports/labs", nil), 404)
}

func TestActivityAndPlaybackLiveFlagsRecheckCurrentAccess(t *testing.T) {
	f := setup(t)
	p := f.player(t, "alice")
	a := f.open(t, "alice", "lesson1", p)
	expect(t, f.call("alice", "POST", "/api/v1/playback/sessions/"+p+"/pulse", map[string]any{"sequence": 1, "kind": "playing", "position": 0, "elapsed_seconds": 0, "playing": true, "visible": true, "playback_rate": 1}), 200)
	f.advance(10)
	expect(t, f.call("alice", "POST", "/api/v1/playback/sessions/"+p+"/pulse", map[string]any{"sequence": 2, "kind": "playing", "position": 10, "elapsed_seconds": 10, "playing": true, "visible": true, "playback_rate": 1}), 200)
	f.credit(t, "alice", a, 1)
	for _, kind := range []string{"player-activity", "playback"} {
		result := f.get(t, "/api/v1/admin/"+kind+"?status=live")
		if result["total"] != float64(1) || result["summary"].(map[string]any)["session_seconds"] != float64(10) {
			t.Fatal("live report time", kind, result)
		}
	}
	f.exec(t, `DELETE FROM enrollments WHERE user_id='alice' AND course_id='course'`)
	for _, kind := range []string{"player-activity", "playback"} {
		live := f.get(t, "/api/v1/admin/"+kind+"?status=live")
		all := f.get(t, "/api/v1/admin/"+kind)
		if live["total"] != float64(0) || all["total"] != float64(1) {
			t.Fatal("historical/live access conflated", kind, live, all)
		}
	}
	f.exec(t, `INSERT INTO enrollments(user_id,course_id)VALUES('alice','course');UPDATE courses SET published=false WHERE id='course'`)
	for _, kind := range []string{"player-activity", "playback"} {
		if f.get(t, "/api/v1/admin/"+kind+"?status=live")["total"] != float64(0) {
			t.Fatal("unpublished live row", kind)
		}
	}
	f.exec(t, `UPDATE courses SET published=true WHERE id='course';UPDATE auth_sessions SET revoked_at=now() WHERE id='aliceauth'`)
	for _, kind := range []string{"player-activity", "playback"} {
		if f.get(t, "/api/v1/admin/"+kind+"?status=live")["total"] != float64(0) {
			t.Fatal("revoked login live row", kind)
		}
	}
}

func TestCursorStableTiesFiltersAndDetailTotalsIgnorePageLimit(t *testing.T) {
	f := setup(t)
	a := f.open(t, "alice", "lesson1", "")
	f.advance(10)
	f.credit(t, "alice", a, 1)
	f.open(t, "alice", "lesson2", "")
	f.open(t, "bob", "lesson1", "")
	result := f.get(t, "/api/v1/admin/player-activity?limit=1")
	if result["total"] != float64(3) || result["summary"].(map[string]any)["session_seconds"] != float64(10) || result["next_cursor"] == "" {
		t.Fatal("detail pagination changed totals", result)
	}
	seen := map[string]bool{}
	for {
		items := result["sessions"].([]any)
		if len(items) != 1 {
			t.Fatal(result)
		}
		id := items[0].(map[string]any)["id"].(string)
		if seen[id] {
			t.Fatal("cursor duplicated tie")
		}
		seen[id] = true
		cursor := result["next_cursor"].(string)
		if cursor == "" {
			break
		}
		result = f.get(t, "/api/v1/admin/player-activity?limit=1&cursor="+cursor)
	}
	if len(seen) != 3 {
		t.Fatal("cursor omitted tie", seen)
	}
	for _, query := range []string{"?user_id=alice", "?q=Second", "?course_id=missing"} {
		want := float64(2)
		if query == "?q=Second" {
			want = 1
		}
		if query == "?course_id=missing" {
			want = 0
		}
		if f.get(t, "/api/v1/admin/player-activity"+query)["total"] != want {
			t.Fatal("detail filter", query)
		}
	}
	f.exec(t, `UPDATE activity_sessions SET created_at=created_at-interval '31 days' WHERE user_id='bob'`)
	if f.get(t, "/api/v1/admin/player-activity")["total"] != float64(2) || f.get(t, "/api/v1/admin/player-activity?days=90")["total"] != float64(3) {
		t.Fatal("detail period ignored")
	}
	for _, query := range []string{"?limit=0", "?limit=101", "?limit=no", "?cursor=invalid", "?cursor=" + strings.Repeat("a", 1001), "?days=0", "?days=91", "?days=no", "?status=paused", "?q=" + strings.Repeat("a", 121), "?course_id=" + strings.Repeat("a", 513)} {
		expect(t, f.call("admin", "GET", "/api/v1/admin/player-activity"+query, nil), 400)
	}
}

func TestCSVFormulaProtectionSharedAdmissionAuditAndRecovery(t *testing.T) {
	f := setup(t)
	other := f.replica(t)
	f.exec(t, `UPDATE users SET name=' =SUM(1,2)',email='+formula@example.test' WHERE id='alice';UPDATE lessons SET title=E'\t@danger' WHERE id='lesson1'`)
	a := f.open(t, "alice", "lesson1", "")
	f.exec(t, `UPDATE activity_sessions SET device=E'\r-danger',ip='@command' WHERE id=$1`, a)
	w := f.call("admin", "GET", "/api/v1/admin/player-activity/export", nil)
	expect(t, w, 200)
	records, err := csv.NewReader(strings.NewReader(w.Body.String())).ReadAll()
	if err != nil || len(records) != 2 {
		t.Fatal("invalid CSV", records, err)
	}
	row := records[1]
	for _, index := range []int{0, 1, 2, 7, 8} {
		if !strings.HasPrefix(row[index], "'") {
			t.Fatal("formula cell not protected", index, row)
		}
	}
	if w.Header().Get("Content-Disposition") != `attachment; filename="courseforge-lesson-activity.csv"` || w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal("unsafe CSV headers", w.Header())
	}
	for _, secret := range []string{"token_hash", "csrf-secret", "secret-password-hash", "auth_session_id", "player_session_id"} {
		if strings.Contains(w.Body.String(), secret) {
			t.Fatal("CSV secret", secret)
		}
	}
	for i := 1; i < 10; i++ {
		caller := f
		if i%2 == 1 {
			caller = other
		}
		path := "/api/v1/admin/player-activity/export"
		if i%2 == 1 {
			path = "/api/v1/admin/playback/export"
		}
		expect(t, caller.call("admin", "GET", path, nil), 200)
	}
	w = other.call("admin", "GET", "/api/v1/admin/playback/export", nil)
	expect(t, w, 429)
	if w.Header().Get("Retry-After") == "" {
		t.Fatal("missing export backoff")
	}
	var audits int
	if err = f.s.Pool.QueryRow(context.Background(), `SELECT count(*) FROM admin_audit WHERE actor_id='admin'`).Scan(&audits); err != nil || audits != 10 {
		t.Fatal("export audit/quota mismatch", audits, err)
	}
	expect(t, f.call("otheradmin", "GET", "/api/v1/admin/player-activity/export", nil), 200)
	f.advance(3600)
	expect(t, other.call("admin", "GET", "/api/v1/admin/playback/export", nil), 200)
}

func TestOversizedExportHasNoPartialFileAuditOrQuota(t *testing.T) {
	f := setup(t)
	f.exec(t, `INSERT INTO activity_sessions(id,user_id,auth_session_id,lesson_id,last_heartbeat,created_at,expires_at)SELECT 'bulk_'||g,'alice','aliceauth','lesson1',now(),now(),now()+interval '6 hours' FROM generate_series(1,10001)g`)
	w := f.call("admin", "GET", "/api/v1/admin/player-activity/export", nil)
	expect(t, w, 413)
	if strings.Contains(w.Header().Get("Content-Type"), "csv") {
		t.Fatal("partial CSV returned")
	}
	var count int
	for _, sql := range []string{`SELECT count(*) FROM admin_audit`, `SELECT count(*) FROM login_limits WHERE key LIKE 'admin-report-export:%'`} {
		if err := f.s.Pool.QueryRow(context.Background(), sql).Scan(&count); err != nil || count != 0 {
			t.Fatal("oversized export committed side effects", count, err)
		}
	}
	expect(t, f.call("admin", "GET", "/api/v1/admin/player-activity/export?limit=1", nil), 400)
	expect(t, f.call("admin", "GET", "/api/v1/admin/player-activity/export?cursor=unused", nil), 400)
	f.exec(t, `DELETE FROM activity_sessions WHERE id!='bulk_1';UPDATE lessons SET title=repeat('x',70000) WHERE id='lesson1'`)
	expect(t, f.call("admin", "GET", "/api/v1/admin/player-activity/export", nil), 413)
	for _, sql := range []string{`SELECT count(*) FROM admin_audit`, `SELECT count(*) FROM login_limits WHERE key LIKE 'admin-report-export:%'`} {
		if err := f.s.Pool.QueryRow(context.Background(), sql).Scan(&count); err != nil || count != 0 {
			t.Fatal("row byte bound committed side effects", count, err)
		}
	}
}

func TestCSVByteBudgetRejectsWholeSnapshotWithoutCommitting(t *testing.T) {
	f := setup(t)
	f.exec(t, `UPDATE lessons SET title=repeat('x',4000) WHERE id='lesson1';INSERT INTO activity_sessions(id,user_id,auth_session_id,lesson_id,last_heartbeat,created_at,expires_at)SELECT 'bulk_'||g,'alice','aliceauth','lesson1',now(),now(),now()+interval '6 hours' FROM generate_series(1,5000)g`)
	expect(t, f.call("admin", "GET", "/api/v1/admin/player-activity/export", nil), 413)
	var count int
	if err := f.s.Pool.QueryRow(context.Background(), `SELECT count(*) FROM admin_audit`).Scan(&count); err != nil || count != 0 {
		t.Fatal("byte limit audit", count, err)
	}
	if err := f.s.Pool.QueryRow(context.Background(), `SELECT count(*) FROM login_limits WHERE key LIKE 'admin-report-export:%'`).Scan(&count); err != nil || count != 0 {
		t.Fatal("byte limit quota", count, err)
	}
}

func TestAuthCleanupReportRetentionIsTruthfulAndLifetimeSurvives(t *testing.T) {
	f := setup(t)
	p := f.player(t, "alice")
	a := f.open(t, "alice", "lesson1", p)
	f.advance(10)
	f.credit(t, "alice", a, 1)
	f.exec(t, `UPDATE playback_totals SET watched_seconds=20 WHERE user_id='alice';DELETE FROM auth_sessions WHERE id='aliceauth'`)
	activity := f.get(t, "/api/v1/admin/player-activity")
	native := f.get(t, "/api/v1/admin/playback")
	if activity["total"] != float64(1) || native["total"] != float64(0) || activity["sessions"].([]any)[0].(map[string]any)["live"] != false {
		t.Fatal("native/session retention fabricated", activity, native)
	}
	learner := f.get(t, "/api/v1/admin/users/alice/learning-report")["user"].(map[string]any)
	if learner["watched_seconds"] != float64(20) || learner["activity_seconds"] != float64(10) {
		t.Fatal("detail retention reduced lifetime", learner)
	}
}

func TestSystemReportsSQLFactsUnknownCapabilitiesAndNoProviderDetails(t *testing.T) {
	f := setup(t)
	f.exec(t, `INSERT INTO lesson_providers(lesson_id,claim_name,claim_id)VALUES('lesson1','private-provider-name','private-provider-id');INSERT INTO account_tokens(token_hash,user_id,kind,expires_at)VALUES('private-account-token','alice','invite',now()+interval '1 day');INSERT INTO jobs(id,user_id,lesson_id,kind,resource,idempotency_key,payload)VALUES('job','alice','lesson1','tutor','ai','job','{}');INSERT INTO admin_audit(actor_id,action,resource)VALUES('admin','Synthetic action','course');INSERT INTO access_events(user_id,event_type)VALUES('alice','sign_in')`)
	w := f.call("admin", "GET", "/api/v1/admin/system", nil)
	expect(t, w, 200)
	v := read[map[string]any](t, w)
	caps := v["capabilities"].(map[string]any)
	if caps["provider_configured"] != nil || caps["email_configured"] != nil || v["pending_invitations"] != float64(1) || v["tasks"].(map[string]any)["queued"] != float64(1) {
		t.Fatal("system invented config or facts", v)
	}
	if v["retention"].(map[string]any)["scheduler_status"] != "not_integrated_by_this_module" {
		t.Fatal("scheduler claimed")
	}
	for _, secret := range []string{"private-provider-name", "private-provider-id", "private-account-token", "secret-password-hash", "token_hash", "csrf-secret"} {
		if strings.Contains(w.Body.String(), secret) {
			t.Fatal("system secret", secret)
		}
	}
	if len(f.get(t, "/api/v1/admin/audit")["items"].([]any)) != 1 || len(f.get(t, "/api/v1/admin/access-events?user_id=alice")["items"].([]any)) != 1 {
		t.Fatal("missing audit/access")
	}
}

func TestConcurrentExportsRespectSharedQuotaWithoutDuplicatingAudits(t *testing.T) {
	f := setup(t)
	other := f.replica(t)
	f.open(t, "alice", "lesson1", "")
	start := make(chan struct{})
	responses := make(chan *httptest.ResponseRecorder, 16)
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		caller := f
		if i%2 == 1 {
			caller = other
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			responses <- caller.call("admin", "GET", "/api/v1/admin/player-activity/export", nil)
		}()
	}
	close(start)
	wg.Wait()
	close(responses)
	successful := 0
	for w := range responses {
		if w.Code == 200 {
			successful++
		} else if w.Code != 429 {
			t.Fatalf("concurrent export unexpected status%d: %s", w.Code, w.Body.String())
		}
	}
	if successful != 10 {
		t.Fatal("concurrent quota accepted wrong count", successful)
	}
	var count, audits int
	if err := f.s.Pool.QueryRow(context.Background(), `SELECT count FROM login_limits WHERE key='admin-report-export:admin'`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if err := f.s.Pool.QueryRow(context.Background(), `SELECT count(*) FROM admin_audit WHERE actor_id='admin'`).Scan(&audits); err != nil || count != 10 || audits != 10 {
		t.Fatal("quota/audit mismatch", count, audits, err)
	}
}

func TestCSVCellProtectsWhitespaceAndLeavesPlainText(t *testing.T) {
	for _, value := range []string{"=formula", " +formula", "-formula", "@formula", "\tplain", "\rplain", "\nplain", " \tplain", "\u2003=formula"} {
		if got := csvCell(value); got != "'"+value {
			t.Fatal("unsafe cell", fmt.Sprintf("%q", value), got)
		}
	}
	for _, value := range []string{"Alice", "", "123", "  ordinary", "name\nsecond line"} {
		if got := csvCell(value); got != value {
			t.Fatal("ordinary text changed", value, got)
		}
	}
}

func TestExactExportRowCapProducesCompleteSafeCSV(t *testing.T) {
	f := setup(t)
	f.exec(t, `INSERT INTO activity_sessions(id,user_id,auth_session_id,lesson_id,last_heartbeat,created_at,expires_at)SELECT 'bulk_'||g,'alice','aliceauth','lesson1',now(),now(),now()+interval '6 hours' FROM generate_series(1,10000)g`)
	w := f.call("admin", "GET", "/api/v1/admin/player-activity/export", nil)
	expect(t, w, 200)
	rows, err := csv.NewReader(strings.NewReader(w.Body.String())).ReadAll()
	if err != nil || len(rows) != 10001 {
		t.Fatal("exact-cap CSV incomplete", len(rows), err)
	}
	var count int
	if err = f.s.Pool.QueryRow(context.Background(), `SELECT count(*) FROM admin_audit WHERE resource='10000 sessions / 30 days'`).Scan(&count); err != nil || count != 1 {
		t.Fatal("exact-cap export audit", count, err)
	}
}

func TestBoundMissingPlayerWaitingHiddenAndLearnerStatusAreNeverLive(t *testing.T) {
	f := setup(t)
	p := f.player(t, "alice")
	a := f.open(t, "alice", "lesson1", p)
	f.open(t, "alice", "lesson2", "")
	if result := f.get(t, "/api/v1/admin/player-activity?status=live"); result["total"] != float64(1) {
		t.Fatal("waiting activity was live", result)
	}
	f.exec(t, `UPDATE activity_sessions SET player_session_id=NULL WHERE id=$1`, a)
	if result := f.get(t, "/api/v1/admin/player-activity?status=live"); result["total"] != float64(0) {
		t.Fatal("missing bound player converted to live unbound activity", result)
	}
	f.exec(t, `UPDATE activity_sessions SET player_session_id=$2 WHERE id=$1`, a, p)
	for _, update := range []string{`UPDATE users SET verified=false WHERE id='alice'`, `UPDATE users SET verified=true,suspended=true WHERE id='alice'`, `UPDATE users SET verified=true,suspended=false WHERE id='alice';UPDATE activity_leases SET expires_at=now()-interval '1 second' WHERE user_id='alice'`} {
		f.exec(t, update)
		if result := f.get(t, "/api/v1/admin/player-activity?status=live"); result["total"] != float64(0) {
			t.Fatal("inactive learner or lease was live", result)
		}
	}
	// Administrator course access is a deliberate exception, including hidden courses.
	w := f.call("otheradmin", "POST", "/api/v1/playback/sessions", map[string]any{"lesson_id": "hiddenlesson"})
	expect(t, w, 201)
	adminPlayer := read[struct{ ID string }](t, w).ID
	f.open(t, "otheradmin", "hiddenlesson", adminPlayer)
	expect(t, f.call("otheradmin", "POST", "/api/v1/playback/sessions/"+adminPlayer+"/pulse", map[string]any{"sequence": 1, "kind": "playing", "position": 0, "elapsed_seconds": 0, "playing": true, "visible": true, "playback_rate": 1}), 200)
	for _, kind := range []string{"player-activity", "playback"} {
		if result := f.get(t, "/api/v1/admin/"+kind+"?status=live&course_id=hidden"); result["total"] != float64(1) {
			t.Fatal("admin current-course exception lost", kind, result)
		}
	}
}

func TestCourseFunnelsPaginationAndSystemTruncationAreExplicit(t *testing.T) {
	f := setup(t)
	f.open(t, "alice", "lesson1", "")
	f.open(t, "alice", "lesson2", "")
	f.exec(t, `INSERT INTO courses(id,title)SELECT 'extra_'||lpad(g::text,3,'0'),'Extra course' FROM generate_series(1,101)g`)
	system := f.get(t, "/api/v1/admin/system")
	if system["course_count"] != float64(103) || system["courses_truncated"] != true || len(system["courses"].([]any)) != 100 {
		t.Fatal("system silently truncated courses", system)
	}
	report := f.get(t, "/api/v1/admin/course-funnels?limit=100")
	seen := map[string]bool{}
	for {
		for _, raw := range report["items"].([]any) {
			v := raw.(map[string]any)
			id := v["course_id"].(string)
			if seen[id] {
				t.Fatal("funnel cursor duplicate", id)
			}
			seen[id] = true
			if id == "course" && (v["enrolled"] != float64(2) || v["started"] != float64(1)) {
				t.Fatal("course funnel join multiplied visits", v)
			}
		}
		cursor := report["next_cursor"].(string)
		if cursor == "" {
			break
		}
		report = f.get(t, "/api/v1/admin/course-funnels?limit=100&cursor="+cursor)
	}
	if len(seen) != 103 {
		t.Fatal("funnel pagination omitted courses", len(seen))
	}
}

func TestEmptyFilteredCSVContainsHeaderAndAuditsSnapshot(t *testing.T) {
	f := setup(t)
	for _, kind := range []string{"player-activity", "playback"} {
		w := f.call("admin", "GET", "/api/v1/admin/"+kind+"/export?course_id=missing", nil)
		expect(t, w, 200)
		records, err := csv.NewReader(strings.NewReader(w.Body.String())).ReadAll()
		if err != nil || len(records) != 1 || len(records[0]) < 10 || records[0][0] != "Student" {
			t.Fatal("empty report omitted its CSV header", kind, records, err)
		}
		if w.Header().Get("Cache-Control") != "no-store" || !strings.Contains(w.Header().Get("Content-Type"), "text/csv") {
			t.Fatal("empty CSV header contract", w.Header())
		}
	}
	var audits int
	if err := f.s.Pool.QueryRow(context.Background(), `SELECT count(*) FROM admin_audit WHERE actor_id='admin' AND resource='0 sessions / 30 days'`).Scan(&audits); err != nil || audits != 2 {
		t.Fatal("empty snapshot audit", audits, err)
	}
}
