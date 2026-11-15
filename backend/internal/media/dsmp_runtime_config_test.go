package media

import (
	"context"
	"database/sql"
	"os"
	"strings"
	"testing"

	"courseforge/backend/internal/playback"

	_ "github.com/jackc/pgx/v5/stdlib"
)

// Uses the same FromEnvironment path as cmd/media with Cloud Agent boot env.
func TestDSMPResolvesUnderMediaBootConfig(t *testing.T) {
	t.Setenv("CF_COURSES_DIR", "/home/ubuntu/CourseForge")
	t.Setenv("CF_ARTIFACT_ROOT", "/home/ubuntu/CourseForge")
	// Ensure we don't require Odysee accounts for this proof.
	resolver, _, closeFn, err := FromEnvironment(false, os.Getenv)
	if err != nil {
		t.Fatal(err)
	}
	defer closeFn()

	db, err := sql.Open("pgx", "postgres://courseforge:local_rewrite_only@127.0.0.1:15439/courseforge_rewrite?sslmode=disable")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	course := "Campus X DSMP (Data Science Mentorship Program)"
	rows, err := db.Query(`SELECT id, title FROM lessons WHERE course_id=$1`, course)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()

	localOK := 0
	var sampleID, sampleURL string
	for rows.Next() {
		var id, title string
		if err := rows.Scan(&id, &title); err != nil {
			t.Fatal(err)
		}
		target, err := resolver.Resolve(context.Background(), playback.Source{
			LessonID: id,
			CourseID: course,
			Title:    title,
		})
		if err != nil {
			continue
		}
		if strings.HasPrefix(target.URL, "file://") {
			path := strings.TrimPrefix(target.URL, "file://")
			if st, err := os.Stat(path); err == nil && st.Size() > 0 {
				localOK++
				if sampleID == "" {
					sampleID, sampleURL = id, target.URL
				}
			}
		}
	}
	// Exact filenames plus index-stripped renumbered duplicates within the same course.
	if localOK < 200 {
		t.Fatalf("local resolvable under boot config=%d want at least 200", localOK)
	}
	t.Logf("local resolvable under boot config=%d sample lesson %s -> %s", localOK, sampleID, sampleURL)
}
