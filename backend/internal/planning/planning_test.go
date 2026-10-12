package planning

import (
	"bytes"
	"context"
	"courseforge/backend/internal/api"
	"courseforge/backend/internal/identity"
	"courseforge/backend/internal/learning"
	"courseforge/backend/internal/playback"
	"courseforge/backend/internal/testutil"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type fixture struct {
	service *Service
	player  *playback.Service
	mux     *http.ServeMux
	clock   *atomic.Int64
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
	if _, err := pool.Exec(ctx, `INSERT INTO courses(id,title,published)VALUES('course','Synthetic course',true),('other','Other',true),('hidden','Unpublished',false);
 INSERT INTO lessons(id,course_id,title,duration_seconds,status,sort_order)VALUES('lesson1','course','First source',600,'done',1),('lesson2','course','Second source',600,'done',2),('lesson3','course','Third source',600,'done',3),('otherlesson','other','Private other source',600,'done',1),('hiddenlesson','hidden','Unpublished source',600,'done',1);
 INSERT INTO enrollments(user_id,course_id)VALUES('alice','course'),('bob','course'),('alice','hidden');`); err != nil {
		t.Fatal(err)
	}
	auth, err := identity.New(pool, identity.Config{PublicOrigin: "http://test", PasswordConcurrency: 1})
	if err != nil {
		t.Fatal(err)
	}
	clock := &atomic.Int64{}
	clock.Store(time.Date(2026, 10, 12, 12, 0, 0, 0, time.UTC).UnixNano())
	now := func() time.Time { return time.Unix(0, clock.Load()).UTC() }
	s := New(pool)
	s.Now = now
	player := playback.New(pool, auth)
	player.Now = now
	mux := api.New(pool, auth).Mux
	s.Register(mux, auth)
	player.Register(mux)
	learning.New(pool, nil).Register(mux, auth)
	return fixture{s, player, mux, clock}
}
func (f fixture) at(at time.Time)     { f.clock.Store(at.UnixNano()) }
func (f fixture) now() time.Time      { return time.Unix(0, f.clock.Load()).UTC() }
func (f fixture) advance(seconds int) { f.clock.Add(int64(time.Duration(seconds) * time.Second)) }
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
		t.Fatalf("status%d expected%d: %s", w.Code, status, w.Body.String())
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
func (f fixture) start(t *testing.T, user, key string, minutes int) Focus {
	t.Helper()
	w := f.call(user, "POST", "/api/v1/focus/sessions", key, map[string]any{"mode": "focus", "duration_minutes": minutes})
	expect(t, w, 201)
	return read[Focus](t, w)
}
func (f fixture) action(t *testing.T, user, key string, session Focus, action string) Focus {
	t.Helper()
	w := f.call(user, "POST", "/api/v1/focus/sessions/"+session.ID+"/actions", key, map[string]any{"action": action, "expected_revision": session.Revision})
	expect(t, w, 200)
	return read[Focus](t, w)
}
func (f fixture) plan(t *testing.T, date, key string) Day {
	t.Helper()
	w := f.call("alice", "POST", "/api/v1/planner/days", key, map[string]any{"study_date": date})
	expect(t, w, 201)
	return read[Day](t, w)
}

func TestPlanningSchemaAndPrivatePreferences(t *testing.T) {
	f := setup(t)
	w := f.call("alice", "GET", "/api/v1/planner/preferences", "", nil)
	expect(t, w, 200)
	pref := read[Preferences](t, w)
	if pref.DailyMinutes != 45 || pref.Revision != 0 {
		t.Fatalf("default %+v", pref)
	}
	input := map[string]any{"daily_minutes": 30, "expected_revision": 0}
	w = f.call("alice", "PUT", "/api/v1/planner/preferences", "prefs", input)
	expect(t, w, 200)
	if read[Preferences](t, w).Revision != 1 {
		t.Fatal("preference not versioned")
	}
	expect(t, f.call("alice", "PUT", "/api/v1/planner/preferences", "prefs", input), 200)
	expect(t, f.call("alice", "PUT", "/api/v1/planner/preferences", "otherkey", input), 409)
	w = f.call("bob", "GET", "/api/v1/planner/preferences", "", nil)
	expect(t, w, 200)
	if read[Preferences](t, w).DailyMinutes != 45 {
		t.Fatal("preferences crossed learners")
	}
	expect(t, f.call("alice", "PUT", "/api/v1/planner/preferences", "unverified-path", map[string]any{"daily_minutes": 30, "path_id": "arbitrary", "expected_revision": 1}), 503)
	expect(t, f.call("alice", "PUT", "/api/v1/planner/week-preferences", "invalidweek", map[string]any{"weekday_minutes": []int{0, 0, 0, 0, 0, 0, 0}, "expected_revision": 0}), 422)
	expect(t, f.call("alice", "POST", "/api/v1/planner/weeks", "notmonday", map[string]any{"week_start": "2026-10-13"}), 422)
	for _, user := range []string{"", "unverified"} {
		status := 401
		if user != "" {
			status = 403
		}
		expect(t, f.call(user, "GET", "/api/v1/focus/active", "", nil), status)
	}
}

func TestFocusPauseHiddenResumeExpiryAndSeparateHabitTime(t *testing.T) {
	f := setup(t)
	session := f.start(t, "alice", "start", 1)
	f.advance(20)
	session = f.action(t, "alice", "hidden", session, "hidden")
	if session.ElapsedSeconds != 20 || session.Status != "paused" {
		t.Fatalf("paused %+v", session)
	}
	f.advance(3600)
	w := f.call("alice", "GET", "/api/v1/focus/active", "", nil)
	expect(t, w, 200)
	active := read[struct {
		Session Focus `json:"session"`
	}](t, w).Session
	if active.ElapsedSeconds != 20 || active.Status != "paused" {
		t.Fatalf("pause counted %+v", active)
	}
	session = f.action(t, "alice", "resume", session, "resume")
	f.advance(50)
	w = f.call("alice", "GET", "/api/v1/focus/active", "", nil)
	expect(t, w, 200)
	if read[map[string]any](t, w)["session"] != nil {
		t.Fatal("expired timer remains active")
	}
	w = f.call("alice", "GET", "/api/v1/focus/history", "", nil)
	expect(t, w, 200)
	history := read[struct {
		Sessions []Focus `json:"sessions"`
	}](t, w)
	if len(history.Sessions) != 1 || history.Sessions[0].ElapsedSeconds != 60 || history.Sessions[0].Status != "finished" {
		t.Fatalf("expiry %+v", history)
	}
	var intervals int
	var seconds float64
	err := f.service.Pool.QueryRow(context.Background(), `SELECT count(*),sum(extract(epoch FROM ended_at-began_at))FROM focus_intervals WHERE session_id=$1`, session.ID).Scan(&intervals, &seconds)
	if err != nil || intervals != 2 || seconds != 60 {
		t.Fatalf("interval count%d seconds%v err%v", intervals, seconds, err)
	}
	w = f.call("alice", "GET", "/api/v1/me/habits", "", nil)
	expect(t, w, 200)
	habit := read[struct {
		Today HabitDay `json:"today"`
	}](t, w)
	if habit.Today.WatchedSeconds != 0 || habit.Today.GoalMet {
		t.Fatal("timer inflated watched habit credit")
	}
	w = f.call("bob", "GET", "/api/v1/focus/history", "", nil)
	expect(t, w, 200)
	if strings.Contains(w.Body.String(), session.ID) {
		t.Fatal("focus history crossed users")
	}
	expect(t, f.call("bob", "POST", "/api/v1/focus/sessions/"+session.ID+"/actions", "foreign", map[string]any{"action": "resume", "expected_revision": 2}), 404)
}

func TestConcurrentFocusStartAndCommandReplay(t *testing.T) {
	f := setup(t)
	var wg sync.WaitGroup
	responses := make(chan *httptest.ResponseRecorder, 8)
	for range 8 {
		wg.Go(func() {
			responses <- f.call("alice", "POST", "/api/v1/focus/sessions", "same-start", map[string]any{"duration_minutes": 1})
		})
	}
	wg.Wait()
	close(responses)
	one := ""
	for w := range responses {
		expect(t, w, 201)
		s := read[Focus](t, w)
		if one != "" && one != s.ID {
			t.Fatal("duplicate focus starts")
		}
		one = s.ID
	}
	expect(t, f.call("alice", "POST", "/api/v1/focus/sessions", "different-start", map[string]any{"duration_minutes": 1}), 409)
	var count int
	if err := f.service.Pool.QueryRow(context.Background(), `SELECT count(*)FROM focus_sessions`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("count%d err%v", count, err)
	}
	expect(t, f.call("alice", "POST", "/api/v1/focus/sessions", "invented", map[string]any{"duration_minutes": 1, "elapsed_seconds": 1000}), 400)
	expect(t, f.call("alice", "POST", "/api/v1/focus/sessions", "deniedlesson", map[string]any{"duration_minutes": 1, "lesson_id": "otherlesson"}), 404)
	expect(t, f.call("alice", "POST", "/api/v1/focus/sessions", "deniedhidden", map[string]any{"duration_minutes": 1, "lesson_id": "hiddenlesson"}), 404)
	expect(t, f.call("alice", "POST", "/api/v1/focus/sessions", "lab", map[string]any{"duration_minutes": 1, "lab_session_id": "unknown"}), 503)
}

func TestConcurrentResumeAndStaleRevisions(t *testing.T) {
	f := setup(t)
	a := f.start(t, "alice", "a", 1)
	a = f.action(t, "alice", "pause-a", a, "pause")
	b := f.start(t, "alice", "b", 1)
	b = f.action(t, "alice", "pause-b", b, "pause")
	var wg sync.WaitGroup
	responses := make(chan int, 2)
	for i, s := range []Focus{a, b} {
		wg.Go(func() {
			responses <- f.call("alice", "POST", "/api/v1/focus/sessions/"+s.ID+"/actions", fmt.Sprintf("resume%d", i), map[string]any{"action": "resume", "expected_revision": s.Revision}).Code
		})
	}
	wg.Wait()
	close(responses)
	counts := map[int]int{}
	for code := range responses {
		counts[code]++
	}
	if counts[200] != 1 || counts[409] != 1 {
		t.Fatalf("resume winners%v", counts)
	}
	expect(t, f.call("alice", "POST", "/api/v1/focus/sessions/"+a.ID+"/actions", "stale", map[string]any{"action": "finish", "expected_revision": 1}), 409)
}

func TestDailyRefreshPreservesReportsAndSourceIDs(t *testing.T) {
	f := setup(t)
	plan := f.plan(t, "2026-10-12", "plan")
	if len(plan.Items) != 2 || plan.PlannedMinutes != 20 {
		t.Fatalf("suggestions %+v", plan)
	}
	item := plan.Items[0]
	w := f.call("alice", "PUT", "/api/v1/planner/items/"+item.ID, "done", map[string]any{"status": "done", "expected_revision": item.Revision})
	expect(t, w, 200)
	plan = read[Day](t, w)
	item = plan.Items[0]
	w = f.call("alice", "PUT", "/api/v1/planner/items/"+item.ID+"/actual", "report", map[string]any{"actual_minutes": 120, "expected_revision": item.Revision})
	expect(t, w, 200)
	plan = read[Day](t, w)
	expect(t, f.call("bob", "PUT", "/api/v1/planner/items/"+item.ID, "foreign", map[string]any{"status": "done", "expected_revision": 1}), 404)
	w = f.call("alice", "PUT", "/api/v1/planner/preferences", "lower-budget", map[string]any{"daily_minutes": 15, "expected_revision": 0})
	expect(t, w, 200)
	w = f.call("alice", "POST", "/api/v1/planner/days", "refresh", map[string]any{"study_date": "2026-10-12", "refresh": true, "expected_revision": plan.Revision})
	expect(t, w, 201)
	updated := read[Day](t, w)
	if updated.ID != plan.ID || len(updated.Items) != 1 || updated.Items[0].ID != item.ID || updated.Items[0].Status != "done" || updated.ActualMinutes != 120 || updated.ReportedDoneMinutes != 10 {
		t.Fatalf("recorded work lost %+v", updated)
	}
	w = f.call("alice", "GET", "/api/v1/focus/analytics/2026-10-12", "", nil)
	expect(t, w, 200)
	values := read[map[string]any](t, w)
	if values["self_reported_minutes"] != float64(120) || values["measured_minutes"] != float64(0) {
		t.Fatalf("time metrics conflated%v", values)
	}
	var progress int
	if err := f.service.Pool.QueryRow(context.Background(), `SELECT count(*)FROM progress`).Scan(&progress); err != nil || progress != 0 {
		t.Fatal("checklist changed learning progress")
	}
}

func TestHabitTimezoneMidnightDSTAndDuplicateCredits(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	f.at(time.Date(2026, 11, 1, 9, 30, 0, 0, time.UTC))
	w := f.call("alice", "PUT", "/api/v1/me/habit-preferences", "habitprefs", map[string]any{"goal": "lesson", "timezone": "America/Los_Angeles"})
	expect(t, w, 200)
	// The same local hour occurs twice at the DST fall-back; one resource/day earns
	// one accepted action, never two achievements from changing device timezone.
	for _, at := range []time.Time{time.Date(2026, 11, 1, 8, 30, 0, 0, time.UTC), time.Date(2026, 11, 1, 9, 30, 0, 0, time.UTC)} {
		if _, err := f.service.Pool.Exec(ctx, `SELECT planning_habit_action('alice','lesson','lesson1',$1)`, at); err != nil {
			t.Fatal(err)
		}
	}
	w = f.call("alice", "GET", "/api/v1/me/habits", "", nil)
	expect(t, w, 200)
	summary := read[struct {
		Today  HabitDay `json:"today"`
		Streak int64    `json:"streak"`
	}](t, w)
	if summary.Today.Lessons != 1 || !summary.Today.GoalMet || summary.Streak != 1 {
		t.Fatalf("DST credits %+v", summary)
	}
	w = f.call("alice", "PUT", "/api/v1/me/habit-preferences", "timezone-change", map[string]any{"goal": "minutes", "timezone": "Asia/Kolkata"})
	expect(t, w, 200)
	if !strings.Contains(w.Body.String(), "America/Los_Angeles") {
		t.Fatal("timezone changed after credit")
	}
	if !read[struct {
		Today HabitDay `json:"today"`
	}](t, w).Today.GoalMet {
		t.Fatal("achievement removed with goal change")
	}
	// Accepted playback writes split at local midnight (UTC08:00 in winter).
	at := time.Date(2026, 12, 2, 8, 0, 5, 0, time.UTC)
	f.at(at.Add(-10 * time.Second))
	w = f.call("alice", "POST", "/api/v1/playback/sessions", "", map[string]any{"lesson_id": "lesson1"})
	expect(t, w, 201)
	opened := read[struct {
		ID string `json:"id"`
	}](t, w)
	baseline := playback.Pulse{Sequence: 1, Kind: "playing", Playing: true, Visible: true, PlaybackRate: 1}
	expect(t, f.call("alice", "POST", "/api/v1/playback/sessions/"+opened.ID+"/pulse", "", baseline), 200)
	f.advance(10)
	pulse := playback.Pulse{Sequence: 2, Kind: "heartbeat", Position: 10, Playing: true, Visible: true, ElapsedSeconds: 10, PlaybackRate: 1}
	expect(t, f.call("alice", "POST", "/api/v1/playback/sessions/"+opened.ID+"/pulse", "", pulse), 200)
	expect(t, f.call("alice", "POST", "/api/v1/playback/sessions/"+opened.ID+"/pulse", "", pulse), 200)
	var left, right float64
	err := f.service.Pool.QueryRow(ctx, `SELECT (SELECT watched_seconds FROM habit_days WHERE user_id='alice' AND day='2026-12-01'),(SELECT watched_seconds FROM habit_days WHERE user_id='alice' AND day='2026-12-02')`).Scan(&left, &right)
	if err != nil || left != 5 || right != 5 {
		t.Fatalf("midnight split %v/%v err%v", left, right, err)
	}
	if _, err = f.service.Pool.Exec(ctx, `UPDATE playback_sessions SET watched_seconds=1000,baseline_at=$1 WHERE id=$2`, at, opened.ID); err == nil {
		t.Fatal("unbounded invented watch delta accepted")
	}
}

func TestWeeklyForecastDoesNotScheduleBeforeDueAndPreservesRestHistory(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	w := f.call("alice", "PUT", "/api/v1/planner/week-preferences", "weekprefs", map[string]any{"weekday_minutes": []int{30, 0, 30, 0, 0, 0, 0}, "expected_revision": 0})
	expect(t, w, 200)
	if _, err := f.service.Pool.Exec(ctx, `INSERT INTO review_cards(id,user_id,course_id,question,answer,due_at)VALUES('tuesday','alice','course','What is this card?','A test','2026-10-13T12:00:00Z'),('friday','alice','course','What is the later card?','A test','2026-10-16T12:00:00Z')`); err != nil {
		t.Fatal(err)
	}
	plan := f.plan(t, "2026-10-13", "resthistory")
	item := plan.Items[0]
	w = f.call("alice", "PUT", "/api/v1/planner/items/"+item.ID+"/actual", "restreport", map[string]any{"actual_minutes": 17, "expected_revision": item.Revision})
	expect(t, w, 200)
	w = f.call("alice", "POST", "/api/v1/planner/weeks", "week", map[string]any{"week_start": "2026-10-12"})
	expect(t, w, 201)
	week := read[Week](t, w)
	if week.Days[0].ForecastReviews != 0 || week.Days[2].ForecastReviews != 1 || week.UnscheduledReviews != 1 || !week.Days[1].RestDay || week.Days[1].ActualMinutes != 17 {
		t.Fatalf("week forecast/history %+v", week)
	}
	w = f.call("alice", "GET", "/api/v1/planner/days/2026-10-14", "", nil)
	expect(t, w, 200)
	day := read[Day](t, w)
	if len(day.Items) == 0 || day.Items[0].Kind != "review" || len(day.Items[0].Action.ReviewCardIDs) != 1 || day.Items[0].Action.ReviewCardIDs[0] != "tuesday" {
		t.Fatalf("review allocation %+v", day)
	}
	w = f.call("bob", "GET", "/api/v1/planner/weeks/2026-10-12", "", nil)
	expect(t, w, 404)
}

func TestRevocationAndBadCSRFDoNotWrite(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	for _, headers := range [][2]string{{"http://hostile.example", "csrf"}, {"http://test", "wrong"}, {"http://test", ""}} {
		r := httptest.NewRequest("POST", "http://test/api/v1/focus/sessions", strings.NewReader(`{"duration_minutes":1}`))
		r.AddCookie(&http.Cookie{Name: identity.CookieName, Value: "alicetoken"})
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", headers[0])
		r.Header.Set("X-CSRF-Token", headers[1])
		r.Header.Set("Idempotency-Key", "csrfdeny")
		w := httptest.NewRecorder()
		f.mux.ServeHTTP(w, r)
		expect(t, w, 403)
	}
	if _, err := f.service.Pool.Exec(ctx, `UPDATE auth_sessions SET revoked_at=now() WHERE id='aliceauth'`); err != nil {
		t.Fatal(err)
	}
	expect(t, f.call("alice", "POST", "/api/v1/focus/sessions", "revoked", map[string]any{"duration_minutes": 1}), 401)
	var count int
	if err := f.service.Pool.QueryRow(ctx, `SELECT count(*)FROM focus_sessions`).Scan(&count); err != nil || count != 0 {
		t.Fatal("denied focus mutation wrote")
	}
}

func TestAcceptedHTTPActionsProjectAtomicHabitCredit(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	// This case exercises real SQL playback ownership. Anchor its accelerated
	// accounting clock to current UTC, so renewing a lease cannot place it in
	// the past once the machine clock passes the planner's fixed-noon fixture.
	f.at(time.Now().UTC())
	w := f.call("alice", "POST", "/api/v1/playback/sessions", "", map[string]any{"lesson_id": "lesson1"})
	expect(t, w, 201)
	opened := read[struct {
		ID string `json:"id"`
	}](t, w)
	baseline := playback.Pulse{Sequence: 1, Kind: "playing", Playing: true, Visible: true, PlaybackRate: 1}
	expect(t, f.call("alice", "POST", "/api/v1/playback/sessions/"+opened.ID+"/pulse", "", baseline), 200)
	f.advance(10)
	pulse := playback.Pulse{Sequence: 2, Kind: "heartbeat", Position: 10, Playing: true, Visible: true, ElapsedSeconds: 10, PlaybackRate: 1}
	expect(t, f.call("alice", "POST", "/api/v1/playback/sessions/"+opened.ID+"/pulse", "", pulse), 200)
	expect(t, f.call("alice", "POST", "/api/v1/playback/sessions/"+opened.ID+"/pulse", "", pulse), 200)
	f.advance(5)
	pause := playback.Pulse{Sequence: 3, Kind: "pause", Position: 10, Visible: true, ElapsedSeconds: 5, PlaybackRate: 1}
	w = f.call("alice", "POST", "/api/v1/playback/sessions/"+opened.ID+"/pulse", "", pause)
	expect(t, w, 200)
	metrics := read[playback.Ack](t, w)
	if metrics.VisibleSeconds != 15 || metrics.WatchedSeconds != 10 {
		t.Fatalf("page and watched time conflated: %+v", metrics)
	}
	w = f.call("alice", "GET", "/api/v1/lessons/lesson1/progress", "", nil)
	expect(t, w, 200)
	version := read[struct {
		Revision int64 `json:"revision"`
	}](t, w).Revision
	w = f.call("alice", "PUT", "/api/v1/lessons/lesson1/progress", "", map[string]any{"percent": 100, "position": 10, "expected_revision": version})
	expect(t, w, 200)
	version = read[struct {
		Revision int64 `json:"revision"`
	}](t, w).Revision
	w = f.call("alice", "PUT", "/api/v1/lessons/lesson1/progress", "", map[string]any{"percent": 100, "position": 10, "expected_revision": version})
	expect(t, w, 200)
	correct := 0
	questions := []learning.Question{{ID: "question", Question: "Which action is atomic?", Options: []string{"Transaction", "Random write"}, CorrectIndex: &correct, Explanation: "The accepted private solution", SourceStart: 10}}
	w = f.call("admin", "POST", "/api/v1/admin/lessons/lesson1/quiz", "quiz", map[string]any{"questions": questions, "status": "approved"})
	expect(t, w, 201)
	quiz := read[learning.Quiz](t, w)
	answers := map[string]any{"quiz_id": quiz.ID, "revision": 1, "answers": map[string]int{"question": 0}}
	w = f.call("alice", "POST", "/api/v1/lessons/lesson1/quiz/attempts", "attempt", answers)
	expect(t, w, 201)
	expect(t, f.call("alice", "POST", "/api/v1/lessons/lesson1/quiz/attempts", "attempt", answers), 201)
	w = f.call("alice", "GET", "/api/v1/reviews/cards", "", nil)
	expect(t, w, 200)
	cards := read[struct {
		Cards []learning.Card `json:"cards"`
	}](t, w)
	if len(cards.Cards) != 1 {
		t.Fatalf("quiz card %+v", cards)
	}
	w = f.call("alice", "POST", "/api/v1/reviews/"+cards.Cards[0].ID+"/grade", "grade", map[string]any{"quality": 5, "expected_revision": 1})
	expect(t, w, 200)
	attempt := read[struct {
		ID string `json:"attempt_id"`
	}](t, w).ID
	complete := map[string]any{"course": "course", "attempt_ids": []string{attempt}}
	expect(t, f.call("alice", "POST", "/api/v1/reviews/complete", "complete", complete), 201)
	expect(t, f.call("alice", "POST", "/api/v1/reviews/complete", "complete", complete), 201)
	var seconds float64
	var lessons, quizzes, reviews int64
	err := f.service.Pool.QueryRow(ctx, `SELECT sum(watched_seconds),sum(lessons),sum(quizzes),sum(reviews)FROM habit_days WHERE user_id='alice'`).Scan(&seconds, &lessons, &quizzes, &reviews)
	if err != nil || seconds != 10 || lessons != 1 || quizzes != 1 || reviews != 1 {
		t.Fatalf("accepted projections seconds=%v lessons=%d quizzes=%d reviews=%d err=%v", seconds, lessons, quizzes, reviews, err)
	}
	w = f.call("alice", "GET", "/api/v1/studio/insights", "", nil)
	expect(t, w, 200)
	insights := read[map[string]any](t, w)
	if insights["mastery_signal_percent"] != float64(100) {
		t.Fatalf("recall signal %v", insights)
	}
	w = f.call("bob", "GET", "/api/v1/studio/insights", "", nil)
	expect(t, w, 200)
	if strings.Contains(w.Body.String(), "Which action is atomic?") {
		t.Fatal("private recall history exposed")
	}
	tx, err := f.service.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO learning_credits(user_id,kind,resource,day,credited_at)VALUES('alice','quiz','rollback',$1,$2)`, f.now().Format("2006-01-02"), f.now()); err != nil {
		tx.Rollback(ctx)
		t.Fatal(err)
	}
	if err = tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if err = f.service.Pool.QueryRow(ctx, `SELECT sum(quizzes)FROM habit_days WHERE user_id='alice'`).Scan(&quizzes); err != nil || quizzes != 1 {
		t.Fatalf("rolled-back credit leaked %d err=%v", quizzes, err)
	}
}

func TestFocusAnalyticsSplitsMidnightDSTAndExcludesBreakAndCancel(t *testing.T) {
	f := setup(t)
	w := f.call("alice", "PUT", "/api/v1/me/habit-preferences", "zone", map[string]any{"timezone": "America/Los_Angeles", "goal": "minutes"})
	expect(t, w, 200)
	f.at(time.Date(2026, 11, 1, 6, 59, 30, 0, time.UTC))
	session := f.start(t, "alice", "midnight", 2)
	f.advance(90)
	session = f.action(t, "alice", "midnight-finish", session, "finish")
	// Crossing the fall-back hour consumes60 real seconds, not a negative hour.
	f.at(time.Date(2026, 11, 1, 8, 59, 30, 0, time.UTC))
	session = f.start(t, "alice", "dst", 2)
	f.advance(60)
	f.action(t, "alice", "dst-finish", session, "finish")
	w = f.call("alice", "POST", "/api/v1/focus/sessions", "break", map[string]any{"mode": "break", "duration_minutes": 1})
	expect(t, w, 201)
	session = read[Focus](t, w)
	f.advance(30)
	f.action(t, "alice", "break-finish", session, "finish")
	session = f.start(t, "alice", "cancel", 1)
	f.advance(30)
	f.action(t, "alice", "cancel-action", session, "cancel")
	w = f.call("alice", "GET", "/api/v1/focus/analytics/2026-10-26", "", nil)
	expect(t, w, 200)
	analytics := read[struct {
		Days     []FocusDay `json:"days"`
		Measured float64    `json:"measured_minutes"`
	}](t, w)
	if len(analytics.Days) != 7 || analytics.Days[5].MeasuredSeconds != 30 || analytics.Days[6].MeasuredSeconds != 120 || analytics.Measured != 2.5 {
		t.Fatalf("midnight/DST accounting %+v", analytics)
	}
}

func TestDeletedAndRevokedSourcesAreHiddenAndReportsRetained(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	plan := f.plan(t, "2026-10-12", "plan")
	w := f.call("alice", "POST", "/api/v1/focus/sessions", "linked", map[string]any{"duration_minutes": 1, "lesson_id": "lesson1"})
	expect(t, w, 201)
	session := read[Focus](t, w)
	f.advance(10)
	session = f.action(t, "alice", "finish", session, "finish")
	if _, err := f.service.Pool.Exec(ctx, `DELETE FROM lessons WHERE id='lesson1'`); err != nil {
		t.Fatal(err)
	}
	w = f.call("alice", "GET", "/api/v1/focus/history", "", nil)
	expect(t, w, 200)
	if strings.Contains(w.Body.String(), session.ID) {
		t.Fatal("deleted lesson became an unlinked visible timer")
	}
	w = f.call("alice", "GET", "/api/v1/planner/days/2026-10-12", "", nil)
	expect(t, w, 200)
	if strings.Contains(w.Body.String(), plan.Items[0].ID) {
		t.Fatal("deleted source item exposed")
	}
	if _, err := f.service.Pool.Exec(ctx, `UPDATE courses SET published=false WHERE id='course'`); err != nil {
		t.Fatal(err)
	}
	w = f.call("alice", "GET", "/api/v1/planner/days/2026-10-12", "", nil)
	expect(t, w, 200)
	if len(read[Day](t, w).Items) != 0 {
		t.Fatal("unpublished course item exposed")
	}
	var sessions, items int
	if err := f.service.Pool.QueryRow(ctx, `SELECT (SELECT count(*)FROM focus_sessions),(SELECT count(*)FROM daily_plan_items)`).Scan(&sessions, &items); err != nil || sessions != 1 || items != 2 {
		t.Fatalf("historical provenance discarded sessions=%d items=%d err=%v", sessions, items, err)
	}
	expect(t, f.call("alice", "POST", "/api/v1/focus/sessions", "zero", map[string]any{"duration_minutes": 0}), 422)
}

func TestDailyCommandSnapshotsRemainImmutableAndRecheckAccess(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	body := map[string]any{"study_date": "2026-10-12"}
	w := f.call("alice", "POST", "/api/v1/planner/days", "plan", body)
	expect(t, w, 201)
	original := read[Day](t, w)
	item := original.Items[0]
	w = f.call("alice", "PUT", "/api/v1/planner/items/"+item.ID+"/actual", "report", map[string]any{"actual_minutes": 12, "expected_revision": item.Revision})
	expect(t, w, 200)
	reported := read[Day](t, w)
	w = f.call("alice", "POST", "/api/v1/planner/days", "refresh", map[string]any{"study_date": original.StudyDate, "refresh": true, "expected_revision": reported.Revision})
	expect(t, w, 201)
	w = f.call("alice", "POST", "/api/v1/planner/days", "plan", body)
	expect(t, w, 201)
	replayed := read[Day](t, w)
	if replayed.Revision != original.Revision || replayed.ActualMinutes != 0 || replayed.Items[0].ID != original.Items[0].ID {
		t.Fatalf("replay replaced saved snapshot: %+v", replayed)
	}
	expect(t, f.call("alice", "POST", "/api/v1/planner/days", "plan", map[string]any{"study_date": "2026-10-13"}), 409)
	expect(t, f.call("bob", "POST", "/api/v1/planner/days", "plan", body), 201)
	if _, err := f.service.Pool.Exec(ctx, `DELETE FROM enrollments WHERE user_id='alice' AND course_id='course'`); err != nil {
		t.Fatal(err)
	}
	w = f.call("alice", "POST", "/api/v1/planner/days", "plan", body)
	expect(t, w, 201)
	hidden := read[Day](t, w)
	if len(hidden.Items) != 0 || hidden.PlannedMinutes != 0 || hidden.ActualMinutes != 0 || strings.Contains(w.Body.String(), "First source") {
		t.Fatalf("replayed inaccessible source: %+v", hidden)
	}
	var saved Day
	var raw []byte
	if err := f.service.Pool.QueryRow(ctx, `SELECT response FROM planning_commands WHERE user_id='alice' AND idempotency_key='plan'`).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &saved); err != nil || len(saved.Items) != len(original.Items) || saved.Revision != original.Revision {
		t.Fatalf("durable snapshot changed: %+v err=%v", saved, err)
	}
	// A command with a direct reference must deny replay after revocation.
	expect(t, f.call("alice", "PUT", "/api/v1/planner/items/"+item.ID+"/actual", "report", map[string]any{"actual_minutes": 12, "expected_revision": item.Revision}), 404)
}

func TestFocusFirstActionAnchorsTimezoneAndLateCancelKeepsExhaustedTime(t *testing.T) {
	f := setup(t)
	session := f.start(t, "alice", "first-action", 1)
	w := f.call("alice", "PUT", "/api/v1/me/habit-preferences", "late-zone", map[string]any{"goal": "minutes", "timezone": "America/Los_Angeles"})
	expect(t, w, 200)
	prefs := read[struct {
		Preferences HabitPreferences `json:"preferences"`
	}](t, w).Preferences
	if prefs.Timezone != "UTC" {
		t.Fatalf("first action timezone changed: %+v", prefs)
	}
	f.advance(90)
	session = f.action(t, "alice", "late-cancel", session, "cancel")
	if session.Status != "finished" || session.ElapsedSeconds != 60 {
		t.Fatalf("cancel erased exhausted timer: %+v", session)
	}
	w = f.call("alice", "GET", "/api/v1/focus/analytics/2026-10-12", "", nil)
	expect(t, w, 200)
	if read[map[string]any](t, w)["measured_minutes"] != float64(1) {
		t.Fatalf("exhausted focus omitted: %s", w.Body.String())
	}
	// Construct a new service to prove timer state is reconstructed from SQL.
	auth, err := identity.New(f.service.Pool, identity.Config{PublicOrigin: "http://test", PasswordConcurrency: 1})
	if err != nil {
		t.Fatal(err)
	}
	f.service = New(f.service.Pool)
	f.service.Now = f.now
	f.mux = http.NewServeMux()
	f.service.Register(f.mux, auth)
	w = f.call("alice", "GET", "/api/v1/focus/history", "", nil)
	expect(t, w, 200)
	history := read[struct {
		Sessions []Focus `json:"sessions"`
	}](t, w)
	if len(history.Sessions) != 1 || history.Sessions[0].Status != "finished" || history.Sessions[0].ElapsedSeconds != 60 {
		t.Fatalf("reconstructed focus history: %+v", history)
	}
}

func TestConcurrentPlannerRevisionWritesHaveOneWinner(t *testing.T) {
	f := setup(t)
	plan := f.plan(t, "2026-10-12", "plan")
	item := plan.Items[0]
	var wg sync.WaitGroup
	responses := make(chan *httptest.ResponseRecorder, 8)
	for i := range 8 {
		wg.Go(func() {
			responses <- f.call("alice", "PUT", "/api/v1/planner/items/"+item.ID+"/actual", fmt.Sprintf("report-%d", i), map[string]any{"actual_minutes": i + 1, "expected_revision": item.Revision})
		})
	}
	wg.Wait()
	close(responses)
	winners, conflicts := 0, 0
	for w := range responses {
		switch w.Code {
		case 200:
			winners++
		case 409:
			conflicts++
		default:
			t.Fatalf("unexpected race response %d: %s", w.Code, w.Body.String())
		}
	}
	if winners != 1 || conflicts != 7 {
		t.Fatalf("revision race winners=%d conflicts=%d", winners, conflicts)
	}
	w := f.call("alice", "GET", "/api/v1/planner/days/2026-10-12", "", nil)
	expect(t, w, 200)
	updated := read[Day](t, w)
	if updated.Revision != plan.Revision+1 || updated.Items[0].Revision != item.Revision+1 || updated.ActualMinutes < 1 || updated.ActualMinutes > 8 {
		t.Fatalf("revision race lost or repeated writes: %+v", updated)
	}
}

func TestWeeklyForecastCountsAllCardsAndBoundsEmbeddedIDs(t *testing.T) {
	f := setup(t)
	if _, err := f.service.Pool.Exec(context.Background(), `INSERT INTO review_cards(id,user_id,course_id,question,answer,due_at) SELECT 'card-'||lpad(i::text,3,'0'),'alice','course','Synthetic card','Synthetic answer','2026-10-13T12:00:00Z' FROM generate_series(1,121)i`); err != nil {
		t.Fatal(err)
	}
	w := f.call("alice", "POST", "/api/v1/planner/weeks", "week", map[string]any{"week_start": "2026-10-12"})
	expect(t, w, 201)
	week := read[Week](t, w)
	if week.ForecastReviews != 121 || week.Days[0].ForecastReviews != 0 || week.Days[1].ForecastReviews != 121 {
		t.Fatalf("forecast truncated counts or scheduled early: %+v", week)
	}
	w = f.call("alice", "GET", "/api/v1/planner/days/2026-10-13", "", nil)
	expect(t, w, 200)
	day := read[Day](t, w)
	if len(day.Items) == 0 || day.Items[0].Kind != "review" || len(day.Items[0].Action.ReviewCardIDs) != 100 {
		t.Fatalf("embedded forecast IDs not bounded: %+v", day)
	}
}
