// Package ratelimit provides a per-IP token-bucket HTTP middleware.
package ratelimit

import (
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"courseforge/backend/internal/httpx"
)

// Config controls admission for ordinary API traffic.
type Config struct {
	Enabled    bool
	RPS        float64
	Burst      int
	TrustProxy bool
	Now        func() time.Time
	// Exempt returns true for paths that must never be rate limited (health).
	Exempt func(*http.Request) bool
}

type bucket struct {
	tokens float64
	last   time.Time
}

// Limiter tracks per-IP token buckets with bounded cardinality.
type Limiter struct {
	cfg   Config
	mu    sync.Mutex
	items map[string]*bucket
}

// New builds a limiter. Zero RPS/Burst fall back to 120/240.
func New(cfg Config) *Limiter {
	if cfg.RPS <= 0 {
		cfg.RPS = 120
	}
	if cfg.Burst < 1 {
		cfg.Burst = 240
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Exempt == nil {
		cfg.Exempt = DefaultExempt
	}
	return &Limiter{cfg: cfg, items: make(map[string]*bucket)}
}

// DefaultExempt skips liveness and readiness probes.
func DefaultExempt(r *http.Request) bool {
	switch r.URL.Path {
	case "/health/live", "/health/ready", "/health":
		return true
	default:
		return false
	}
}

// Middleware rejects excess traffic with 429 while preserving exempt routes.
func (l *Limiter) Middleware(next http.Handler) http.Handler {
	if l == nil || !l.cfg.Enabled {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if l.cfg.Exempt(r) {
			next.ServeHTTP(w, r)
			return
		}
		ip := ClientIP(r, l.cfg.TrustProxy)
		if !l.Allow(ip) {
			w.Header().Set("Retry-After", "1")
			httpx.Error(w, http.StatusTooManyRequests, "rate_limited", "Too many requests")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// Allow consumes one token for key when available.
func (l *Limiter) Allow(key string) bool {
	if key == "" {
		key = "unknown"
	}
	now := l.cfg.Now()
	l.mu.Lock()
	defer l.mu.Unlock()
	b := l.items[key]
	if b == nil {
		if len(l.items) >= 50_000 {
			l.evictLocked(now)
		}
		b = &bucket{tokens: float64(l.cfg.Burst), last: now}
		l.items[key] = b
	}
	elapsed := now.Sub(b.last).Seconds()
	if elapsed > 0 {
		b.tokens += elapsed * l.cfg.RPS
		if b.tokens > float64(l.cfg.Burst) {
			b.tokens = float64(l.cfg.Burst)
		}
		b.last = now
	}
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

func (l *Limiter) evictLocked(now time.Time) {
	for k, b := range l.items {
		if now.Sub(b.last) > 10*time.Minute {
			delete(l.items, k)
		}
	}
	if len(l.items) < 50_000 {
		return
	}
	for k := range l.items {
		delete(l.items, k)
		if len(l.items) < 40_000 {
			return
		}
	}
}

// ClientIP extracts the remote address, optionally honoring the first X-Forwarded-For hop.
func ClientIP(r *http.Request, trustProxy bool) string {
	if trustProxy {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			parts := strings.Split(xff, ",")
			if ip := strings.TrimSpace(parts[0]); ip != "" {
				return ip
			}
		}
		if xri := strings.TrimSpace(r.Header.Get("X-Real-IP")); xri != "" {
			return xri
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
