package media

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"courseforge/backend/internal/identity"
)

type hlsAuthority struct {
	*testAuthority
	master string
}

func (a *hlsAuthority) HLSPaths(context.Context, string) (string, string, error) {
	return a.master, "", nil
}

func TestHLSSharesMaxTransfersBusyShed(t *testing.T) {
	dir := t.TempDir()
	master := filepath.Join(dir, "master.m3u8")
	if err := os.WriteFile(master, []byte("#EXTM3U\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	seg := filepath.Join(dir, "seg.m4s")
	if err := os.WriteFile(seg, []byte("segment-bytes"), 0o644); err != nil {
		t.Fatal(err)
	}

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "video/mp4")
		w.WriteHeader(http.StatusPartialContent)
		select {
		case <-r.Context().Done():
		case <-time.After(2 * time.Second):
		}
	}))
	t.Cleanup(upstream.Close)

	inner := &testAuthority{}
	inner.active.Store(true)
	auth := &hlsAuthority{testAuthority: inner, master: master}
	g := New(auth, FixedResolver{Target: Target{URL: upstream.URL + "/media.mp4"}}, Config{
		MaxTransfers: 1, RevalidateEvery: time.Second, SimulatorOrigin: upstream.URL, ClientWriteIdle: 5 * time.Second,
	})
	t.Cleanup(g.Close)

	withPrincipal := func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			r.SetPathValue("id", "ps_hls")
			ctx := identity.WithPrincipal(r.Context(), identity.Principal{UserID: "u1", SessionID: "s1", Role: "learner"})
			next(w, r.WithContext(ctx))
		}
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/media", withPrincipal(func(w http.ResponseWriter, r *http.Request) {
		g.ServeHTTP(w, r)
	}))
	mux.HandleFunc("/hls/", withPrincipal(func(w http.ResponseWriter, r *http.Request) {
		r.SetPathValue("path", "seg.m4s")
		g.serveHLS(w, r)
	}))
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)

	started := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		req, _ := http.NewRequest("GET", server.URL+"/media?t=opaque", nil)
		req.Header.Set("Range", "bytes=0-")
		close(started)
		res, err := server.Client().Do(req)
		if err != nil {
			return
		}
		defer res.Body.Close()
		_, _ = io.Copy(io.Discard, res.Body)
	}()
	<-started
	deadline := time.Now().Add(2 * time.Second)
	for {
		in, _ := g.TransferOccupancy()
		if in == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("progressive transfer never occupied slot")
		}
		time.Sleep(10 * time.Millisecond)
	}

	res, err := server.Client().Get(server.URL + "/hls/")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("expected HLS busy shed 503, got %d", res.StatusCode)
	}
	if res.Header.Get(MediaStatusHeader) != "busy" {
		t.Fatalf("expected busy header, got %q", res.Header.Get(MediaStatusHeader))
	}
	if g.BusySheds() < 1 {
		t.Fatalf("busy sheds=%d", g.BusySheds())
	}
	inner.active.Store(false)
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("held progressive transfer did not end")
	}
}
