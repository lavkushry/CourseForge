package migrate

import (
	"os"
	"path/filepath"
	"testing"
)

func TestArtifactMaterializeCopiesTinyFixtures(t *testing.T) {
	src := "testdata/artifacts"
	dst := t.TempDir()
	s := Snapshot{
		Courses: []CourseRow{{ID: "syn_c1", CoverRelativePath: "covers/syn_c1.png"}},
		Lessons: []LessonRow{{ID: "syn_l1", SourceRelativePath: "library/syn_c1/syn_l1.mp4"}},
	}
	n, err := ArtifactMaterialize(s, src, dst)
	if err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("copied=%d", n)
	}
	for _, rel := range []string{"covers/syn_c1.png", "library/syn_c1/syn_l1.mp4"} {
		p := filepath.Join(dst, filepath.FromSlash(rel))
		st, err := os.Stat(p)
		if err != nil || st.Size() == 0 {
			t.Fatalf("%s missing or empty: %v", rel, err)
		}
	}
}

func TestArtifactMaterializeRefusesTraversal(t *testing.T) {
	_, err := ArtifactMaterialize(Snapshot{
		Courses: []CourseRow{{CoverRelativePath: "../etc/passwd"}},
	}, "testdata/artifacts", t.TempDir())
	if err == nil {
		t.Fatal("expected traversal refuse")
	}
}
