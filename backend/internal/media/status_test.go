package media

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"courseforge/backend/internal/identity"
	"courseforge/backend/internal/playback"
)

type errAuthority struct{ err error }

func (a errAuthority) AuthorizeMedia(context.Context, identity.Principal, string, string) (playback.Source, error) {
	if a.err != nil {
		return playback.Source{}, a.err
	}
	return playback.Source{LessonID: "lesson"}, nil
}
func (errAuthority) Active(context.Context, string) (bool, error) { return true, nil }

type errResolver struct{ err error }

func (r errResolver) Resolve(context.Context, playback.Source) (Target, error) {
	return Target{}, r.err
}

func serveStatus(t *testing.T, a Authority, r Resolver, method string) *httptest.ResponseRecorder {
	t.Helper()
	g := New(a, r, Config{MaxTransfers: 1, RevalidateEvery: 1e9})
	t.Cleanup(g.Close)
	w := httptest.NewRecorder()
	wrapGateway(g).ServeHTTP(w, httptest.NewRequest(method, "/?t=opaque", nil))
	return w
}

func TestLostLeaseIsReclaimableConflictNotDenial(t *testing.T) {
	for _, method := range []string{"GET", "HEAD"} {
		w := serveStatus(t, errAuthority{playback.ErrConflict}, errResolver{}, method)
		if w.Code != http.StatusConflict {
			t.Fatalf("%s lost lease status %d, want 409", method, w.Code)
		}
		if method == "GET" {
			var body struct{ Code string }
			if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil || body.Code != "playback_conflict" {
				t.Fatalf("conflict body %q err %v", w.Body.String(), err)
			}
		}
	}
	if w := serveStatus(t, errAuthority{playback.ErrDenied}, errResolver{}, "HEAD"); w.Code != http.StatusForbidden {
		t.Fatalf("denied status %d, want 403", w.Code)
	}
}

func TestNoSourceIsNotReadyWithoutRetryAfter(t *testing.T) {
	gNo := New(errAuthority{}, errResolver{ErrNoSource}, Config{MaxTransfers: 1, RevalidateEvery: 1e9})
	t.Cleanup(gNo.Close)
	w := httptest.NewRecorder()
	wrapGateway(gNo).ServeHTTP(w, httptest.NewRequest("HEAD", "/?t=opaque", nil))
	if w.Code != http.StatusServiceUnavailable || w.Header().Get(MediaStatusHeader) != "no-source" || w.Header().Get("Retry-After") != "" {
		t.Fatalf("no source: %d headers %v", w.Code, w.Header())
	}
	if gNo.NoSourceSheds() != 1 || gNo.ProviderFailSheds() != 0 {
		t.Fatalf("no-source gauges: no=%d provider=%d", gNo.NoSourceSheds(), gNo.ProviderFailSheds())
	}

	gProv := New(errAuthority{}, errResolver{ErrProvider}, Config{MaxTransfers: 1, RevalidateEvery: 1e9})
	t.Cleanup(gProv.Close)
	w = httptest.NewRecorder()
	wrapGateway(gProv).ServeHTTP(w, httptest.NewRequest("HEAD", "/?t=opaque", nil))
	if w.Code != http.StatusServiceUnavailable || w.Header().Get(MediaStatusHeader) != "" || w.Header().Get("Retry-After") == "" {
		t.Fatalf("transient outage: %d headers %v", w.Code, w.Header())
	}
	if gProv.ProviderFailSheds() != 1 || gProv.NoSourceSheds() != 0 {
		t.Fatalf("provider gauges: no=%d provider=%d", gProv.NoSourceSheds(), gProv.ProviderFailSheds())
	}
	if !errors.Is(ErrNoSource, ErrProvider) {
		t.Fatal("ErrNoSource must wrap ErrProvider")
	}
	gauges := gNo.Gauges()
	if gauges.Capacity != 1 || gauges.NoSourceSheds != 1 {
		t.Fatalf("Gauges snapshot %+v", gauges)
	}
}

func TestHybridResolverDistinguishesMissingSourceFromOutage(t *testing.T) {
	h := &HybridResolver{BaseDirs: []string{t.TempDir()}}
	if _, err := h.Resolve(context.Background(), playback.Source{LessonID: "l1"}); !errors.Is(err, ErrNoSource) {
		t.Fatalf("no claim: %v, want ErrNoSource", err)
	}
}
