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
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"courseforge/backend/internal/identity"
	"courseforge/backend/internal/playback"
	"courseforge/backend/internal/testutil"
)

// TestGatewayRevokeUnderConcurrentAuthLeases proves revoke is lease-scoped:
// deleting Alice's lease cancels her transfer while Bob's concurrent lease keeps streaming.
func TestGatewayRevokeUnderConcurrentAuthLeases(t *testing.T) {
	pool := testutil.Postgres(t)
	ctx := context.Background()
	for _, user := range []string{"alice", "bob"} {
		tokenHash := sha256.Sum256([]byte(user + "token"))
		digest := hex.EncodeToString(tokenHash[:])
		if _, err := pool.Exec(ctx, `INSERT INTO users(id,email,name,password_hash,verified)VALUES($1,$1||'@test.example',$1,'disabled',true)`, user); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO auth_sessions(id,user_id,token_hash,csrf_token,expires_at)VALUES($1,$2,$3,'csrf',now()+interval '1 hour')`, user+"auth", user, digest); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(ctx, `INSERT INTO courses(id,title,published)VALUES('course','Course',true);
		INSERT INTO lessons(id,course_id,title,duration_seconds)VALUES('lesson','course','Lesson',100);
		INSERT INTO enrollments(user_id,course_id)VALUES('alice','course'),('bob','course')`); err != nil {
		t.Fatal(err)
	}
	auth, err := identity.New(pool, identity.Config{PublicOrigin: "http://test", PasswordConcurrency: 1})
	if err != nil {
		t.Fatal(err)
	}
	player := playback.New(pool, auth)
	mux := http.NewServeMux()
	player.Register(mux)

	open := func(user string) (id, token string) {
		t.Helper()
		req := httptest.NewRequest("POST", "http://test/api/v1/playback/sessions",
			bytes.NewReader([]byte(`{"lesson_id":"lesson","take_over":false}`)))
		req.AddCookie(&http.Cookie{Name: identity.CookieName, Value: user + "token"})
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-CSRF-Token", "csrf")
		req.Header.Set("Origin", "http://test")
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != 201 {
			t.Fatalf("open %s: %d %s", user, rec.Code, rec.Body.String())
		}
		var opened struct {
			ID       string `json:"id"`
			MediaURL string `json:"media_url"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &opened); err != nil {
			t.Fatal(err)
		}
		u, err := url.Parse(opened.MediaURL)
		if err != nil {
			t.Fatal(err)
		}
		return opened.ID, u.Query().Get("t")
	}
	aliceID, aliceTok := open("alice")
	bobID, bobTok := open("bob")

	var aliceLive, bobLive atomic.Int64
	aliceStarted, bobStarted := make(chan struct{}), make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "video/mp4")
		w.WriteHeader(206)
		w.(http.Flusher).Flush()
		switch {
		case strings.Contains(r.URL.Path, "alice"):
			aliceLive.Add(1)
			close(aliceStarted)
			<-r.Context().Done()
			aliceLive.Add(-1)
		case strings.Contains(r.URL.Path, "bob"):
			bobLive.Add(1)
			close(bobStarted)
			<-r.Context().Done()
			bobLive.Add(-1)
		}
	}))
	t.Cleanup(upstream.Close)

	aliceG := New(player, FixedResolver{Target: Target{URL: upstream.URL + "/alice", Referer: "https://odysee.com/"}},
		Config{MaxTransfers: 2, RevalidateEvery: 3 * time.Second, SimulatorOrigin: upstream.URL})
	bobG := New(player, FixedResolver{Target: Target{URL: upstream.URL + "/bob", Referer: "https://odysee.com/"}},
		Config{MaxTransfers: 2, RevalidateEvery: 3 * time.Second, SimulatorOrigin: upstream.URL})
	t.Cleanup(aliceG.Close)
	t.Cleanup(bobG.Close)

	var aliceDone, bobDone sync.WaitGroup
	aliceDone.Add(1)
	bobDone.Add(1)
	go func() {
		defer aliceDone.Done()
		req := httptest.NewRequest("GET", "/?t="+aliceTok, nil)
		req.Header.Set("Range", "bytes=0-")
		req.SetPathValue("id", aliceID)
		req = req.WithContext(identity.WithPrincipal(req.Context(), identity.Principal{UserID: "alice", SessionID: "aliceauth"}))
		aliceG.ServeHTTP(httptest.NewRecorder(), req)
	}()
	go func() {
		defer bobDone.Done()
		req := httptest.NewRequest("GET", "/?t="+bobTok, nil)
		req.Header.Set("Range", "bytes=0-")
		req.SetPathValue("id", bobID)
		req = req.WithContext(identity.WithPrincipal(req.Context(), identity.Principal{UserID: "bob", SessionID: "bobauth"}))
		bobG.ServeHTTP(httptest.NewRecorder(), req)
	}()

	select {
	case <-aliceStarted:
	case <-time.After(3 * time.Second):
		t.Fatal("alice stream not started")
	}
	select {
	case <-bobStarted:
	case <-time.After(3 * time.Second):
		t.Fatal("bob stream not started")
	}

	if _, err := pool.Exec(ctx, `DELETE FROM playback_leases WHERE session_id=$1`, aliceID); err != nil {
		t.Fatal(err)
	}
	revokedAt := time.Now()
	waitAlice := make(chan struct{})
	go func() { aliceDone.Wait(); close(waitAlice) }()
	select {
	case <-waitAlice:
		if elapsed := time.Since(revokedAt); elapsed > 10*time.Second {
			t.Fatalf("alice cancel %v exceeds 10s", elapsed)
		}
	case <-time.After(11 * time.Second):
		t.Fatal("alice transfer not canceled")
	}
	if bobLive.Load() != 1 {
		t.Fatalf("bob should still be live after alice revoke, live=%d", bobLive.Load())
	}
	if _, err := pool.Exec(ctx, `DELETE FROM playback_leases WHERE session_id=$1`, bobID); err != nil {
		t.Fatal(err)
	}
	waitBob := make(chan struct{})
	go func() { bobDone.Wait(); close(waitBob) }()
	select {
	case <-waitBob:
	case <-time.After(11 * time.Second):
		t.Fatal("bob transfer not canceled")
	}
	deadline := time.Now().Add(2 * time.Second)
	for (aliceLive.Load() != 0 || bobLive.Load() != 0) && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if aliceLive.Load() != 0 || bobLive.Load() != 0 || len(aliceG.slots) != 0 || len(bobG.slots) != 0 {
		t.Fatalf("leak alice=%d bob=%d slots=%d/%d", aliceLive.Load(), bobLive.Load(), len(aliceG.slots), len(bobG.slots))
	}
	t.Logf("sibling-lease revoke: alice canceled under 10s; bob stayed live until its own lease delete")
}
