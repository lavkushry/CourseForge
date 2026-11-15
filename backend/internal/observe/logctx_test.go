package observe

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
	"testing"
)

func TestLoggerIncludesPlaybackFieldsWithoutSecrets(t *testing.T) {
	t.Parallel()
	var buf bytes.Buffer
	handler := slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelInfo})
	prev := slog.Default()
	slog.SetDefault(slog.New(handler))
	t.Cleanup(func() { slog.SetDefault(prev) })

	ctx := WithDomain(WithLease(WithPlayback(context.Background(), "ps_abc", "lesson-1"), "ps_abc"), DomainMedia)
	Logger(ctx).Info("media admitted", "secret_token", "should-not-be-in-attrs-by-default")
	out := buf.String()
	for _, want := range []string{"playback_session_id=ps_abc", "lease_id=ps_abc", "lesson_id=lesson-1", "capacity_domain=media"} {
		if !strings.Contains(out, want) {
			t.Fatalf("missing %q in %s", want, out)
		}
	}
}
