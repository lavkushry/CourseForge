package media

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"courseforge/backend/internal/identity"
	"courseforge/backend/internal/playback"
	"courseforge/backend/internal/testutil"
)

// TestGatewayRevokesWhenPlaybackLeaseDeleted proves the authorize-then-proxy path
// cancels within the ≤10s capacity gate when the authoritative playback lease is
// removed — not only when a mock Active() flips.
func TestGatewayRevokesWhenPlaybackLeaseDeleted(t *testing.T) {
	pool := testutil.Postgres(t)
	ctx := context.Background()
	tokenHash := sha256.Sum256([]byte("alicetoken"))
	digest := hex.EncodeToString(tokenHash[:])
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users(id,email,name,password_hash,verified)VALUES('alice','alice@test.example','alice','disabled',true)`, nil},
		{`INSERT INTO auth_sessions(id,user_id,token_hash,csrf_token,expires_at)VALUES('aliceauth','alice',$1,'csrf',now()+interval '1 hour')`, []any{digest}},
		{`INSERT INTO courses(id,title,published)VALUES('course','Course',true)`, nil},
		{`INSERT INTO lessons(id,course_id,title,duration_seconds)VALUES('lesson','course','Lesson',100)`, nil},
		{`INSERT INTO enrollments(user_id,course_id)VALUES('alice','course')`, nil},
	} {
		if _, err := pool.Exec(ctx, q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	auth, err := identity.New(pool, identity.Config{PublicOrigin: "http://test", PasswordConcurrency: 1})
	if err != nil {
		t.Fatal(err)
	}
	player := playback.New(pool, auth)
	mux := http.NewServeMux()
	player.Register(mux)

	openReq := httptest.NewRequest("POST", "http://test/api/v1/playback/sessions",
		bytes.NewReader([]byte(`{"lesson_id":"lesson","take_over":false}`)))
	openReq.AddCookie(&http.Cookie{Name: identity.CookieName, Value: "alicetoken"})
	openReq.Header.Set("Content-Type", "application/json")
	openReq.Header.Set("X-CSRF-Token", "csrf")
	openReq.Header.Set("Origin", "http://test")
	openRec := httptest.NewRecorder()
	mux.ServeHTTP(openRec, openReq)
	if openRec.Code != 201 {
		t.Fatalf("open %d %s", openRec.Code, openRec.Body.String())
	}
	var opened struct {
		ID       string `json:"id"`
		MediaURL string `json:"media_url"`
	}
	if err := json.Unmarshal(openRec.Body.Bytes(), &opened); err != nil || opened.ID == "" {
		t.Fatalf("open payload: %v %s", err, openRec.Body.String())
	}
	mediaURL, err := url.Parse(opened.MediaURL)
	if err != nil {
		t.Fatal(err)
	}
	token := mediaURL.Query().Get("t")

	started := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "video/mp4")
		w.WriteHeader(206)
		w.(http.Flusher).Flush()
		close(started)
		<-r.Context().Done()
	}))
	defer upstream.Close()

	g := New(player, FixedResolver{Target: Target{URL: upstream.URL + "/video", Referer: "https://odysee.com/"}},
		Config{MaxTransfers: 2, RevalidateEvery: 3 * time.Second, SimulatorOrigin: upstream.URL})
	t.Cleanup(g.Close)

	done := make(chan struct{})
	go func() {
		defer close(done)
		req := httptest.NewRequest("GET", "/?t="+token, nil)
		req.SetPathValue("id", opened.ID)
		req = req.WithContext(identity.WithPrincipal(req.Context(), identity.Principal{
			UserID: "alice", SessionID: "aliceauth", Role: "student",
		}))
		g.ServeHTTP(httptest.NewRecorder(), req)
	}()
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("upstream did not start")
	}

	if _, err := pool.Exec(ctx, `DELETE FROM playback_leases WHERE session_id=$1`, opened.ID); err != nil {
		t.Fatal(err)
	}
	revokedAt := time.Now()
	select {
	case <-done:
		if elapsed := time.Since(revokedAt); elapsed > 10*time.Second {
			t.Fatalf("lease-delete revoke took %v (>10s)", elapsed)
		}
	case <-time.After(11 * time.Second):
		t.Fatal("playback-lease revoke exceeded 10s gate")
	}
	if len(g.slots) != 0 {
		t.Fatal("transfer slot leaked after lease revoke")
	}
}
