package media_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"courseforge/backend/internal/media"
	"courseforge/backend/internal/playback"
)

func TestCampusXDSMPLocalFilesResolveWithoutClaims(t *testing.T) {
	root := "/home/ubuntu/CourseForge"
	course := "Campus X DSMP (Data Science Mentorship Program)"
	dir := filepath.Join(root, "courses", course)
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	h := &media.HybridResolver{BaseDirs: []string{root}}
	resolved := 0
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(strings.ToLower(e.Name()), ".mp4") {
			continue
		}
		title := strings.TrimSuffix(e.Name(), filepath.Ext(e.Name()))
		target, err := h.Resolve(context.Background(), playback.Source{
			CourseID: course,
			Title:    title,
			LessonID: "local-proof",
		})
		if err != nil {
			t.Fatalf("resolve %s: %v", title, err)
		}
		if !strings.HasPrefix(target.URL, "file://") {
			t.Fatalf("expected file URL for %s got %s", title, target.URL)
		}
		path := strings.TrimPrefix(target.URL, "file://")
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("missing file %s", path)
		}
		resolved++
	}
	// On-disk set grows when misplaced same-title files are hardlinked into the course dir.
	if resolved < 103 {
		t.Fatalf("resolved %d want at least 103", resolved)
	}
	t.Logf("resolved %d on-disk DSMP mp4 titles", resolved)
}
