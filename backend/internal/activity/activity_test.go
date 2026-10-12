package activity

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"courseforge/backend/internal/api"
	"courseforge/backend/internal/identity"
	"courseforge/backend/internal/planning"
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
	for _, user := range []string{"alice", "bob", "outsider", "admin", "unverified"} {
		role := "student"
		if user == "admin" {
			role = "admin"
		}
		if _, err := pool.Exec(ctx, `INSERT INTO users(id,email,name,password_hash,role,verified)VALUES($1,$1||'@example.test',$1,'disabled',$2,$3);`, user, role, user != "unverified"); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO auth_sessions(id,user_id,token_hash,csrf_token,expires_at)VALUES($1,$2,$3,'csrf',now()+interval '12 hours')`, user+"auth", user, identity.Digest(user+"token")); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(ctx, `INSERT INTO auth_sessions(id,user_id,token_hash,csrf_token,expires_at)VALUES('aliceotherauth','alice',$1,'csrf',now()+interval '12 hours')`, identity.Digest("aliceothertoken")); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO courses(id,title,published)VALUES('course','Synthetic course',true),('other','Other course',true),('hidden','Hidden course',false),('empty','Empty course',true);
 INSERT INTO lessons(id,course_id,title,duration_seconds,status,sort_order)VALUES('lesson1','course','First',600,'done',1),('lesson2','course','Second',600,'queued',2),('otherlesson','other','Other',600,'done',1),('hiddenlesson','hidden','Hidden',600,'done',1);
 INSERT INTO enrollments(user_id,course_id,created_at)VALUES('alice','course',now()-interval '1 day'),('alice','hidden',now()),('alice','empty',now()),('bob','course',now());`); err != nil {
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
	player := playback.New(pool, auth)
	player.Now = now
	player.Register(mux)
	plan := planning.New(pool)
	plan.Now = now
	plan.Register(mux, auth)
	return fixture{s, mux, clock}
}
func (f fixture) now() time.Time      { return time.Unix(0, f.clock.Load()).UTC() }
func (f fixture) advance(seconds int) { f.clock.Add(int64(time.Duration(seconds) * time.Second)) }
func (f fixture) raw(user, method, path, body, csrf, origin string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "http://test"+path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", origin)
	r.Header.Set("X-CSRF-Token", csrf)
	if user != "" {
		r.AddCookie(&http.Cookie{Name: identity.CookieName, Value: user + "token"})
	}
	r.Header.Set("User-Agent", "synthetic browser")
	r.Header.Set("Idempotency-Key", "synthetic-"+path)
	w := httptest.NewRecorder()
	f.mux.ServeHTTP(w, r)
	return w
}
func (f fixture) call(user, method, path string, body any) *httptest.ResponseRecorder {
	raw, _ := json.Marshal(body)
	return f.raw(user, method, path, string(raw), "csrf", "http://test")
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
func (f fixture) open(t *testing.T, user, lesson string, body any) Ack {
	t.Helper()
	w := f.call(user, "POST", "/api/v1/lessons/"+lesson+"/activity-session", body)
	expect(t, w, 201)
	return read[Ack](t, w)
}
func (f fixture) pulse(t *testing.T, user, id string, sequence int64, visible bool, elapsed float64, ended bool) Ack {
	t.Helper()
	w := f.call(user, "POST", "/api/v1/activity/"+id+"/heartbeat", map[string]any{"sequence": sequence, "visible": visible, "elapsed_seconds": elapsed, "ended": ended})
	expect(t, w, 200)
	return read[Ack](t, w)
}
func (f fixture) summary(t *testing.T, user, query string) Summary {
	t.Helper()
	w := f.call(user, "GET", "/api/v1/me/learning"+query, nil)
	expect(t, w, 200)
	return read[Summary](t, w)
}
func (f fixture) player(t *testing.T, user, lesson string, takeover bool) string {
	t.Helper()
	w := f.call(user, "POST", "/api/v1/playback/sessions", map[string]any{"lesson_id": lesson, "take_over": takeover})
	expect(t, w, 201)
	return read[struct{ ID string }](t, w).ID
}
func (f fixture) exec(t *testing.T, sql string, args ...any) {
	t.Helper()
	if _, err := f.s.Pool.Exec(context.Background(), sql, args...); err != nil {
		t.Fatal(err)
	}
}

func TestHeartbeatAccountingDeduplicationAndServerBounds(t *testing.T) {
	f := setup(t)
	a := f.open(t, "alice", "lesson1", map[string]any{})
	if !a.Owner || a.ActivitySeconds != 0 || a.Sequence != 0 || a.Basis != basis {
		t.Fatal("invalid open acknowledgement", a)
	}
	f.advance(10)
	v := f.pulse(t, "alice", a.ID, 1, true, 20, false)
	if v.ActivitySeconds != 10 || !v.Accepted || !v.Owner {
		t.Fatal("client elapsed exceeded server time", v)
	}
	var expires time.Time
	if err := f.s.Pool.QueryRow(context.Background(), `SELECT expires_at FROM activity_leases WHERE user_id='alice'`).Scan(&expires); err != nil {
		t.Fatal(err)
	}
	f.advance(5)
	v = f.pulse(t, "alice", a.ID, 1, false, 20, true)
	if v.Accepted || v.ActivitySeconds != 10 || v.Closed || v.Reason != "duplicate" {
		t.Fatal("duplicate changed acknowledgement", v)
	}
	var unchanged time.Time
	if err := f.s.Pool.QueryRow(context.Background(), `SELECT expires_at FROM activity_leases WHERE user_id='alice'`).Scan(&unchanged); err != nil || !unchanged.Equal(expires) {
		t.Fatal("duplicate renewed lease", err)
	}
	v = f.pulse(t, "alice", a.ID, 3, true, 3, false)
	if v.ActivitySeconds != 13 || v.Sequence != 3 {
		t.Fatal("bounded skipped sequence", v)
	}
	v = f.pulse(t, "alice", a.ID, 2, true, 20, false)
	if v.Accepted || v.ActivitySeconds != 13 || v.Sequence != 3 || v.Reason != "out_of_order" {
		t.Fatal("late sequence credited", v)
	}
	f.advance(5)
	v = f.pulse(t, "alice", a.ID, 4, true, 5, true)
	if !v.Closed || v.Owner || v.ActivitySeconds != 18 {
		t.Fatal("final visible credit", v)
	}
	f.advance(5)
	v = f.pulse(t, "alice", a.ID, 5, true, 5, false)
	if v.Accepted || !v.Closed || v.ActivitySeconds != 18 {
		t.Fatal("closed session revived", v)
	}
	summary := f.summary(t, "alice", "")
	if summary.ActivitySeconds != 18 || summary.WatchedSeconds != 0 || summary.MeasuredFocusSeconds != 0 {
		t.Fatal("page credit crossed time domains", summary)
	}
}

func TestWaitingHiddenExpiryAndLongGapRequireFreshBaseline(t *testing.T) {
	f := setup(t)
	a := f.open(t, "alice", "lesson1", map[string]any{})
	b := f.open(t, "alice", "lesson2", map[string]any{})
	if b.Owner {
		t.Fatal("opening another tab displaced owner")
	}
	f.advance(10)
	v := f.pulse(t, "alice", b.ID, 1, true, 10, false)
	if v.Owner || v.ActivitySeconds != 0 || v.Reason != "standby" {
		t.Fatal("waiting tab overlap", v)
	}
	v = f.pulse(t, "alice", a.ID, 1, true, 10, false)
	if v.ActivitySeconds != 10 {
		t.Fatal(v)
	}
	f.advance(21)
	v = f.pulse(t, "alice", b.ID, 2, true, 20, false)
	if !v.Owner || v.ActivitySeconds != 0 || v.Reason != "baseline" {
		t.Fatal("lease recovery credited missing interval", v)
	}
	f.advance(5)
	v = f.pulse(t, "alice", b.ID, 3, true, 5, false)
	if v.ActivitySeconds != 5 {
		t.Fatal(v)
	}
	v = f.pulse(t, "alice", b.ID, 4, false, 0, false)
	if v.Owner {
		t.Fatal("hidden did not release", v)
	}
	f.advance(10)
	v = f.pulse(t, "alice", b.ID, 5, true, 10, false)
	if !v.Owner || v.ActivitySeconds != 5 {
		t.Fatal("hidden interval credited", v)
	}
	f.advance(5)
	v = f.pulse(t, "alice", b.ID, 6, true, 5, false)
	if v.ActivitySeconds != 10 {
		t.Fatal(v)
	}
	f.advance(31)
	v = f.pulse(t, "alice", b.ID, 7, true, 20, false)
	if v.ActivitySeconds != 10 {
		t.Fatal("long gap credited", v)
	}
	f.advance(5)
	v = f.pulse(t, "alice", b.ID, 8, true, 5, false)
	if v.ActivitySeconds != 15 {
		t.Fatal("long gap recovery failed", v)
	}
	if summary := f.summary(t, "alice", ""); summary.ActivitySeconds != 25 {
		t.Fatal("double-credit aggregate", summary)
	}
}

func TestClockRegressionCannotMoveBaselineBackward(t *testing.T) {
	f := setup(t)
	a := f.open(t, "alice", "lesson1", map[string]any{})
	opened := f.now()
	f.advance(-5)
	v := f.pulse(t, "alice", a.ID, 1, true, 20, false)
	if v.ActivitySeconds != 0 || v.Reason != "clock_regression" {
		t.Fatal(v)
	}
	var at time.Time
	if err := f.s.Pool.QueryRow(context.Background(), `SELECT last_heartbeat FROM activity_sessions WHERE id=$1`, a.ID).Scan(&at); err != nil || !at.Equal(opened) {
		t.Fatal("baseline moved backward", at, opened, err)
	}
	f.advance(10)
	v = f.pulse(t, "alice", a.ID, 2, true, 20, false)
	if v.ActivitySeconds != 5 {
		t.Fatal("regression added time", v)
	}
}

func TestActivitySecurityValidationAndNoDeniedMutations(t *testing.T) {
	f := setup(t)
	a := f.open(t, "alice", "lesson1", map[string]any{})
	for _, v := range []struct {
		user, path, body, csrf, origin string
		status                         int
	}{
		{"", "/api/v1/lessons/lesson1/activity-session", "{}", "csrf", "http://test", 401},
		{"unverified", "/api/v1/lessons/lesson1/activity-session", "{}", "csrf", "http://test", 403},
		{"alice", "/api/v1/lessons/lesson1/activity-session", "{}", "", "http://test", 403},
		{"alice", "/api/v1/lessons/lesson1/activity-session", "{}", "csrf", "https://hostile.example", 403},
		{"outsider", "/api/v1/lessons/lesson1/activity-session", "{}", "csrf", "http://test", 404},
		{"alice", "/api/v1/lessons/hiddenlesson/activity-session", "{}", "csrf", "http://test", 404},
		{"alice", "/api/v1/lessons/missing/activity-session", "{}", "csrf", "http://test", 404},
		{"alice", "/api/v1/lessons/lesson1/activity-session", "null", "csrf", "http://test", 422},
		{"alice", "/api/v1/lessons/lesson1/activity-session", `{"now":10}`, "csrf", "http://test", 400},
		{"alice", "/api/v1/lessons/lesson1/activity-session", `{"player_session_id":""}`, "csrf", "http://test", 422},
		{"bob", "/api/v1/activity/" + a.ID + "/heartbeat", `{"sequence":1,"visible":true,"elapsed_seconds":10}`, "csrf", "http://test", 404},
		{"aliceother", "/api/v1/activity/" + a.ID + "/heartbeat", `{"sequence":1,"visible":true,"elapsed_seconds":10}`, "csrf", "http://test", 404},
	} {
		expect(t, f.raw(v.user, "POST", v.path, v.body, v.csrf, v.origin), v.status)
	}
	for _, body := range []string{`{}`, `null`, `{"sequence":0,"visible":true,"elapsed_seconds":1}`, `{"sequence":1000000001,"visible":true,"elapsed_seconds":1}`, `{"sequence":1,"visible":true,"elapsed_seconds":21}`, `{"sequence":1,"visible":true,"elapsed_seconds":-1}`, `{"sequence":1,"visible":null,"elapsed_seconds":1}`, `{"sequence":1,"visible":true,"elapsed_seconds":null}`} {
		expect(t, f.raw("alice", "POST", "/api/v1/activity/"+a.ID+"/heartbeat", body, "csrf", "http://test"), 422)
	}
	for _, body := range []string{`{"sequence":1,"visible":true,"elapsed_seconds":1,"time":1}`, `{} {}`, `{"sequence":1,"visible":true,"elapsed_seconds":NaN}`, `{"sequence":1,"visible":true,"elapsed_seconds":1e999}`, `{"player_session_id":"` + strings.Repeat("x", 17000) + `"}`} {
		expect(t, f.raw("alice", "POST", "/api/v1/activity/"+a.ID+"/heartbeat", body, "csrf", "http://test"), 400)
	}
	var count int
	var sequence int64
	if err := f.s.Pool.QueryRow(context.Background(), `SELECT count(*) FROM activity_sessions`).Scan(&count); err != nil || count != 1 {
		t.Fatal("denied open persisted", count, err)
	}
	if err := f.s.Pool.QueryRow(context.Background(), `SELECT last_sequence FROM activity_sessions WHERE id=$1`, a.ID).Scan(&sequence); err != nil || sequence != 0 {
		t.Fatal("denied pulse persisted", sequence, err)
	}
	if result := f.summary(t, "alice", ""); result.ActivitySeconds != 0 {
		t.Fatal("invalid time credited", result)
	}
}

func TestCurrentScopeRevalidatedEvenForDuplicateAndClosedActivity(t *testing.T) {
	for _, revoke := range []string{"enrollment", "publication", "auth", "suspended"} {
		t.Run(revoke, func(t *testing.T) {
			f := setup(t)
			a := f.open(t, "alice", "lesson1", map[string]any{})
			f.advance(5)
			f.pulse(t, "alice", a.ID, 1, true, 5, true)
			status := 404
			switch revoke {
			case "enrollment":
				f.exec(t, `DELETE FROM enrollments WHERE user_id='alice' AND course_id='course'`)
			case "publication":
				f.exec(t, `UPDATE courses SET published=false WHERE id='course'`)
			case "auth":
				f.exec(t, `UPDATE auth_sessions SET revoked_at=now() WHERE id='aliceauth'`)
				status = 401
			case "suspended":
				f.exec(t, `UPDATE users SET suspended=true WHERE id='alice'`)
				status = 401
			}
			expect(t, f.call("alice", "POST", "/api/v1/activity/"+a.ID+"/heartbeat", map[string]any{"sequence": 1, "visible": true, "elapsed_seconds": 5}), status)
		})
	}
}

func TestBoundPlayerScopeReleaseReclaimAndTakeover(t *testing.T) {
	f := setup(t)
	p := f.player(t, "alice", "lesson1", false)
	a := f.open(t, "alice", "lesson1", map[string]any{"player_session_id": p})
	for _, v := range []struct {
		user, lesson, player string
		status               int
	}{{"bob", "lesson1", p, 404}, {"aliceother", "lesson1", p, 404}, {"alice", "lesson2", p, 404}, {"alice", "lesson1", "missing", 404}} {
		expect(t, f.call(v.user, "POST", "/api/v1/lessons/"+v.lesson+"/activity-session", map[string]any{"player_session_id": v.player}), v.status)
	}
	f.advance(5)
	v := f.pulse(t, "alice", a.ID, 1, true, 5, false)
	if v.ActivitySeconds != 5 {
		t.Fatal(v)
	}
	expect(t, f.call("alice", "POST", "/api/v1/playback/sessions/"+p+"/release", map[string]any{}), 200)
	f.advance(5)
	v = f.pulse(t, "alice", a.ID, 2, true, 5, false)
	if v.ActivitySeconds != 5 || v.Owner || v.Reason != "player_not_owner" {
		t.Fatal("release credited bound activity", v)
	}
	expect(t, f.call("alice", "POST", "/api/v1/lessons/lesson1/activity-session", map[string]any{"player_session_id": p}), 409)
	expect(t, f.call("alice", "POST", "/api/v1/playback/sessions/"+p+"/claim", map[string]bool{"take_over": false}), 200)
	f.advance(5)
	v = f.pulse(t, "alice", a.ID, 3, true, 5, false)
	if v.ActivitySeconds != 5 || !v.Owner {
		t.Fatal("reclaim lacked fresh baseline", v)
	}
	f.advance(5)
	v = f.pulse(t, "alice", a.ID, 4, true, 5, false)
	if v.ActivitySeconds != 10 {
		t.Fatal(v)
	}
	f.player(t, "alice", "lesson2", true)
	v = f.pulse(t, "alice", a.ID, 5, true, 5, false)
	if !v.Closed || v.Accepted || v.Owner || v.ActivitySeconds != 10 {
		t.Fatal("takeover did not close bound activity", v)
	}
	b := f.open(t, "alice", "lesson2", map[string]any{})
	if !b.Owner {
		t.Fatal("displacement lease blocked new activity", b)
	}
}

func TestBoundPlayerDeletionClosesAndReleasesActivity(t *testing.T) {
	f := setup(t)
	p := f.player(t, "alice", "lesson1", false)
	a := f.open(t, "alice", "lesson1", map[string]any{"player_session_id": p})
	f.advance(5)
	f.pulse(t, "alice", a.ID, 1, true, 5, false)
	f.exec(t, `DELETE FROM playback_sessions WHERE id=$1`, p)
	var bound, closed bool
	var player *string
	if err := f.s.Pool.QueryRow(context.Background(), `SELECT player_bound,closed,player_session_id FROM activity_sessions WHERE id=$1`, a.ID).Scan(&bound, &closed, &player); err != nil || !bound || !closed || player != nil {
		t.Fatal("deleted player binding lost provenance", bound, closed, player, err)
	}
	v := f.pulse(t, "alice", a.ID, 2, true, 5, false)
	if !v.Closed || v.Accepted || v.Owner || v.ActivitySeconds != 5 {
		t.Fatal("deleted player turned into unbound session", v)
	}
	b := f.open(t, "alice", "lesson2", map[string]any{})
	if !b.Owner {
		t.Fatal("deleted player left activity lease", b)
	}
}

func TestParallelDuplicatePulsesAndActivityOpens(t *testing.T) {
	f := setup(t)
	other := f.replica(t)
	a := f.open(t, "alice", "lesson1", map[string]any{})
	f.advance(10)
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
			responses <- caller.call("alice", "POST", "/api/v1/activity/"+a.ID+"/heartbeat", map[string]any{"sequence": 1, "visible": true, "elapsed_seconds": 10})
		}()
	}
	wg.Wait()
	close(responses)
	accepted := 0
	for w := range responses {
		expect(t, w, 200)
		v := read[Ack](t, w)
		if v.Accepted {
			accepted++
		}
		if v.ActivitySeconds != 10 {
			t.Fatal("concurrent duplicate changed time", v)
		}
	}
	if accepted != 1 {
		t.Fatal("accepted duplicates", accepted)
	}
	responses = make(chan *httptest.ResponseRecorder, 16)
	for i := 0; i < 16; i++ {
		caller := f
		if i%2 == 1 {
			caller = other
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			responses <- caller.call("bob", "POST", "/api/v1/lessons/lesson1/activity-session", map[string]any{})
		}()
	}
	wg.Wait()
	close(responses)
	owners := 0
	ids := map[string]bool{}
	for w := range responses {
		expect(t, w, 201)
		v := read[Ack](t, w)
		if v.Owner {
			owners++
		}
		if ids[v.ID] {
			t.Fatal("duplicate fresh open")
		}
		ids[v.ID] = true
	}
	if owners != 1 {
		t.Fatal("parallel opens owners", owners)
	}
	if v := f.summary(t, "alice", ""); v.ActivitySeconds != 10 {
		t.Fatal("concurrent duplicate aggregate", v)
	}
}

func TestActivityAdmissionAcrossReplicasAndWindowRecovery(t *testing.T) {
	f := setup(t)
	other := f.replica(t)
	for i := 0; i < 90; i++ {
		caller := f
		if i%2 == 1 {
			caller = other
		}
		caller.open(t, "alice", "lesson1", map[string]any{})
	}
	w := other.call("alice", "POST", "/api/v1/lessons/lesson1/activity-session", map[string]any{})
	expect(t, w, 429)
	if w.Header().Get("Retry-After") != "60" {
		t.Fatal("retry admission", w.Header())
	}
	var count int
	if err := f.s.Pool.QueryRow(context.Background(), `SELECT count(*) FROM activity_sessions WHERE user_id='alice'`).Scan(&count); err != nil || count != 90 {
		t.Fatal("limited open persisted", count, err)
	}
	f.open(t, "bob", "lesson1", map[string]any{})
	f.advance(60)
	if v := f.open(t, "alice", "lesson2", map[string]any{}); !v.Owner {
		t.Fatal("new window did not recover", v)
	}
}

func TestExpiryRetentionAndSessionDeletionPreserveLifetimeVisits(t *testing.T) {
	f := setup(t)
	a := f.open(t, "alice", "lesson1", map[string]any{})
	f.advance(10)
	f.pulse(t, "alice", a.ID, 1, true, 10, false)
	f.exec(t, `UPDATE activity_sessions SET expires_at=$2 WHERE id=$1`, a.ID, f.now().Add(time.Second))
	f.advance(2)
	v := f.pulse(t, "alice", a.ID, 2, true, 2, false)
	if !v.Closed || v.Accepted || v.Owner || v.ActivitySeconds != 10 || v.Reason != "expired" {
		t.Fatal("expired activity reclaimed", v)
	}
	b := f.open(t, "alice", "lesson2", map[string]any{})
	if !b.Owner {
		t.Fatal("expired activity lease retained", b)
	}
	f.exec(t, `UPDATE activity_sessions SET created_at=created_at-interval '91 days'`)
	n, err := f.s.Cleanup(context.Background(), f.now().Add(-90*24*time.Hour), 1)
	if err != nil || n != 1 {
		t.Fatal("bounded cleanup", n, err)
	}
	n, err = f.s.Cleanup(context.Background(), f.now().Add(-90*24*time.Hour), 10)
	if err != nil || n != 1 {
		t.Fatal("cleanup next page", n, err)
	}
	if _, err = f.s.Cleanup(context.Background(), f.now(), 1001); err == nil {
		t.Fatal("unbounded cleanup accepted")
	}
	result := f.summary(t, "alice", "")
	if result.ActivitySeconds != 10 || len(result.Courses) != 1 || result.Courses[0].LastLessonID == nil || *result.Courses[0].LastLessonID != "lesson2" {
		t.Fatal("retention lost lifetime or visit", result)
	}
	c := f.open(t, "alice", "lesson1", map[string]any{})
	f.exec(t, `DELETE FROM auth_sessions WHERE id='aliceauth'`)
	var count int
	if err = f.s.Pool.QueryRow(context.Background(), `SELECT count(*) FROM activity_sessions WHERE id=$1`, c.ID).Scan(&count); err != nil || count != 1 {
		t.Fatal("auth cleanup deleted activity reports", count, err)
	}
	expect(t, f.call("alice", "POST", "/api/v1/activity/"+c.ID+"/heartbeat", map[string]any{"sequence": 1, "visible": true, "elapsed_seconds": 1}), 401)
	f.exec(t, `DELETE FROM users WHERE id='alice'`)
	for _, table := range []string{"activity_sessions", "activity_leases", "lesson_activity_totals", "lesson_visits", "activity_open_limits"} {
		if err = f.s.Pool.QueryRow(context.Background(), fmt.Sprintf("SELECT count(*) FROM %s WHERE user_id='alice'", table)).Scan(&count); err != nil || count != 0 {
			t.Fatal("account cleanup retained private activity", table, count, err)
		}
	}
}

func TestSummaryPaginationPrivateHistoricalTotalsAndLastVisits(t *testing.T) {
	f := setup(t)
	f.exec(t, `INSERT INTO enrollments(user_id,course_id,created_at)VALUES('alice','other',now()-interval '2 days'),('admin','course',now());
 INSERT INTO lesson_activity_totals(user_id,lesson_id,activity_seconds,updated_at)VALUES('alice','lesson1',10,now()),('alice','lesson2',5,now()),('alice','otherlesson',7,now()),('alice','hiddenlesson',13,now()),('bob','lesson1',1000,now());
 INSERT INTO playback_totals(user_id,lesson_id,watched_seconds)VALUES('alice','lesson1',20),('alice','otherlesson',30),('alice','hiddenlesson',50),('bob','lesson1',999);
 INSERT INTO progress(user_id,lesson_id,completed,position,percent)VALUES('alice','lesson2',true,10,10),('bob','lesson1',true,600,100);`)
	f.exec(t, `INSERT INTO focus_sessions(id,user_id,mode,status,duration_seconds,elapsed_seconds,run_started_at,title)VALUES('focus','alice','focus','running',60,10,$1,'Focus'),('break','alice','break','finished',60,60,NULL,'Break'),('cancel','alice','focus','cancelled',60,50,NULL,'Cancelled'),('otherfocus','bob','focus','finished',60,60,NULL,'Other learner');`, f.now().Add(-100*time.Second))
	f.open(t, "alice", "lesson1", map[string]any{})
	f.advance(1)
	f.open(t, "alice", "otherlesson", map[string]any{})
	result := f.summary(t, "alice", "?limit=1")
	if len(result.Courses) != 1 || result.Courses[0].CourseID != "other" || result.ActivitySeconds != 35 || result.WatchedSeconds != 100 || result.MeasuredFocusSeconds != 60 || result.NextCursor == "" {
		t.Fatal("first summary page", result)
	}
	next := f.summary(t, "alice", "?limit=1&cursor="+result.NextCursor)
	if len(next.Courses) != 1 || next.Courses[0].CourseID != "course" || next.NextCursor != "" || next.ActivitySeconds != 35 || next.Courses[0].Lessons != 2 || next.Courses[0].Completed != 1 || next.Courses[0].ActivitySeconds != 15 || next.Courses[0].WatchedSeconds != 20 || next.Courses[0].LastLessonID == nil || *next.Courses[0].LastLessonID != "lesson1" {
		t.Fatal("second summary page", next)
	}
	// Progress updates and native history must not replace explicit page visits.
	expect(t, f.call("alice", "PUT", "/api/v1/lessons/lesson2/resume-point", map[string]any{"position": 15}), 200)
	result = f.summary(t, "alice", "")
	if *result.Courses[1].LastLessonID != "lesson1" {
		t.Fatal("progress replaced last visit", result)
	}
	f.exec(t, `DELETE FROM enrollments WHERE user_id='alice' AND course_id='other'`)
	result = f.summary(t, "alice", "")
	if len(result.Courses) != 1 || result.ActivitySeconds != 35 || result.WatchedSeconds != 100 {
		t.Fatal("historical totals or inaccessible content changed", result)
	}
	body := f.call("alice", "GET", "/api/v1/me/learning", nil).Body.Bytes()
	for _, forbidden := range []string{"otherlesson", "Hidden course", "auth_session", "alice@example", "bob", "token", "visible_seconds"} {
		if bytes.Contains(body, []byte(forbidden)) {
			t.Fatal("summary leaked internal/private content", forbidden)
		}
	}
	admin := f.summary(t, "admin", "")
	if len(admin.Courses) != 1 || admin.Courses[0].CourseID != "course" {
		t.Fatal("admin summary included unenrolled courses", admin)
	}
	for _, q := range []string{"?limit=0", "?limit=101", "?limit=no", "?cursor=bad", "?cursor=" + strings.Repeat("a", 1001)} {
		expect(t, f.call("alice", "GET", "/api/v1/me/learning"+q, nil), 400)
	}
	// Removing a last lesson preserves the course visit timestamp and clears its ID.
	f.exec(t, `DELETE FROM lessons WHERE id='lesson1'`)
	result = f.summary(t, "alice", "")
	if result.Courses[0].LastLessonID != nil || result.Courses[0].LastOpened == nil {
		t.Fatal("lesson deletion destroyed visit timestamp", result)
	}
}

func TestNativeVisibleDiagnosticsNeverAddPageTime(t *testing.T) {
	f := setup(t)
	p := f.player(t, "alice", "lesson1", false)
	a := f.open(t, "alice", "lesson1", map[string]any{"player_session_id": p})
	pulse := func(seq int64, position, elapsed float64, kind string, visible bool) {
		t.Helper()
		expect(t, f.call("alice", "POST", "/api/v1/playback/sessions/"+p+"/pulse", map[string]any{"sequence": seq, "position": position, "elapsed_seconds": elapsed, "kind": kind, "playing": kind == "playing", "visible": visible, "playback_rate": 1}), 200)
	}
	pulse(1, 0, 0, "playing", true)
	f.advance(10)
	pulse(2, 10, 10, "playing", true)
	v := f.pulse(t, "alice", a.ID, 1, true, 10, false)
	if v.ActivitySeconds != 10 {
		t.Fatal(v)
	}
	summary := f.summary(t, "alice", "")
	if summary.ActivitySeconds != 10 || summary.WatchedSeconds != 10 {
		t.Fatal("native/page double credit", summary)
	}
	var diagnostics float64
	if err := f.s.Pool.QueryRow(context.Background(), `SELECT visible_seconds FROM playback_sessions WHERE id=$1`, p).Scan(&diagnostics); err != nil || diagnostics != 10 {
		t.Fatal("fixture diagnostic credit", diagnostics, err)
	}
	f.advance(5)
	pulse(3, 15, 5, "hidden", false)
	v = f.pulse(t, "alice", a.ID, 2, true, 5, false)
	if v.Owner || v.ActivitySeconds != 10 {
		t.Fatal("hidden pulse did not clear activity baseline", v)
	}
	expect(t, f.call("alice", "POST", "/api/v1/playback/sessions/"+p+"/claim", map[string]any{"take_over": false}), 200)
	v = f.pulse(t, "alice", a.ID, 3, true, 5, false)
	if v.ActivitySeconds != 10 {
		t.Fatal("native reclaim credited hidden interval", v)
	}
	f.advance(5)
	pulse(4, 15, 0, "close", true)
	v = f.pulse(t, "alice", a.ID, 4, true, 5, false)
	if !v.Closed || v.Accepted || v.ActivitySeconds != 10 {
		t.Fatal("native close did not terminate activity", v)
	}
}

func TestConcurrentNativeTakeoverAndPulseCannotCreditAfterDisplacement(t *testing.T) {
	f := setup(t)
	p := f.player(t, "alice", "lesson1", false)
	a := f.open(t, "alice", "lesson1", map[string]any{"player_session_id": p})
	f.advance(10)
	start := make(chan struct{})
	responses := make(chan *httptest.ResponseRecorder, 12)
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			responses <- f.call("alice", "POST", "/api/v1/activity/"+a.ID+"/heartbeat", map[string]any{"sequence": 1, "visible": true, "elapsed_seconds": 10})
		}()
	}
	wg.Add(1)
	takeover := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		defer wg.Done()
		<-start
		takeover <- f.call("alice", "POST", "/api/v1/playback/sessions", map[string]any{"lesson_id": "lesson2", "take_over": true})
	}()
	close(start)
	wg.Wait()
	close(responses)
	expect(t, <-takeover, 201)
	accepted := 0
	for w := range responses {
		expect(t, w, 200)
		v := read[Ack](t, w)
		if v.Accepted {
			accepted++
		}
		if v.ActivitySeconds != 0 && v.ActivitySeconds != 10 {
			t.Fatal("partial or duplicate takeover credit", v)
		}
	}
	if accepted > 1 {
		t.Fatal("multiple duplicate pulses credited", accepted)
	}
	v := f.pulse(t, "alice", a.ID, 2, true, 10, false)
	if !v.Closed || v.Accepted || v.Owner {
		t.Fatal("displaced session resumed", v)
	}
	summary := f.summary(t, "alice", "")
	if summary.ActivitySeconds != float64(accepted*10) {
		t.Fatal("takeover lost or duplicated committed credit", accepted, summary)
	}
	b := f.open(t, "alice", "lesson2", map[string]any{})
	if !b.Owner {
		t.Fatal("takeover retained old activity lease", b)
	}
}

func TestOldPlayerLifecycleCannotClearAnotherPageLease(t *testing.T) {
	f := setup(t)
	p := f.player(t, "alice", "lesson1", false)
	a := f.open(t, "alice", "lesson1", map[string]any{"player_session_id": p})
	expect(t, f.call("alice", "POST", "/api/v1/playback/sessions/"+p+"/release", map[string]any{}), 200)
	b := f.open(t, "alice", "lesson2", map[string]any{})
	if !b.Owner {
		t.Fatal("fixture lease", b)
	}
	f.exec(t, `DELETE FROM playback_sessions WHERE id=$1`, p)
	f.advance(5)
	v := f.pulse(t, "alice", b.ID, 1, true, 5, false)
	if !v.Owner || v.ActivitySeconds != 5 {
		t.Fatal("old player cleared another page's lease", v)
	}
	v = f.pulse(t, "alice", a.ID, 1, true, 5, false)
	if !v.Closed || v.Accepted || v.Owner {
		t.Fatal("old bound activity revived", v)
	}
}

func TestBoundActivityReportsSurviveLoginCleanupWithoutRevivingBinding(t *testing.T) {
	f := setup(t)
	p := f.player(t, "alice", "lesson1", false)
	a := f.open(t, "alice", "lesson1", map[string]any{"player_session_id": p})
	f.advance(5)
	f.pulse(t, "alice", a.ID, 1, true, 5, false)
	f.exec(t, `DELETE FROM auth_sessions WHERE id='aliceauth'`)
	var player *string
	var closed, bound bool
	if err := f.s.Pool.QueryRow(context.Background(), `SELECT player_session_id,closed,player_bound FROM activity_sessions WHERE id=$1`, a.ID).Scan(&player, &closed, &bound); err != nil || player != nil || !closed || !bound {
		t.Fatal("login cleanup lost retained binding provenance", player, closed, bound, err)
	}
	expect(t, f.call("aliceother", "POST", "/api/v1/activity/"+a.ID+"/heartbeat", map[string]any{"sequence": 2, "visible": true, "elapsed_seconds": 5}), 404)
	result := f.summary(t, "aliceother", "")
	if result.ActivitySeconds != 5 {
		t.Fatal("login cleanup reduced lifetime total", result)
	}
	b := f.open(t, "aliceother", "lesson2", map[string]any{})
	if !b.Owner {
		t.Fatal("login cleanup retained activity lease", b)
	}
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

func TestSummaryCursorOrdersUnvisitedTiesWithoutSkippingCourses(t *testing.T) {
	f := setup(t)
	f.exec(t, `INSERT INTO courses(id,title,published)VALUES('a-course','A',true),('z-course','Z',true);
 INSERT INTO lessons(id,course_id,title)VALUES('a-lesson','a-course','A lesson'),('z-lesson','z-course','Z lesson');
 INSERT INTO enrollments(user_id,course_id,created_at)VALUES('alice','a-course','2026-01-01T00:00:00Z'),('alice','z-course','2026-01-01T00:00:00Z');`)
	f.open(t, "alice", "lesson1", map[string]any{})
	first := f.summary(t, "alice", "?limit=1")
	if len(first.Courses) != 1 || first.Courses[0].CourseID != "course" || first.NextCursor == "" {
		t.Fatal("visited course order", first)
	}
	second := f.summary(t, "alice", "?limit=1&cursor="+first.NextCursor)
	if len(second.Courses) != 1 || second.Courses[0].CourseID != "z-course" || second.Courses[0].LastOpened != nil || second.NextCursor == "" {
		t.Fatal("unvisited tie order", second)
	}
	third := f.summary(t, "alice", "?limit=1&cursor="+second.NextCursor)
	if len(third.Courses) != 1 || third.Courses[0].CourseID != "a-course" || third.NextCursor != "" {
		t.Fatal("unvisited cursor omitted course", third)
	}
}
