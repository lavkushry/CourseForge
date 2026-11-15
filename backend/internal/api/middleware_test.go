package api_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"courseforge/backend/internal/api"
	"courseforge/backend/internal/observe"
)

func TestPlaybackSessionFromPathIgnoresTokens(t *testing.T) {
	t.Parallel()
	if got := api.PlaybackSessionFromPath("/api/v1/playback/sessions/ps_abc123/media"); got != "ps_abc123" {
		t.Fatal(got)
	}
	if got := api.PlaybackSessionFromPath("/api/v1/playback/sessions/ps_abc123/hls/master.m3u8"); got != "ps_abc123" {
		t.Fatal(got)
	}
	if got := api.PlaybackSessionFromPath("/api/v1/public/courses"); got != "" {
		t.Fatal("non-playback path")
	}
	if got := api.PlaybackSessionFromPath("/api/v1/playback/sessions/evil;drop/media"); got != "" {
		t.Fatal("rejected bad id", got)
	}
}

func TestMiddlewarePropagatesPlaybackSessionWithoutQueryToken(t *testing.T) {
	t.Parallel()
	var seen string
	h := api.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen, _ = api.PlaybackSessionFromContext(r.Context())
		w.WriteHeader(200)
	}), time.Second)
	req := httptest.NewRequest("GET", "/api/v1/playback/sessions/ps_corr42/media?t=odysee-secret-token", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Header().Get("X-CourseForge-Playback-Session") != "ps_corr42" {
		t.Fatal(w.Header().Get("X-CourseForge-Playback-Session"))
	}
	if w.Header().Get("X-Request-ID") == "" {
		t.Fatal("missing request id")
	}
	if seen != "ps_corr42" {
		t.Fatal("context missing session", seen)
	}
	for _, hname := range []string{"X-CourseForge-Playback-Session", "X-Request-ID"} {
		if v := w.Header().Get(hname); strings.Contains(v, "odysee-secret") {
			t.Fatal("token leaked into", hname, v)
		}
	}
}

func TestActualMiddlewarePreservesRouteLabelsAndPanicErrors(t *testing.T) {
	m := observe.New(nil)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /synthetic/{id}", func(w http.ResponseWriter, r *http.Request) { panic("synthetic failure") })
	handler := api.Middleware(m.Wrap(mux), time.Second)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest("GET", "/synthetic/private-id?t=opaque", nil))
	if w.Code != 500 {
		t.Fatalf("panic response%d", w.Code)
	}
	metrics := httptest.NewRecorder()
	m.Handler().ServeHTTP(metrics, httptest.NewRequest("GET", "/metrics", nil))
	if !strings.Contains(metrics.Body.String(), `courseforge_http_server_errors_total{route="GET /synthetic/{id}"} 1`) {
		t.Fatal("cloned request lost route/error labels", metrics.Body.String())
	}
	if strings.Contains(metrics.Body.String(), "private-id") || strings.Contains(metrics.Body.String(), "opaque") {
		t.Fatal("private URL entered labels")
	}
}
