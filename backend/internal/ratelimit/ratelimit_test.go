package ratelimit_test

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"courseforge/backend/internal/ratelimit"
)

func TestTokenBucketAllowsBurstThenLimits(t *testing.T) {
	t.Parallel()
	now := time.Unix(0, 0)
	l := ratelimit.New(ratelimit.Config{
		Enabled: true,
		RPS:     1,
		Burst:   2,
		Now:     func() time.Time { return now },
	})
	if !l.Allow("1.1.1.1") {
		t.Fatal("first burst token not granted")
	}
	if !l.Allow("1.1.1.1") {
		t.Fatal("second burst token not granted")
	}
	if l.Allow("1.1.1.1") {
		t.Fatal("expected limit after burst")
	}
	now = now.Add(time.Second)
	if !l.Allow("1.1.1.1") {
		t.Fatal("token not refilled")
	}
}

func TestMiddlewareExemptsHealth(t *testing.T) {
	t.Parallel()
	l := ratelimit.New(ratelimit.Config{Enabled: true, RPS: 1, Burst: 1})
	// Exhaust the bucket for the test client IP.
	_ = l.Allow("192.0.2.1")
	var hit int
	h := l.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hit++
		w.WriteHeader(200)
	}))
	req := httptest.NewRequest("GET", "/health/ready", nil)
	req.RemoteAddr = "192.0.2.1:1234"
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 200 || hit != 1 {
		t.Fatal("health not exempt")
	}
	req = httptest.NewRequest("GET", "/api/v1/public/courses", nil)
	req.RemoteAddr = "192.0.2.1:1234"
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 429 {
		t.Fatalf("expected 429, got %d", w.Code)
	}
}

func TestClientIPTrustProxy(t *testing.T) {
	t.Parallel()
	req := httptest.NewRequest("GET", "/", nil)
	req.RemoteAddr = "10.0.0.1:99"
	req.Header.Set("X-Forwarded-For", "203.0.113.9, 10.0.0.1")
	if got := ratelimit.ClientIP(req, false); got != "10.0.0.1" {
		t.Fatal(got)
	}
	if got := ratelimit.ClientIP(req, true); got != "203.0.113.9" {
		t.Fatal(got)
	}
}

// TestMultiIPFairnessLoadtestOff proves production-style IP fairness without the
// loadtest bypass: with TrustProxy, distinct X-Forwarded-For clients each get
// their own burst; a single IP still exhausts and 429s. Spoofed XFF is ignored
// when TrustProxy is false so loopback RemoteAddr remains the bucket key.
func TestMultiIPFairnessLoadtestOff(t *testing.T) {
	t.Parallel()
	now := time.Unix(1_700_000_000, 0)
	l := ratelimit.New(ratelimit.Config{
		Enabled:    true,
		RPS:        1,
		Burst:      2,
		TrustProxy: true,
		Now:        func() time.Time { return now },
		Exempt:     ratelimit.DefaultExempt, // loadtest-off: no LoadtestBypassExempt
	})
	var hits int
	h := l.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.WriteHeader(200)
	}))

	hit := func(xff string) int {
		req := httptest.NewRequest("GET", "/api/v1/public/courses", nil)
		req.RemoteAddr = "127.0.0.1:54321"
		if xff != "" {
			req.Header.Set("X-Forwarded-For", xff)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		return w.Code
	}

	// Two synthetic edge clients share the same TCP peer but distinct XFF.
	if hit("198.51.100.1") != 200 || hit("198.51.100.1") != 200 {
		t.Fatal("client A should consume its burst")
	}
	if hit("198.51.100.1") != 429 {
		t.Fatal("client A must 429 after burst without bypass")
	}
	if hit("198.51.100.2") != 200 || hit("198.51.100.2") != 200 {
		t.Fatal("client B must have an independent bucket")
	}
	if hit("198.51.100.2") != 429 {
		t.Fatal("client B must also 429 after its own burst")
	}
	// X-Real-IP fallback when XFF absent.
	req := httptest.NewRequest("GET", "/api/v1/public/courses", nil)
	req.RemoteAddr = "127.0.0.1:54321"
	req.Header.Set("X-Real-IP", "198.51.100.3")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("X-Real-IP client: %d", w.Code)
	}

	// Without TrustProxy, XFF must not mint a fresh bucket (anti-spoof).
	untrusted := ratelimit.New(ratelimit.Config{
		Enabled: true, RPS: 1, Burst: 1, TrustProxy: false,
		Exempt: ratelimit.DefaultExempt,
	})
	uh := untrusted.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	}))
	mk := func(xff string) int {
		req := httptest.NewRequest("GET", "/api/v1/public/courses", nil)
		req.RemoteAddr = "127.0.0.1:9"
		if xff != "" {
			req.Header.Set("X-Forwarded-For", xff)
		}
		w := httptest.NewRecorder()
		uh.ServeHTTP(w, req)
		return w.Code
	}
	if mk("203.0.113.50") != 200 {
		t.Fatal("first loopback request")
	}
	if mk("203.0.113.51") != 429 {
		t.Fatal("spoofed XFF must not bypass RemoteAddr bucket when TrustProxy=false")
	}
	if hits < 5 {
		t.Fatalf("trusted path hits=%d", hits)
	}
}

func TestLoadtestBypassExemptsMatchingHeader(t *testing.T) {
	t.Parallel()
	l := ratelimit.New(ratelimit.Config{
		Enabled: true, RPS: 1, Burst: 1,
		Exempt: ratelimit.LoadtestBypassExempt("local-smoke-only", ratelimit.DefaultExempt),
	})
	h := l.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	}))
	// Exhaust the bucket with a normal request.
	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/v1/public/courses", nil)
	req.RemoteAddr = "127.0.0.1:1234"
	h.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("first=%d", w.Code)
	}
	w = httptest.NewRecorder()
	req = httptest.NewRequest("GET", "/api/v1/public/courses", nil)
	req.RemoteAddr = "127.0.0.1:1234"
	h.ServeHTTP(w, req)
	if w.Code != 429 {
		t.Fatalf("expected rate limit without bypass, got %d", w.Code)
	}
	// Matching loadtest header bypasses even when bucket empty.
	w = httptest.NewRecorder()
	req = httptest.NewRequest("GET", "/api/v1/public/courses", nil)
	req.RemoteAddr = "127.0.0.1:1234"
	req.Header.Set("X-CourseForge-Loadtest", "local-smoke-only")
	h.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("bypass failed: %d", w.Code)
	}
	// Wrong token still limited.
	w = httptest.NewRecorder()
	req = httptest.NewRequest("GET", "/api/v1/public/courses", nil)
	req.RemoteAddr = "127.0.0.1:1234"
	req.Header.Set("X-CourseForge-Loadtest", "wrong")
	h.ServeHTTP(w, req)
	if w.Code != 429 {
		t.Fatalf("wrong token should not bypass: %d", w.Code)
	}
}
