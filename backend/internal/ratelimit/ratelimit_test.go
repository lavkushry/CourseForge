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
	if !l.Allow("1.1.1.1") || !l.Allow("1.1.1.1") {
		t.Fatal("burst not granted")
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
