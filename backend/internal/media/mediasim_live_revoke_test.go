package media

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"sync"
	"testing"
	"time"

	"courseforge/backend/internal/identity"
	"courseforge/backend/internal/playback"
	"courseforge/backend/internal/testutil"
)

// TestGatewayRevokeAgainstLiveMediaSim optionally proxies Range bytes from a
// running mediasim (default http://127.0.0.1:18092/media.mp4) and asserts lease
// delete cancels within ≤10s. Skips when mediasim is unreachable. Not Odysee.
func TestGatewayRevokeAgainstLiveMediaSim(t *testing.T) {
	// Prefer the stall fault so transfers stay open until lease revoke cancels them.
	simURL := os.Getenv("CF_LIVE_MEDIASIM_URL")
	if simURL == "" {
		simURL = "http://127.0.0.1:18092/fault/stall"
	}
	base := simURL
	if u, err := url.Parse(simURL); err == nil {
		base = u.Scheme + "://" + u.Host
	}
	res, err := http.Get(base + "/healthz")
	if err != nil {
		t.Skipf("mediasim unreachable at %s: %v", base, err)
	}
	io.Copy(io.Discard, res.Body)
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Skipf("mediasim health %s status %d", base, res.StatusCode)
	}

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
		t.Fatalf("open: %d %s", openRec.Code, openRec.Body.String())
	}
	var opened struct {
		ID       string `json:"id"`
		MediaURL string `json:"media_url"`
	}
	if err := json.Unmarshal(openRec.Body.Bytes(), &opened); err != nil {
		t.Fatal(err)
	}
	mediaURL, err := url.Parse(opened.MediaURL)
	if err != nil {
		t.Fatal(err)
	}
	token := mediaURL.Query().Get("t")
	u, err := url.Parse(simURL)
	if err != nil {
		t.Fatal(err)
	}
	origin := u.Scheme + "://" + u.Host
	g := New(player, FixedResolver{Target: Target{URL: simURL, Referer: "https://odysee.com/"}},
		Config{MaxTransfers: 4, RevalidateEvery: 3 * time.Second, SimulatorOrigin: origin, ClientWriteIdle: 30 * time.Second})
	t.Cleanup(g.Close)

	const n = 4
	var wg sync.WaitGroup
	doneAt := make([]time.Time, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			req := httptest.NewRequest("GET", "/?t="+token, nil)
			req.Header.Set("Range", "bytes=0-")
			req.SetPathValue("id", opened.ID)
			req = req.WithContext(identity.WithPrincipal(req.Context(), identity.Principal{
				UserID: "alice", SessionID: "aliceauth", Role: "student",
			}))
			g.ServeHTTP(httptest.NewRecorder(), req)
			doneAt[i] = time.Now()
		}(i)
	}
	time.Sleep(200 * time.Millisecond)
	if _, err := pool.Exec(ctx, `DELETE FROM playback_leases WHERE session_id=$1`, opened.ID); err != nil {
		t.Fatal(err)
	}
	revokedAt := time.Now()
	wait := make(chan struct{})
	go func() { wg.Wait(); close(wait) }()
	select {
	case <-wait:
	case <-time.After(11 * time.Second):
		t.Fatal("mediasim revoke: transfers still running after 11s")
	}
	var maxElapsed time.Duration
	for _, at := range doneAt {
		if at.IsZero() {
			t.Fatal("missing done timestamp")
		}
		if d := at.Sub(revokedAt); d > maxElapsed {
			maxElapsed = d
		}
	}
	if maxElapsed > 10*time.Second {
		t.Fatalf("mediasim revoke max cancel %v exceeds 10s", maxElapsed)
	}
	t.Logf("mediasim live revoke: concurrent=%d max_cancel=%v url=%s", n, maxElapsed, simURL)
}
