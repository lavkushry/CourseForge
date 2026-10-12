package api

import (
	"context"
	"net/http"
	"strings"
	"time"

	"courseforge/backend/internal/httpx"
	"courseforge/backend/internal/identity"
)

// Middleware keeps ordinary calls bounded without terminating long media streams.
// The gateway owns its independent stream deadlines and revocation timers.
func Middleware(next http.Handler, timeout time.Duration) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "same-origin")
		w.Header().Set("X-Request-ID", identity.RandomToken())
		defer func() {
			if recover() != nil {
				httpx.Error(w, 500, "internal_error", "Unexpected server error")
			}
		}()
		if strings.HasSuffix(r.URL.Path, "/media") {
			next.ServeHTTP(w, r)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), timeout)
		defer cancel()
		_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(timeout))
		defer http.NewResponseController(w).SetWriteDeadline(time.Time{})
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}
