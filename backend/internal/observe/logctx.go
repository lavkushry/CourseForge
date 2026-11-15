package observe

import (
	"context"
	"log/slog"
)

type ctxKey int

const (
	playbackSessionCtxKey ctxKey = 1
	leaseCtxKey           ctxKey = 2
	lessonCtxKey          ctxKey = 3
	domainCtxKey          ctxKey = 4
)

// Domain is a capacity plane label for logs and dashboards (API ≠ media ≠ AI).
type Domain string

const (
	DomainAPI   Domain = "api"
	DomainMedia Domain = "media"
	DomainAI    Domain = "ai"
)

// WithPlayback attaches playback-session correlation fields for structured logs.
// Never pass media capability tokens or Odysee credentials.
func WithPlayback(ctx context.Context, sessionID, lessonID string) context.Context {
	if sessionID != "" {
		ctx = context.WithValue(ctx, playbackSessionCtxKey, sessionID)
	}
	if lessonID != "" {
		ctx = context.WithValue(ctx, lessonCtxKey, lessonID)
	}
	return ctx
}

// WithLease records the active lease/session id (usually same as playback session).
func WithLease(ctx context.Context, leaseID string) context.Context {
	if leaseID == "" {
		return ctx
	}
	return context.WithValue(ctx, leaseCtxKey, leaseID)
}

// WithDomain tags the capacity plane for logs (api / media / ai).
func WithDomain(ctx context.Context, domain Domain) context.Context {
	if domain == "" {
		return ctx
	}
	return context.WithValue(ctx, domainCtxKey, domain)
}

// Logger returns a slog.Logger with playback/lease/domain attrs from ctx when present.
func Logger(ctx context.Context) *slog.Logger {
	attrs := make([]any, 0, 8)
	if v, ok := ctx.Value(playbackSessionCtxKey).(string); ok && v != "" {
		attrs = append(attrs, "playback_session_id", v)
	}
	if v, ok := ctx.Value(leaseCtxKey).(string); ok && v != "" {
		attrs = append(attrs, "lease_id", v)
	}
	if v, ok := ctx.Value(lessonCtxKey).(string); ok && v != "" {
		attrs = append(attrs, "lesson_id", v)
	}
	if v, ok := ctx.Value(domainCtxKey).(Domain); ok && v != "" {
		attrs = append(attrs, "capacity_domain", string(v))
	}
	if len(attrs) == 0 {
		return slog.Default()
	}
	return slog.With(attrs...)
}

// PlaybackSessionID extracts the correlated session id from ctx.
func PlaybackSessionID(ctx context.Context) string {
	v, _ := ctx.Value(playbackSessionCtxKey).(string)
	return v
}
