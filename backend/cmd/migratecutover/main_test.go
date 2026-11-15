package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestMigrateCutoverDryRunAndRefuseLive(t *testing.T) {
	root := findModuleRoot(t)
	sqlite := filepath.Join(root, "internal/migrate/testdata/synthetic_core.sqlite3")
	cmd := exec.Command("go", "run", "./cmd/migratecutover",
		"--sqlite", sqlite,
		"--assert-isolated",
		"--refuse-live-path",
		"--mode", "dry-run",
	)
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "PATH=/usr/lib/go-1.26/bin:"+os.Getenv("PATH"))
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("dry-run: %v\n%s", err, out)
	}
	if !strings.Contains(string(out), "m3-core-v7") && !strings.Contains(string(out), "transform_version") {
		t.Fatalf("unexpected output: %s", out)
	}

	live := filepath.Join(root, "../data/courseforge.sqlite3")
	cmd = exec.Command("go", "run", "./cmd/migratecutover",
		"--sqlite", live,
		"--assert-isolated",
		"--mode", "dry-run",
	)
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "PATH=/usr/lib/go-1.26/bin:"+os.Getenv("PATH"))
	out, err = cmd.CombinedOutput()
	if err == nil {
		t.Fatalf("expected live refuse, got %s", out)
	}
	if !strings.Contains(string(out), "refusing") && !strings.Contains(string(out), "live") {
		t.Fatalf("expected refuse message: %s", out)
	}
}

func TestMigrateCutoverApplyNeedsConfirm(t *testing.T) {
	url := os.Getenv("CF_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("CF_TEST_DATABASE_URL not set")
	}
	root := findModuleRoot(t)
	sqlite := filepath.Join(root, "internal/migrate/testdata/synthetic_core.sqlite3")
	cmd := exec.Command("go", "run", "./cmd/migratecutover",
		"--sqlite", sqlite,
		"--database-url", url,
		"--assert-isolated",
		"--mode", "apply",
	)
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "PATH=/usr/lib/go-1.26/bin:"+os.Getenv("PATH"))
	out, err := cmd.CombinedOutput()
	if err == nil {
		t.Fatalf("expected confirm failure: %s", out)
	}
	if !strings.Contains(string(out), "confirm-apply") {
		t.Fatalf("got %s", out)
	}
}

func findModuleRoot(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	// cmd/migratecutover → backend
	return filepath.Clean(filepath.Join(wd, "../.."))
}
