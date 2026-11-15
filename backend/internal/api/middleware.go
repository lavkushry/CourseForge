package api

import (
	"context"
	"net/http"
	"strings"
	"time"

	"courseforge/backend/internal/httpx"
	"courseforge/backend/internal/identity"
	"courseforge/backend/internal/observe"
)

type ctxKey int

const playbackSessionKey ctxKey = 1

// PlaybackSessionFromContext returns the path-derived playback session id when present.
// It never includes media capability tokens.
func PlaybackSessionFromContext(ctx context.Context) (string, bool) {
	v, ok := ctx.Value(playbackSessionKey).(string)
	return v, ok && v != ""
}

// PlaybackSessionFromPath extracts ps_* session ids from playback routes without
// reading query tokens (t=) so Odysee/media credentials stay out of logs/headers.
func PlaybackSessionFromPath(path string) string {
	const prefix = "/api/v1/playback/sessions/"
	if !strings.HasPrefix(path, prefix) {
		return ""
	}
	rest := strings.TrimPrefix(path, prefix)
	id, _, _ := strings.Cut(rest, "/")
	if !strings.HasPrefix(id, "ps_") || len(id) < 6 || len(id) > 200 {
		return ""
	}
	for _, r := range id {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_' || r == '-' {
			continue
		}
		return ""
	}
	return id
}

// Middleware keeps ordinary calls bounded without terminating long media streams.
// The gateway owns its independent stream deadlines and revocation timers.
// Propagates X-Request-ID and, when applicable, X-CourseForge-Playback-Session
// for session-scoped observability (never media tokens or learner PII labels).
func Middleware(next http.Handler, timeout time.Duration) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "same-origin")
		reqID := identity.RandomToken()
		w.Header().Set("X-Request-ID", reqID)
		ctx := r.Context()
		if sessionID := PlaybackSessionFromPath(r.URL.Path); sessionID != "" {
			w.Header().Set("X-CourseForge-Playback-Session", sessionID)
			ctx = context.WithValue(ctx, playbackSessionKey, sessionID)
			ctx = observe.WithPlayback(ctx, sessionID, "")
			ctx = observe.WithLease(ctx, sessionID)
			if strings.Contains(r.URL.Path, "/media") || strings.Contains(r.URL.Path, "/hls/") || strings.HasSuffix(r.URL.Path, "/poster") {
				ctx = observe.WithDomain(ctx, observe.DomainMedia)
			} else {
				ctx = observe.WithDomain(ctx, observe.DomainAPI)
			}
		}
		defer func() {
			if recover() != nil {
				httpx.Error(w, 500, "internal_error", "Unexpected server error")
			}
		}()
		if strings.HasSuffix(r.URL.Path, "/media") || strings.Contains(r.URL.Path, "/hls/") {
			next.ServeHTTP(w, r.WithContext(ctx))
			return
		}
		ctx, cancel := context.WithTimeout(ctx, timeout)
		defer cancel()
		_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(timeout))
		defer http.NewResponseController(w).SetWriteDeadline(time.Time{})
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}
