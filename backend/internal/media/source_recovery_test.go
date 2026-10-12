package media

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"courseforge/backend/internal/playback"
)

type refreshingResolver struct {
	mu            sync.Mutex
	target        Target
	next          Target
	invalidations int
}

func (r *refreshingResolver) Resolve(context.Context, playback.Source) (Target, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.target, nil
}
func (r *refreshingResolver) Invalidate(source playback.Source, target Target) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if source.LessonID == "lesson" && r.target == target {
		r.invalidations++
		r.target = r.next
	}
}

func TestExpiredProviderTargetCanBeResolvedOnNextAuthorizedRequest(t *testing.T) {
	for _, status := range []int{401, 403, 404, 410} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/expired" {
					w.WriteHeader(status)
					return
				}
				w.Header().Set("Content-Type", "video/mp4")
				w.Header().Set("Content-Range", "bytes 0-3/4")
				w.WriteHeader(206)
				_, _ = w.Write([]byte("live"))
			}))
			defer upstream.Close()
			resolver := &refreshingResolver{target: Target{URL: upstream.URL + "/expired"}, next: Target{URL: upstream.URL + "/fresh"}}
			a := &testAuthority{}
			a.active.Store(true)
			gateway := New(a, resolver, Config{MaxTransfers: 1, RevalidateEvery: time.Second, SimulatorOrigin: upstream.URL})
			defer gateway.Close()
			first := httptest.NewRecorder()
			wrapGateway(gateway).ServeHTTP(first, httptest.NewRequest("GET", "/?t=opaque", nil))
			if first.Code != 503 {
				t.Fatalf("expired source status=%d", first.Code)
			}
			second := httptest.NewRecorder()
			wrapGateway(gateway).ServeHTTP(second, httptest.NewRequest("GET", "/?t=opaque", nil))
			if second.Code != 206 || second.Body.String() != "live" || resolver.invalidations != 1 {
				t.Fatalf("fresh authorized retry status=%d invalidations=%d", second.Code, resolver.invalidations)
			}
		})
	}
}

func TestSourceInvalidationPreservesNewerAndUnrelatedCacheEntries(t *testing.T) {
	resolver := NewOdysee(nil)
	defer resolver.Close()
	source := playback.Source{ClaimName: "lesson", ClaimID: "synthetic"}
	old := Target{URL: "https://secure.odycdn.com/old"}
	fresh := Target{URL: "https://secure.odycdn.com/fresh"}
	resolver.cache["lesson:synthetic"] = cached{Target: fresh, Expires: time.Now().Add(time.Minute)}
	resolver.cache["other:synthetic"] = cached{Target: old, Expires: time.Now().Add(time.Minute)}
	resolver.Invalidate(source, old)
	if len(resolver.cache) != 2 {
		t.Fatal("stale request invalidated a newer source")
	}
	resolver.Invalidate(source, fresh)
	if len(resolver.cache) != 1 || resolver.cache["other:synthetic"].Target != old {
		t.Fatal("source invalidation affected another lesson")
	}
}
