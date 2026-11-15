package media

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"courseforge/backend/internal/playback"
)

func TestCircuitBreakerOpensAfterRepeatedFailures(t *testing.T) {
	t.Parallel()
	var c circuitBreaker
	now := time.Unix(0, 0)
	for i := 0; i < circuitFailureThreshold-1; i++ {
		c.failure(now)
		if !c.allow(now) {
			t.Fatal("opened too early")
		}
	}
	if c.trips != 0 {
		t.Fatal("trips before open")
	}
	c.failure(now)
	if c.allow(now) {
		t.Fatal("expected open circuit")
	}
	if c.trips != 1 || !c.isOpen(now) {
		t.Fatalf("trips=%d open=%v", c.trips, c.isOpen(now))
	}
	// Further failures while already open must not inflate trip count.
	c.failure(now)
	if c.trips != 1 {
		t.Fatalf("duplicate trip count %d", c.trips)
	}
	if c.allow(now.Add(circuitCooldown + time.Second)) {
		// allow() after cooldown returns true but does not clear openUntil until success;
		// verify cooldown elapsed path.
	} else {
		t.Fatal("cooldown should permit retries")
	}
	c.success()
	if !c.allow(now.Add(circuitCooldown + time.Second)) {
		t.Fatal("success should clear circuit")
	}
}

func TestOdyseeCircuitRejectsWhileOpen(t *testing.T) {
	t.Parallel()
	o := NewOdysee([]Account{{Token: "tok", Channel: "chan"}})
	t.Cleanup(o.Close)
	fixed := time.Unix(1_700_000_000, 0)
	o.now = func() time.Time { return fixed }
	o.mu.Lock()
	for i := 0; i < circuitFailureThreshold; i++ {
		o.circuit.failure(fixed)
	}
	o.mu.Unlock()
	src := playback.Source{ClaimName: "lesson-name", ClaimID: "0123456789abcdef0123456789abcdef01234567"}
	if _, err := o.Resolve(context.Background(), src); err == nil {
		t.Fatal("expected ErrProvider while open")
	}
	g := o.CircuitGauges()
	if !g.Open || g.Trips < 1 || g.Rejects < 1 {
		t.Fatalf("circuit gauges %+v", g)
	}
}

type countingResolver struct {
	calls atomic.Int64
	delay time.Duration
}

func (c *countingResolver) Resolve(ctx context.Context, _ playback.Source) (Target, error) {
	c.calls.Add(1)
	select {
	case <-time.After(c.delay):
		return Target{URL: "file:///tmp/lesson.mp4"}, nil
	case <-ctx.Done():
		return Target{}, ctx.Err()
	}
}

func TestHybridResolveSingleflightCollapsesStampede(t *testing.T) {
	t.Parallel()
	inner := &countingResolver{delay: 50 * time.Millisecond}
	h := &HybridResolver{Simulator: inner, BaseDirs: []string{t.TempDir()}}
	src := playback.Source{LessonID: "lesson-stampede"}
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := h.Resolve(context.Background(), src); err != nil {
				t.Errorf("resolve: %v", err)
			}
		}()
	}
	wg.Wait()
	if got := inner.calls.Load(); got != 1 {
		t.Fatalf("expected 1 in-flight resolve, got %d", got)
	}
}
