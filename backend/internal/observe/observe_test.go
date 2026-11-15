package observe

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
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
func TestWithLoopbackMetricsAllowsLoopbackOnly(t *testing.T) {
	m := New(nil)
	m.AttachAdmission(func() []AdmissionGauges {
		return []AdmissionGauges{{Class: "browse", InUse: 1, Capacity: 128, Sheds: 0}}
	})
	innerHits := 0
	h := m.WithLoopbackMetrics(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		innerHits++
		w.WriteHeader(204)
	}))

	okReq := httptest.NewRequest("GET", "/metrics", nil)
	okReq.RemoteAddr = "127.0.0.1:54321"
	ok := httptest.NewRecorder()
	h.ServeHTTP(ok, okReq)
	if ok.Code != 200 || !strings.Contains(ok.Body.String(), `courseforge_admission_capacity{class="browse"} 128`) {
		t.Fatalf("loopback metrics: code=%d body=%q", ok.Code, ok.Body.String())
	}

	denyReq := httptest.NewRequest("GET", "/metrics", nil)
	denyReq.RemoteAddr = "203.0.113.9:54321"
	denyReq.Header.Set("X-Forwarded-For", "127.0.0.1")
	deny := httptest.NewRecorder()
	h.ServeHTTP(deny, denyReq)
	if deny.Code != 404 {
		t.Fatalf("non-loopback metrics want 404, got %d", deny.Code)
	}

	other := httptest.NewRequest("GET", "/health/live", nil)
	other.RemoteAddr = "127.0.0.1:1"
	pass := httptest.NewRecorder()
	h.ServeHTTP(pass, other)
	if pass.Code != 204 || innerHits != 1 {
		t.Fatalf("non-metrics path should reach next: code=%d hits=%d", pass.Code, innerHits)
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
