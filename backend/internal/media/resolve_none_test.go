package media

import (
	"context"
	"errors"
	"strings"
	"testing"

	"courseforge/backend/internal/playback"
)

// No configured source must surface ErrProvider, never a substitute test clip.
func TestHybridResolverWithoutSourceReturnsErrProvider(t *testing.T) {
	h := &HybridResolver{BaseDirs: []string{t.TempDir()}}
	target, err := h.Resolve(context.Background(), playback.Source{LessonID: "l1", Title: "Missing lesson"})
	if !errors.Is(err, ErrProvider) {
		t.Fatalf("err = %v, want ErrProvider", err)
	}
	if target.URL != "" || strings.Contains(target.URL, "lecture.mp4") {
		t.Fatalf("unexpected target %q", target.URL)
	}
}
