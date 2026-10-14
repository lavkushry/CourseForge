package playback

import (
	"bytes"
	"context"
	"courseforge/backend/internal/identity"
	"courseforge/backend/internal/testutil"
	"encoding/json"
	"github.com/jackc/pgx/v5/pgxpool"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"testing"
	"time"
)

type fixture struct {
	pool *pgxpool.Pool
	svc  *Service
	mux  *http.ServeMux
	now  time.Time
}

func setup(t *testing.T) fixture {
	t.Helper()
	pool := testutil.Postgres(t)
	ctx := context.Background()
	for _, id := range []string{"alice", "bob"} {
		_, err := pool.Exec(ctx, `INSERT INTO users(id,email,name,password_hash,verified)VALUES($1,$1||'@test.example',$1,'disabled',true);`, id)
		if err != nil {
			t.Fatal(err)
		}
		_, err = pool.Exec(ctx, `INSERT INTO auth_sessions(id,user_id,token_hash,csrf_token,expires_at)VALUES($1,$2,$3,'csrf',now()+interval '1 hour')`, id+"auth", id, digest(id+"token"))
		if err != nil {
			t.Fatal(err)
		}
	}
	_, err := pool.Exec(ctx, `INSERT INTO courses(id,title,published)VALUES('course','Course',true);INSERT INTO lessons(id,course_id,title,duration_seconds)VALUES('lesson','course','Lesson',100);INSERT INTO enrollments(user_id,course_id)VALUES('alice','course'),('bob','course')`)
	if err != nil {
		t.Fatal(err)
	}
	auth, err := identity.New(pool, identity.Config{PublicOrigin: "http://test", PasswordConcurrency: 1})
	if err != nil {
		t.Fatal(err)
	}
	svc := New(pool, auth)
	mux := http.NewServeMux()
	svc.Register(mux)
	return fixture{pool, svc, mux, time.Now().UTC()}
}
func (f fixture) call(t *testing.T, user, method, path string, body any) (int, []byte) {
	t.Helper()
	raw, _ := json.Marshal(body)
	r := httptest.NewRequest(method, "http://test"+path, bytes.NewReader(raw))
	r.AddCookie(&http.Cookie{Name: identity.CookieName, Value: user + "token"})
	r.Header.Set("X-CSRF-Token", "csrf")
	r.Header.Set("Origin", "http://test")
	w := httptest.NewRecorder()
	f.mux.ServeHTTP(w, r)
	return w.Code, w.Body.Bytes()
}
func (f fixture) open(t *testing.T, user string, takeover bool) (string, string) {
	t.Helper()
	code, body := f.call(t, user, "POST", "/api/v1/playback/sessions", map[string]any{"lesson_id": "lesson", "take_over": takeover})
	if code != 201 {
		t.Fatalf("open %d %s", code, body)
	}
	var v struct{ ID, MediaURL string }
	var data map[string]any
	_ = json.Unmarshal(body, &data)
	v.ID, _ = data["id"].(string)
	v.MediaURL, _ = data["media_url"].(string)
	return v.ID, v.MediaURL
}
func (f fixture) baseline(t *testing.T, id string, at time.Time, position float64, playing bool) {
	t.Helper()
	_, err := f.pool.Exec(context.Background(), `UPDATE playback_sessions SET baseline_at=$2,baseline_position=$3,position=$3,baseline_playing=$4,baseline_visible=true WHERE id=$1`, id, at, position, playing)
	if err != nil {
		t.Fatal(err)
	}
}
func (f fixture) pulse(t *testing.T, user, id string, p Pulse) Ack {
	t.Helper()
	code, body := f.call(t, user, "POST", "/api/v1/playback/sessions/"+id+"/pulse", p)
	if code != 200 {
		t.Fatalf("pulse %d %s", code, body)
	}
	var ack Ack
	if err := json.Unmarshal(body, &ack); err != nil {
		t.Fatal(err)
	}
	return ack
}
func TestDuplicateConcurrentPulseCreditsOnce(t *testing.T) {
	f := setup(t)
	id, _ := f.open(t, "alice", false)
	f.baseline(t, id, f.now.Add(-10*time.Second), 0, true)
	f.svc.Now = func() time.Time { return f.now }
	p := Pulse{Sequence: 1, Kind: "heartbeat", Position: 10, ElapsedSeconds: 10, PlaybackRate: 1, Playing: true, Visible: true}
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); f.pulse(t, "alice", id, p) }()
	}
	wg.Wait()
	var seconds float64
	if err := f.pool.QueryRow(context.Background(), `SELECT watched_seconds FROM playback_totals WHERE user_id='alice' AND lesson_id='lesson'`).Scan(&seconds); err != nil || seconds != 10 {
		t.Fatalf("duplicate credit%v err%v", seconds, err)
	}
}
func TestTakeoverAndRevokeDenyMedia(t *testing.T) {
	f := setup(t)
	id, path := f.open(t, "alice", false)
	p := identity.Principal{UserID: "alice", SessionID: "aliceauth", Role: "student"}
	u, _ := url.Parse(path)
	if _, err := f.svc.AuthorizeMedia(context.Background(), p, id, u.Query().Get("t")); err != nil {
		t.Fatal(err)
	}
	code, _ := f.call(t, "alice", "POST", "/api/v1/playback/sessions", map[string]any{"lesson_id": "lesson"})
	if code != 409 {
		t.Fatalf("missing conflict%d", code)
	}
	next, nextPath := f.open(t, "alice", true)
	if _, err := f.svc.AuthorizeMedia(context.Background(), p, id, u.Query().Get("t")); err == nil {
		t.Fatal("old media remained valid")
	}
	if _, err := f.svc.AuthorizeMedia(context.Background(), identity.Principal{UserID: "bob", SessionID: "bobauth"}, next, u.Query().Get("t")); err == nil {
		t.Fatal("other user media allowed")
	}
	if _, err := f.pool.Exec(context.Background(), `UPDATE auth_sessions SET revoked_at=now()WHERE id='aliceauth'`); err != nil {
		t.Fatal(err)
	}
	nextURL, _ := url.Parse(nextPath)
	if _, err := f.svc.AuthorizeMedia(context.Background(), p, next, nextURL.Query().Get("t")); err == nil {
		t.Fatal("revoked media valid")
	}
	active, err := f.svc.Active(context.Background(), next)
	if err != nil || active {
		t.Fatalf("revoked streamactive%v err%v", active, err)
	}
}
func TestHiddenNeedsDeliberateClaimAndFreshBaseline(t *testing.T) {
	f := setup(t)
	id, _ := f.open(t, "alice", false)
	f.baseline(t, id, f.now.Add(-10*time.Second), 0, true)
	f.svc.Now = func() time.Time { return f.now }
	p := Pulse{Sequence: 1, Kind: "hidden", Position: 10, ElapsedSeconds: 10, PlaybackRate: 1, Visible: false}
	ack := f.pulse(t, "alice", id, p)
	if ack.Owner || ack.WatchedSeconds != 10 {
		t.Fatalf("hidden ack%#v", ack)
	}
	p.Sequence = 2
	p.Kind = "heartbeat"
	p.Visible = true
	p.Playing = true
	p.Position = 20
	ack = f.pulse(t, "alice", id, p)
	if ack.Owner || ack.Position != 10 || ack.WatchedSeconds != 10 {
		t.Fatalf("autoclaimed%#v", ack)
	}
	code, body := f.call(t, "alice", "POST", "/api/v1/playback/sessions/"+id+"/claim", map[string]bool{"take_over": false})
	if code != 200 {
		t.Fatalf("claim%d %s", code, body)
	}
	p.Sequence = 3
	p.Kind = "playing"
	ack = f.pulse(t, "alice", id, p)
	if !ack.Owner || ack.WatchedSeconds != 10 {
		t.Fatalf("baseline double counted%#v", ack)
	}
}
func TestSeekingAndCrossSessionCoverage(t *testing.T) {
	f := setup(t)
	id, _ := f.open(t, "alice", false)
	f.baseline(t, id, f.now.Add(-10*time.Second), 0, true)
	f.svc.Now = func() time.Time { return f.now }
	ack := f.pulse(t, "alice", id, Pulse{Sequence: 1, Kind: "heartbeat", Position: 10, ElapsedSeconds: 10, PlaybackRate: 1, Playing: true, Visible: true})
	if ack.Coverage != 10 {
		t.Fatalf("coverage%v", ack.Coverage)
	}
	ack = f.pulse(t, "alice", id, Pulse{Sequence: 2, Kind: "seek", Position: 95, ElapsedSeconds: 10, PlaybackRate: 1, Visible: true})
	if ack.Coverage != 10 || ack.Completed {
		t.Fatalf("seek credit%#v", ack)
	}
	next, _ := f.open(t, "alice", true)
	ack = f.pulse(t, "alice", next, Pulse{Sequence: 1, Kind: "ended", Position: 100, PlaybackRate: 1, Visible: true})
	if ack.Coverage != 10 || ack.Completed || ack.WatchedSeconds != 10 {
		t.Fatalf("cross-session coverage lost or invented%#v", ack)
	}
}

func TestReleaseClosedSessionSucceeds(t *testing.T) {
	f := setup(t)
	id, _ := f.open(t, "alice", false)
	f.baseline(t, id, f.now.Add(-10*time.Second), 0, true)
	f.svc.Now = func() time.Time { return f.now }
	_ = f.pulse(t, "alice", id, Pulse{Sequence: 1, Kind: "close", Visible: false, PlaybackRate: 1})
	code, body := f.call(t, "alice", "POST", "/api/v1/playback/sessions/"+id+"/release", nil)
	if code != 200 {
		t.Fatalf("release closed session failed: %d %s", code, body)
	}
	var owner bool
	_ = f.pool.QueryRow(context.Background(), `SELECT EXISTS(SELECT 1 FROM playback_leases WHERE user_id='alice' AND session_id=$1)`, id).Scan(&owner)
	if owner {
		t.Fatal("lease still exists after release")
	}
}
