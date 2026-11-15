package media

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"courseforge/backend/internal/playback"
)

func TestLocalTitleKeyStripsIndexAndRejectsShort(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"[154] Session 5 on MLOps Revisited - DevOps", "session 5 on mlops revisited - devops"},
		{"[097] Session_5_on_MLOps_Revisited_DevOps", "session 5 on mlops revisited devops"},
		{"[067] Note", ""},
		{"[390] Introduction", ""},
		{"Interview Questions on Regression", "interview questions on regression"},
	}
	for _, tc := range cases {
		if got := localTitleKey(tc.in); got != tc.want {
			t.Fatalf("localTitleKey(%q)=%q want %q", tc.in, got, tc.want)
		}
	}
}

func TestFindLocalMatchesRenumberedDuplicateSameCourseOnly(t *testing.T) {
	root := t.TempDir()
	course := "Campus X DSMP (Data Science Mentorship Program)"
	other := "Sanket Elite 1.0"
	dir := filepath.Join(root, "courses", course)
	otherDir := filepath.Join(root, "courses", other)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(otherDir, 0o755); err != nil {
		t.Fatal(err)
	}
	body := []byte("fake-mp4-bytes-for-local-match")
	fileName := "[097] Session_8_on_MLOps_Revisited_MLOps_Tool_Stack_Cloud_I.mp4"
	if err := os.WriteFile(filepath.Join(dir, fileName), body, 0o644); err != nil {
		t.Fatal(err)
	}
	// Same basename in another course must not be selected for DSMP.
	if err := os.WriteFile(filepath.Join(otherDir, fileName), []byte("wrong-course"), 0o644); err != nil {
		t.Fatal(err)
	}

	h := &HybridResolver{BaseDirs: []string{root}}
	target, err := h.Resolve(context.Background(), playback.Source{
		CourseID: course,
		Title:    "[157] Session_8_on_MLOps_Revisited_MLOps_Tool_Stack_Cloud_I",
		LessonID: "dup-proof",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(target.URL, "file://") {
		t.Fatalf("want file URL got %s", target.URL)
	}
	got := strings.TrimPrefix(target.URL, "file://")
	want := filepath.Join(dir, fileName)
	if got != want {
		t.Fatalf("resolved %s want %s", got, want)
	}
}
