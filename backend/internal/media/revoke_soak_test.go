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
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"courseforge/backend/internal/identity"
	"courseforge/backend/internal/playback"
	"courseforge/backend/internal/testutil"
)

// TestGatewayRevokeSoakUnderConcurrentTransfers runs N concurrent authorize-then-proxy
// Range streams on one real playback lease, deletes the lease, and asserts every
// transfer cancels within the ≤10s capacity gate. Media-plane evidence only.
func TestGatewayRevokeSoakUnderConcurrentTransfers(t *testing.T) {
	const n = 8
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

	var live atomic.Int64
	started := make(chan struct{}, n)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "video/mp4")
		w.WriteHeader(206)
		w.(http.Flusher).Flush()
		live.Add(1)
		started <- struct{}{}
		<-r.Context().Done()
		live.Add(-1)
	}))
	defer upstream.Close()

	g := New(player, FixedResolver{Target: Target{URL: upstream.URL + "/video", Referer: "https://odysee.com/"}},
		Config{MaxTransfers: n + 2, RevalidateEvery: 3 * time.Second, SimulatorOrigin: upstream.URL})
	t.Cleanup(g.Close)

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

	for i := 0; i < n; i++ {
		select {
		case <-started:
		case <-time.After(3 * time.Second):
			t.Fatalf("only %d/%d upstreams started", i, n)
		}
	}
	if live.Load() != int64(n) {
		t.Fatalf("live streams %d want %d", live.Load(), n)
	}

	if _, err := pool.Exec(ctx, `DELETE FROM playback_leases WHERE session_id=$1`, opened.ID); err != nil {
		t.Fatal(err)
	}
	revokedAt := time.Now()
	wait := make(chan struct{})
	go func() {
		wg.Wait()
		close(wait)
	}()
	select {
	case <-wait:
	case <-time.After(11 * time.Second):
		t.Fatal("revoke soak: transfers still running after 11s")
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
		t.Fatalf("media revoke soak max cancel %v exceeds 10s gate", maxElapsed)
	}
	// Upstream handlers may decrement live slightly after ServeHTTP returns; wait briefly.
	deadline := time.Now().Add(2 * time.Second)
	for live.Load() != 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if live.Load() != 0 || len(g.slots) != 0 {
		t.Fatalf("leak after soak: live=%d slots=%d maxCancel=%v", live.Load(), len(g.slots), maxElapsed)
	}
	t.Logf("media revoke soak: concurrent=%d max_cancel=%v revalidate=%v", n, maxElapsed, g.config.RevalidateEvery)
}
