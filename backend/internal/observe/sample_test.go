package observe

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
	"testing"
	"time"
)

func TestSampledInfoRateLimitsHotPath(t *testing.T) {
	// Not parallel: mutates process-global sampler + slog.Default.
	ResetSamplerForTest()
	now := time.Unix(0, 0)
	SetSamplerIntervalForTest(time.Second, func() time.Time { return now })
	t.Cleanup(func() {
		ResetSamplerForTest()
		SetSamplerIntervalForTest(defaultSampleInterval, time.Now)
	})

	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelInfo})))
	t.Cleanup(func() { slog.SetDefault(prev) })

	ctx := WithPlayback(context.Background(), "ps_sample", "lesson")
	SampledInfo(ctx, "media-admit:ps_sample", "media delivery authorized")
	SampledInfo(ctx, "media-admit:ps_sample", "media delivery authorized")
	if strings.Count(buf.String(), "media delivery authorized") != 1 {
		t.Fatalf("expected 1 sampled line, got %q", buf.String())
	}
	now = now.Add(2 * time.Second)
	SampledInfo(ctx, "media-admit:ps_sample", "media delivery authorized")
	if strings.Count(buf.String(), "media delivery authorized") != 2 {
		t.Fatalf("expected 2 after interval, got %q", buf.String())
	}
}

func TestAlwaysErrorNeverSampled(t *testing.T) {
	// Not parallel: mutates process-global slog.Default (shared with sampler tests).
	ResetSamplerForTest()
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelInfo})))
	t.Cleanup(func() { slog.SetDefault(prev) })

	ctx := WithLease(context.Background(), "ps_err")
	AlwaysError(ctx, "lease auth failed")
	AlwaysError(ctx, "lease auth failed")
	if strings.Count(buf.String(), "lease auth failed") != 2 {
		t.Fatal(buf.String())
	}
}
