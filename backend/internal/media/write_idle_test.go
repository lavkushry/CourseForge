package media

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestDefaultClientWriteIdleBudget(t *testing.T) {
	t.Parallel()
	g := New(&testAuthority{}, FixedResolver{}, Config{})
	t.Cleanup(g.Close)
	if g.config.ClientWriteIdle != 30*time.Second {
		t.Fatalf("default client write idle %v want 30s", g.config.ClientWriteIdle)
	}
}

func TestClientWriteIdleOverrideHonored(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "video/mp4")
		w.Header().Set("Content-Range", "bytes 0-3/4")
		w.Header().Set("Content-Length", "4")
		w.WriteHeader(206)
		_, _ = w.Write([]byte("abcd"))
	}))
	t.Cleanup(upstream.Close)
	a := &testAuthority{}
	a.active.Store(true)
	g := New(a, FixedResolver{Target: Target{URL: upstream.URL + "/video", Referer: "https://odysee.com/"}}, Config{
		MaxTransfers: 1, RevalidateEvery: time.Second, SimulatorOrigin: upstream.URL, ClientWriteIdle: 2 * time.Second,
	})
	t.Cleanup(g.Close)
	if g.config.ClientWriteIdle != 2*time.Second {
		t.Fatalf("override %v", g.config.ClientWriteIdle)
	}
	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/", nil)
	req.Header.Set("Range", "bytes=0-3")
	wrapGateway(g).ServeHTTP(w, req)
	if w.Code != 206 {
		t.Fatalf("status %d", w.Code)
	}
	if len(g.slots) != 0 {
		t.Fatal("transfer slot leaked after short-body proxy")
	}
}
