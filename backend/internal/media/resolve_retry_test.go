package media

import (
	"context"
	"errors"
	"testing"

	"courseforge/backend/internal/playback"
)

type fakeResolver struct {
	calls   int
	results []Target
	onCall  func()
}

func (f *fakeResolver) Resolve(context.Context, playback.Source) (Target, error) {
	f.calls++
	if f.onCall != nil {
		f.onCall()
	}
	if f.calls <= len(f.results) && f.results[f.calls-1].URL != "" {
		return f.results[f.calls-1], nil
	}
	return Target{}, errors.New("transient")
}

func TestResolveWithRetrySucceedsOnSecondAttempt(t *testing.T) {
	f := &fakeResolver{results: []Target{{}, {URL: "https://cdn/video.mp4"}}}
	target, attempt, err := resolveWithRetry(context.Background(), f, playback.Source{LessonID: "l1"})
	if err != nil || target.URL != "https://cdn/video.mp4" || attempt != 2 || f.calls != 2 {
		t.Fatalf("got target=%q attempt=%d calls=%d err=%v", target.URL, attempt, f.calls, err)
	}
}

func TestResolveWithRetryStopsWhenCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	f := &fakeResolver{onCall: cancel}
	_, _, err := resolveWithRetry(ctx, f, playback.Source{LessonID: "l1"})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
	if f.calls != 1 {
		t.Fatalf("calls = %d, want 1 (no retry after cancel)", f.calls)
	}
}
