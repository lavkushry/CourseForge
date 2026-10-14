package media

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"courseforge/backend/internal/identity"
	"courseforge/backend/internal/playback"
)

type testAuthority struct {
	active atomic.Bool
	denied bool
}

func (a *testAuthority) AuthorizeMedia(context.Context, identity.Principal, string, string) (playback.Source, error) {
	if a.denied {
		return playback.Source{}, playback.ErrDenied
	}
	return playback.Source{LessonID: "lesson"}, nil
}
func (a *testAuthority) Active(context.Context, string) (bool, error) { return a.active.Load(), nil }
func wrapGateway(g *Gateway) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.SetPathValue("id", "session")
		r = r.WithContext(identity.WithPrincipal(r.Context(), identity.Principal{UserID: "alice", SessionID: "auth"}))
		g.ServeHTTP(w, r)
	})
}
func newTestGateway(t *testing.T, upstream *httptest.Server, a *testAuthority, slots int, interval time.Duration) *Gateway {
	t.Helper()
	g := New(a, FixedResolver{Target: Target{URL: upstream.URL + "/video", Referer: "https://odysee.com/"}}, Config{MaxTransfers: slots, RevalidateEvery: interval, SimulatorOrigin: upstream.URL})
	t.Cleanup(g.Close)
	return g
}

func TestRangeAndCredentialBoundary(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Cookie") != "" || r.Header.Get("X-CSRF-Token") != "" || r.Header.Get("Authorization") != "" {
			t.Error("client credentials forwarded")
		}
		if r.Header.Get("Range") != "bytes=2-5" {
			t.Errorf("wrong range %q", r.Header.Get("Range"))
		}
		w.Header().Set("Content-Type", "video/mp4")
		w.Header().Set("Content-Range", "bytes 2-5/10")
		w.Header().Set("Content-Length", "4")
		w.WriteHeader(206)
		if r.Method != "HEAD" {
			_, _ = w.Write([]byte("2345"))
		}
	}))
	defer upstream.Close()
	a := &testAuthority{}
	a.active.Store(true)
	g := newTestGateway(t, upstream, a, 2, time.Second)
	server := httptest.NewServer(wrapGateway(g))
	defer server.Close()
	for _, method := range []string{"GET", "HEAD"} {
		r, _ := http.NewRequest(method, server.URL+"?t=opaque", nil)
		r.Header.Set("Range", "bytes=2-5")
		r.Header.Set("Cookie", "private=secret")
		r.Header.Set("Authorization", "private")
		r.Header.Set("X-CSRF-Token", "private")
		res, err := server.Client().Do(r)
		if err != nil {
			t.Fatal(err)
		}
		b, err := io.ReadAll(res.Body)
		res.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		if res.StatusCode != 206 || res.Header.Get("Content-Range") != "bytes 2-5/10" || !strings.Contains(res.Header.Get("Cache-Control"), "no-store") {
			t.Fatalf("response %d %#v", res.StatusCode, res.Header)
		}
		if method == "GET" && string(b) != "2345" {
			t.Fatalf("body %q", b)
		}
		if method == "HEAD" && len(b) != 0 {
			t.Fatal("HEAD body")
		}
	}
}
func TestDeniedAndMalformedRangesNeverReachProvider(t *testing.T) {
	var requests atomic.Int64
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { requests.Add(1) }))
	defer upstream.Close()
	a := &testAuthority{}
	a.active.Store(true)
	g := newTestGateway(t, upstream, a, 1, time.Second)
	for _, rangeValue := range []string{"bytes=1-2,5-6", "bytes=hello", "bytes=99999999999999999-"} {
		r := httptest.NewRequest("GET", "/?t=opaque", nil)
		r.Header.Set("Range", rangeValue)
		w := httptest.NewRecorder()
		wrapGateway(g).ServeHTTP(w, r)
		if w.Code != 416 {
			t.Fatalf("range %s status%d", rangeValue, w.Code)
		}
	}
	a.denied = true
	w := httptest.NewRecorder()
	wrapGateway(g).ServeHTTP(w, httptest.NewRequest("GET", "/?t=opaque", nil))
	if w.Code != 403 || requests.Load() != 0 {
		t.Fatalf("denied response%d providercalls%d", w.Code, requests.Load())
	}
}
func TestRedirectCannotEscapeConfiguredProvider(t *testing.T) {
	var escaped atomic.Int64
	hostile := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { escaped.Add(1) }))
	defer hostile.Close()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, hostile.URL, http.StatusFound) }))
	defer upstream.Close()
	a := &testAuthority{}
	a.active.Store(true)
	g := newTestGateway(t, upstream, a, 1, time.Second)
	w := httptest.NewRecorder()
	wrapGateway(g).ServeHTTP(w, httptest.NewRequest("GET", "/", nil))
	if w.Code != 503 || escaped.Load() != 0 {
		t.Fatalf("unsafe redirect status%d requests%d", w.Code, escaped.Load())
	}
}
func TestRevocationCancelsSilentUpstreamAndReleasesSlot(t *testing.T) {
	started := make(chan struct{})
	closed := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "video/mp4")
		w.WriteHeader(206)
		w.(http.Flusher).Flush()
		close(started)
		<-r.Context().Done()
		close(closed)
	}))
	defer upstream.Close()
	a := &testAuthority{}
	a.active.Store(true)
	g := newTestGateway(t, upstream, a, 1, 20*time.Millisecond)
	done := make(chan struct{})
	go func() {
		defer close(done)
		wrapGateway(g).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/", nil))
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("upstream did not start")
	}
	a.active.Store(false)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("revoked silent stream did not stop")
	}
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("upstream request not cancelled")
	}
	if len(g.slots) != 0 {
		t.Fatal("transfer slot leaked")
	}
}
func TestAdmissionRejectsWithoutUnboundedQueue(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("upstream entered despite full budget") }))
	defer upstream.Close()
	a := &testAuthority{}
	a.active.Store(true)
	g := newTestGateway(t, upstream, a, 1, time.Second)
	g.slots <- struct{}{}
	w := httptest.NewRecorder()
	wrapGateway(g).ServeHTTP(w, httptest.NewRequest("GET", "/", nil))
	<-g.slots
	if w.Code != 503 || w.Header().Get("Retry-After") == "" {
		t.Fatalf("overload response%d", w.Code)
	}
}

func TestRevocationInterruptsBlockedDownstreamWrite(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "video/mp4")
		w.WriteHeader(206)
		block := make([]byte, 128<<10)
		for r.Context().Err() == nil {
			if _, err := w.Write(block); err != nil {
				return
			}
		}
	}))
	defer upstream.Close()
	a := &testAuthority{}
	a.active.Store(true)
	g := newTestGateway(t, upstream, a, 1, 20*time.Millisecond)
	done := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(done)
		wrapGateway(g).ServeHTTP(w, r)
	}))
	defer server.Close()
	conn, err := net.DialTimeout("tcp", server.Listener.Addr().String(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if tcp, ok := conn.(*net.TCPConn); ok {
		_ = tcp.SetReadBuffer(1024)
	}
	// Deliberately never read the response. Fill the socket until Write blocks.
	_, err = io.WriteString(conn, "GET /?t=opaque HTTP/1.1\r\nHost: local\r\n\r\n")
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(150 * time.Millisecond)
	select {
	case <-done:
		t.Fatal("stream ended before revocation")
	default:
	}
	a.active.Store(false)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("blocked downstream write survived revocation")
	}
	if len(g.slots) != 0 {
		t.Fatal("blocked downstream retained transfer slot")
	}
}
func TestDefaultURLRestrictions(t *testing.T) {
	g := &Gateway{}
	for _, raw := range []string{"http://secure.odycdn.com/a", "https://evil.example/a", "https://secure.odycdn.com:444/a", "https://user:pass@secure.odycdn.com/a", "https://secure.odycdn.com/a#fragment"} {
		if g.valid(raw) {
			t.Errorf("accepted %s", raw)
		}
	}
	if !g.valid("https://secure.odycdn.com/a?t=provider-signature") {
		t.Fatal("valid source rejected")
	}
}

func TestLocalFileRangeStreaming(t *testing.T) {
	tmpDir := t.TempDir()
	sampleVideo := filepath.Join(tmpDir, "sample.mp4")
	data := []byte("0123456789abcdefghijklmnopqrstuvwxyz")
	if err := os.WriteFile(sampleVideo, data, 0644); err != nil {
		t.Fatal(err)
	}

	a := &testAuthority{}
	a.active.Store(true)
	g := New(a, FixedResolver{Target: Target{URL: "file://" + sampleVideo}}, Config{MaxTransfers: 2, RevalidateEvery: time.Second})
	t.Cleanup(g.Close)

	server := httptest.NewServer(wrapGateway(g))
	defer server.Close()

	r, _ := http.NewRequest("GET", server.URL+"?t=opaque", nil)
	r.Header.Set("Range", "bytes=4-10")
	res, err := server.Client().Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()

	if res.StatusCode != 206 {
		t.Fatalf("expected 206, got %d", res.StatusCode)
	}
	if res.Header.Get("Content-Type") != "video/mp4" {
		t.Fatalf("expected video/mp4, got %s", res.Header.Get("Content-Type"))
	}
	body, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	expected := "456789a"
	if string(body) != expected {
		t.Fatalf("expected %q, got %q", expected, string(body))
	}
}
