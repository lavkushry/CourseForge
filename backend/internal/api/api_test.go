package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"sync"
	"testing"
	"time"

	"courseforge/backend/internal/api"
	"courseforge/backend/internal/identity"
	"courseforge/backend/internal/store"
	"courseforge/backend/internal/testutil"

	"github.com/jackc/pgx/v5/pgxpool"
)

type fixture struct {
	pool   *pgxpool.Pool
	server *httptest.Server
	auth   *identity.Service
	app    *api.Server
}
type browser struct {
	client     *http.Client
	base, csrf string
}

func setup(t *testing.T) fixture {
	return setupWithIdentity(t, "open", nil)
}
func setupWithIdentity(t *testing.T, mode string, mailer identity.Mailer) fixture {
	t.Helper()
	pool := testutil.Postgres(t)
	ctx := context.Background()
	hash, err := identity.HashPassword("test-password")
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"alice", "bob", "unverified", "admin"} {
		role := "student"
		if id == "admin" {
			role = "admin"
		}
		if _, err = pool.Exec(ctx, "INSERT INTO users(id,email,name,password_hash,role,verified) VALUES($1,$2,$1,$3,$4,$5)", id, id+"@example.test", hash, role, id != "unverified"); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = pool.Exec(ctx, `INSERT INTO courses(id,title,published) VALUES('course-a','Published A',true),('course-b','Published B',true),('private','Hidden',false); INSERT INTO lessons(id,course_id,title,sort_order,duration_seconds) VALUES('lesson-z','course-a','First',1,120),('lesson-a','course-a','Second',2,120),('lesson-b','course-b','Other learner',1,120),('private-lesson','private','Hidden',1,120); INSERT INTO enrollments(user_id,course_id) VALUES('alice','course-a'),('bob','course-b')`); err != nil {
		t.Fatal(err)
	}
	auth, err := identity.New(pool, identity.Config{PublicOrigin: "http://localhost", PasswordConcurrency: 2, RegistrationOpen: true, RegistrationMode: mode, Mailer: mailer})
	if err != nil {
		t.Fatal(err)
	}
	app := api.New(pool, auth)
	auth.RegisterAdminRoutes(app.Mux)
	server := httptest.NewServer(api.Middleware(app.Handler(), 10*time.Second))
	t.Cleanup(server.Close)
	auth.Config.PublicOrigin = server.URL
	return fixture{pool: pool, server: server, auth: auth, app: app}
}
func (f fixture) login(t *testing.T, id string) browser {
	t.Helper()
	jar, _ := cookiejar.New(nil)
	b := browser{client: &http.Client{Jar: jar}, base: f.server.URL}
	status, body := b.call(t, "POST", "/api/v1/auth/login", map[string]any{"email": id + "@example.test", "password": "test-password"}, nil)
	if status != 200 {
		t.Fatalf("login status %d: %s", status, body)
	}
	var response struct {
		CSRF string `json:"csrf_token"`
	}
	if err := json.Unmarshal(body, &response); err != nil {
		t.Fatal(err)
	}
	b.csrf = response.CSRF
	return b
}
func (b browser) call(t *testing.T, method, path string, body any, headers map[string]string) (int, []byte) {
	t.Helper()
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		reader = bytes.NewReader(data)
	}
	r, err := http.NewRequest(method, b.base+path, reader)
	if err != nil {
		t.Fatal(err)
	}
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", b.base)
	r.Header.Set("X-CSRF-Token", b.csrf)
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	res, err := b.client.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	data, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	return res.StatusCode, data
}
func expect(t *testing.T, b browser, method, path string, body any, want int, headers map[string]string) []byte {
	t.Helper()
	status, data := b.call(t, method, path, body, headers)
	if status != want {
		t.Fatalf("%s %s: status=%d want=%d body=%s", method, path, status, want, data)
	}
	return data
}

func TestLearnerSliceIsolationAndDurability(t *testing.T) {
	f := setup(t)
	alice := f.login(t, "alice")
	bob := f.login(t, "bob")
	anon := browser{client: &http.Client{}, base: f.server.URL}
	expect(t, anon, "GET", "/api/v1/lessons/lesson-z", nil, 401, nil)
	expect(t, alice, "GET", "/api/v1/lessons/lesson-z", nil, 200, nil)
	expect(t, bob, "GET", "/api/v1/lessons/lesson-z", nil, 404, nil)
	body := map[string]any{"percent": 42, "position": 45.5, "expected_revision": 0}
	data := expect(t, alice, "PUT", "/api/v1/lessons/lesson-z/progress", body, 200, nil)
	var saved api.Progress
	if err := json.Unmarshal(data, &saved); err != nil {
		t.Fatal(err)
	}
	if saved.Revision != 1 || saved.Percent != 42 {
		t.Fatal("unexpected acknowledged progress", saved)
	}
	expect(t, bob, "PUT", "/api/v1/lessons/lesson-z/progress", body, 404, nil)
	expect(t, alice, "PUT", "/api/v1/lessons/lesson-z/progress", body, 409, nil)
	data = expect(t, alice, "PUT", "/api/v1/lessons/lesson-z/progress", map[string]any{"percent": 100, "position": 120, "expected_revision": 1}, 200, nil)
	if err := json.Unmarshal(data, &saved); err != nil {
		t.Fatal(err)
	}
	if !saved.Completed || !saved.ExplicitCompleted || saved.Revision != 2 {
		t.Fatal("completion semantics", saved)
	}
	data = expect(t, alice, "GET", "/api/v1/lessons/lesson-z/progress", nil, 200, nil)
	var read api.Progress
	_ = json.Unmarshal(data, &read)
	if read != saved && (read.Percent != saved.Percent || read.Position != saved.Position || read.Revision != saved.Revision) {
		t.Fatal("acknowledged write not persisted")
	}
	data = expect(t, alice, "POST", "/api/v1/lessons/lesson-z/notes", map[string]any{"content": "Alice private note", "position": 45}, 201, map[string]string{"Idempotency-Key": "note-retry-1"})
	var note api.Note
	_ = json.Unmarshal(data, &note)
	retry := expect(t, alice, "POST", "/api/v1/lessons/lesson-z/notes", map[string]any{"content": "Alice private note", "position": 45}, 201, map[string]string{"Idempotency-Key": "note-retry-1"})
	var again api.Note
	_ = json.Unmarshal(retry, &again)
	if note.ID != again.ID {
		t.Fatal("retry duplicated note")
	}
	expect(t, alice, "POST", "/api/v1/lessons/lesson-z/notes", map[string]any{"content": "Changed payload", "position": 45}, 409, map[string]string{"Idempotency-Key": "note-retry-1"})
	expect(t, bob, "POST", "/api/v1/courses/course-a/enroll", nil, 201, nil)
	data = expect(t, bob, "GET", "/api/v1/lessons/lesson-z/progress", nil, 200, nil)
	_ = json.Unmarshal(data, &read)
	if read.Percent != 0 || read.Position != 0 {
		t.Fatal("cross-user progress leaked")
	}
	data = expect(t, bob, "GET", "/api/v1/lessons/lesson-z/notes", nil, 200, nil)
	if bytes.Contains(data, []byte("Alice private note")) {
		t.Fatal("cross-user notes leaked")
	}
	expect(t, bob, "DELETE", "/api/v1/lessons/lesson-z/notes/"+note.ID, nil, 404, nil)
	var count int
	if err := f.pool.QueryRow(context.Background(), "SELECT count(*) FROM notes WHERE user_id='alice'").Scan(&count); err != nil || count != 1 {
		t.Fatalf("durable duplicate suppression count=%d err=%v", count, err)
	}
}
func TestCatalogPaginationAndAccessRevocation(t *testing.T) {
	f := setup(t)
	alice := f.login(t, "alice")
	data := expect(t, alice, "GET", "/api/v1/public/courses?limit=1", nil, 200, nil)
	var listing struct {
		Courses []api.Course `json:"courses"`
		Next    string       `json:"next_cursor"`
	}
	_ = json.Unmarshal(data, &listing)
	if len(listing.Courses) != 1 || listing.Next == "" {
		t.Fatal("catalog pagination missing")
	}
	data = expect(t, alice, "GET", "/api/v1/public/courses?limit=1&cursor="+listing.Next, nil, 200, nil)
	if bytes.Contains(data, []byte("Hidden")) {
		t.Fatal("unpublished course leaked")
	}
	data = expect(t, alice, "GET", "/api/v1/courses/course-a?limit=1", nil, 200, nil)
	var detail struct {
		Lessons []api.Lesson `json:"lessons"`
		Next    string       `json:"next_cursor"`
	}
	_ = json.Unmarshal(data, &detail)
	if len(detail.Lessons) != 1 || detail.Lessons[0].ID != "lesson-z" {
		t.Fatal("lesson ordering not preserved", detail)
	}
	data = expect(t, alice, "GET", "/api/v1/courses/course-a?limit=1&cursor="+detail.Next, nil, 200, nil)
	_ = json.Unmarshal(data, &detail)
	if detail.Lessons[0].ID != "lesson-a" {
		t.Fatal("lesson cursor skipped row")
	}
	expect(t, alice, "GET", "/api/v1/courses?limit=101", nil, 400, nil)
	expect(t, alice, "POST", "/api/v1/courses/private/enroll", nil, 404, nil)
	if _, err := f.pool.Exec(context.Background(), "UPDATE courses SET published=false WHERE id='course-a'"); err != nil {
		t.Fatal(err)
	}
	expect(t, alice, "GET", "/api/v1/lessons/lesson-z", nil, 404, nil)
	expect(t, alice, "PUT", "/api/v1/lessons/lesson-z/progress", map[string]any{"percent": 40, "position": 30}, 404, nil)
	if _, err := f.pool.Exec(context.Background(), "UPDATE users SET suspended=true WHERE id='alice'"); err != nil {
		t.Fatal(err)
	}
	expect(t, alice, "GET", "/api/v1/auth/me", nil, 401, nil)
}
func TestCSRFOriginLogoutRegistrationAndLastAdmin(t *testing.T) {
	f := setup(t)
	alice := f.login(t, "alice")
	expect(t, alice, "POST", "/api/v1/courses/course-b/enroll", nil, 403, map[string]string{"X-CSRF-Token": ""})
	expect(t, alice, "POST", "/api/v1/courses/course-b/enroll", nil, 403, map[string]string{"Origin": "https://attacker.example"})
	expect(t, alice, "POST", "/api/v1/courses/course-b/enroll", nil, 403, map[string]string{"Sec-Fetch-Site": "cross-site"})
	unverified := f.login(t, "unverified")
	expect(t, unverified, "GET", "/api/v1/auth/me", nil, 200, nil)
	expect(t, unverified, "POST", "/api/v1/courses/course-a/enroll", nil, 403, nil)
	admin := f.login(t, "admin")
	expect(t, admin, "PATCH", "/api/v1/admin/users/admin", map[string]any{"role": "student", "suspended": false, "current_password": "test-password"}, 409, nil)
	expect(t, alice, "PATCH", "/api/v1/admin/users/bob", map[string]any{"role": "student", "suspended": true}, 403, nil)
	expect(t, admin, "PATCH", "/api/v1/admin/users/alice", map[string]any{"suspended": true}, 200, nil)
	expect(t, alice, "GET", "/api/v1/auth/me", nil, 401, nil)
	bob := f.login(t, "bob")
	oldURL, _ := url.Parse(bob.base)
	oldCookie := bob.client.Jar.Cookies(oldURL)
	expect(t, bob, "POST", "/api/v1/auth/logout", nil, 200, nil)
	bob.client.Jar.SetCookies(oldURL, oldCookie)
	expect(t, bob, "GET", "/api/v1/auth/me", nil, 401, nil)
	jar, _ := cookiejar.New(nil)
	newUser := browser{client: &http.Client{Jar: jar}, base: f.server.URL}
	expect(t, newUser, "POST", "/api/v1/auth/register", map[string]any{"email": "new@example.test", "name": "New Learner", "password": "safe-password"}, 201, nil)
	expect(t, newUser, "GET", "/api/v1/auth/me", nil, 200, nil)
}
func TestConcurrentProgressAndNoteWrites(t *testing.T) {
	f := setup(t)
	alice := f.login(t, "alice")
	const workers = 8
	var wg sync.WaitGroup
	statuses := make(chan int, workers)
	for i := range workers {
		wg.Go(func() {
			status, _ := alice.call(t, "PUT", "/api/v1/lessons/lesson-z/progress", map[string]any{"percent": i, "position": float64(i), "expected_revision": 0}, nil)
			statuses <- status
		})
	}
	wg.Wait()
	close(statuses)
	success := 0
	for status := range statuses {
		if status == 200 {
			success++
		} else if status != 409 {
			t.Fatalf("unexpected concurrent status %d", status)
		}
	}
	if success != 1 {
		t.Fatalf("competing initial revisions had %d successes", success)
	}
	for range workers {
		wg.Go(func() {
			expect(t, alice, "POST", "/api/v1/lessons/lesson-z/notes", map[string]any{"position": 10, "content": "same retry"}, 201, map[string]string{"Idempotency-Key": "concurrent-retry"})
		})
	}
	wg.Wait()
	var count int
	if err := f.pool.QueryRow(context.Background(), "SELECT count(*) FROM notes").Scan(&count); err != nil || count != 1 {
		t.Fatalf("concurrent note retry count=%d err=%v", count, err)
	}
	if err := store.Migrate(context.Background(), f.pool); err != nil {
		t.Fatal("migration not repeatable", err)
	}
}
func TestLoginAccountRateLimit(t *testing.T) {
	f := setup(t)
	invalid := browser{client: &http.Client{}, base: f.server.URL}
	for i := range 11 {
		status, _ := invalid.call(t, "POST", "/api/v1/auth/login", map[string]any{"email": "absent@example.test", "password": "wrong-password"}, nil)
		want := 401
		if i == 10 {
			want = 429
		}
		if status != want {
			t.Fatalf("attempt %d status=%d want=%d", i, status, want)
		}
	}
}

func TestTutorAsk(t *testing.T) {
	f := setup(t)
	guest := browser{client: &http.Client{}, base: f.server.URL}
	status, _ := guest.call(t, "POST", "/api/v1/learning/tutor", map[string]any{"question": "test question"}, nil)
	if status != 401 {
		t.Fatalf("guest tutor call status=%d want 401", status)
	}

	alice := f.login(t, "alice")
	status, body := alice.call(t, "POST", "/api/v1/learning/tutor", map[string]any{
		"question":  "test question",
		"mode":      "explain",
		"lesson_id": "lesson-z",
	}, nil)
	if status != 200 {
		t.Fatalf("alice tutor call status=%d want 200, body=%s", status, string(body))
	}
	var resp map[string]any
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatalf("failed to decode tutor response: %v", err)
	}
	if resp["answer"] == "" {
		t.Fatalf("expected non-empty tutor answer")
	}
}
