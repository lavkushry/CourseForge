package observe

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"courseforge/backend/internal/api"
)

func TestMetricsDoNotLabelPrivateURLOrToken(t *testing.T) {
	m := New(nil)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/lessons/{id}", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(503); _, _ = w.Write([]byte("busy")) })
	handler := m.Wrap(mux)
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Go(func() {
			handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/api/v1/lessons/private-learner-identifier?t=secret", nil))
		})
	}
	wg.Wait()
	w := httptest.NewRecorder()
	m.Handler().ServeHTTP(w, httptest.NewRequest("GET", "/metrics", nil))
	body := w.Body.String()
	for _, private := range []string{"private-learner-identifier", "secret", "?t="} {
		if strings.Contains(body, private) {
			t.Fatal("metric leaked request data")
		}
	}
	if !strings.Contains(body, `courseforge_http_requests_total{route="GET /api/v1/lessons/{id}"} 20`) || !strings.Contains(body, `courseforge_http_server_errors_total{route="GET /api/v1/lessons/{id}"} 20`) {
		t.Fatal("missing route counts", body)
	}
}
func TestProfilingListenerRejectsPublicAddresses(t *testing.T) {
	m := New(nil)
	for _, addr := range []string{"0.0.0.0:6060", ":6060", "example.com:6060", "127.0.0.1:0", "[::]:6060"} {
		if close, e := m.Start(addr); e == nil {
			close()
			t.Fatalf("accepted %s", addr)
		}
	}
}
func TestResponseControllerPassesThrough(t *testing.T) {
	m := New(nil)
	w := httptest.NewRecorder()
	m.Wrap(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(206)
		_, _ = w.Write([]byte("media"))
		if e := http.NewResponseController(w).Flush(); e != nil {
			t.Error(e)
		}
	})).ServeHTTP(w, httptest.NewRequest("GET", "/media", nil))
	if w.Code != 206 || !w.Flushed || w.Body.String() != "media" {
		t.Fatal("stream capabilities lost")
	}
}

func TestActualMiddlewarePreservesRouteLabelsAndPanicErrors(t *testing.T) {
	m := New(nil)
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
