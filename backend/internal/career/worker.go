package career

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// CompileFunc compiles LaTeX to PDF. Tests may inject a fake.
type CompileFunc func(ctx context.Context, latex string) (pdf []byte, compiler string, err error)

// ProcessQueuedCompiles claims queued resume versions and compiles them.
// Safe to run from the export job worker or inline after enqueue.
func ProcessQueuedCompiles(ctx context.Context, pool *pgxpool.Pool, compile CompileFunc, limit int) int {
	if pool == nil || limit < 1 {
		return 0
	}
	if compile == nil {
		compile = CompileLaTeX
	}
	done := 0
	for i := 0; i < limit; i++ {
		id, err := claimQueuedVersion(ctx, pool)
		if errors.Is(err, pgx.ErrNoRows) {
			return done
		}
		if err != nil {
			slog.Warn("career resume claim failed", "error", err)
			return done
		}
		if err = CompileVersion(ctx, pool, id, compile); err != nil {
			slog.Warn("career resume compile failed", "version_id", id, "error", err)
		}
		done++
	}
	return done
}

func claimQueuedVersion(ctx context.Context, pool *pgxpool.Pool) (string, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)
	var id string
	err = tx.QueryRow(ctx, `
SELECT id FROM career_resume_versions
WHERE status='queued'
ORDER BY created_at, id
FOR UPDATE SKIP LOCKED
LIMIT 1`).Scan(&id)
	if err != nil {
		return "", err
	}
	tag, err := tx.Exec(ctx, `
UPDATE career_resume_versions
SET status='compiling', updated_at=now()
WHERE id=$1 AND status='queued'`, id)
	if err != nil {
		return "", err
	}
	if tag.RowsAffected() != 1 {
		return "", pgx.ErrNoRows
	}
	if err = tx.Commit(ctx); err != nil {
		return "", err
	}
	return id, nil
}

// CompileVersion compiles one resume version, verifies PDF text, and stores skim score.
func CompileVersion(ctx context.Context, pool *pgxpool.Pool, versionID string, compile CompileFunc) error {
	if compile == nil {
		compile = CompileLaTeX
	}
	var (
		latex   string
		snapRaw []byte
		userID  string
		appID   string
	)
	err := pool.QueryRow(ctx, `
SELECT user_id,application_id,latex_source,snapshot
FROM career_resume_versions WHERE id=$1`, versionID).
		Scan(&userID, &appID, &latex, &snapRaw)
	if err != nil {
		return err
	}
	var doc ResumeDocument
	if err = json.Unmarshal(snapRaw, &doc); err != nil {
		return markFailed(ctx, pool, versionID, "invalid snapshot JSON")
	}

	var targetSkills []string
	_ = pool.QueryRow(ctx, `SELECT target_skills FROM career_applications WHERE id=$1 AND user_id=$2`, appID, userID).Scan(&targetSkills)

	pdf, compiler, err := compile(ctx, latex)
	if err != nil {
		msg := err.Error()
		if errors.Is(err, ErrCompilerMissing) {
			msg = "Neither tectonic nor latexmk is installed on the worker. Install one of them and retry."
		}
		return markFailed(ctx, pool, versionID, msg)
	}

	text, err := ExtractPDFText(pdf)
	if err != nil || strings.TrimSpace(text) == "" {
		return markFailed(ctx, pool, versionID, "PDF compiled but text layer is not extractable (ATS text check failed)")
	}
	found, missing := VerifyKeyFields(text, doc)
	if len(missing) > 0 && !containsAll(found, "full_name", "title") {
		return markFailed(ctx, pool, versionID, "PDF text missing key fields: "+joinCSV(missing))
	}
	skim := ScoreSkim(text, doc, targetSkills)
	skimRaw, _ := json.Marshal(skim)

	_, err = pool.Exec(ctx, `
UPDATE career_resume_versions
SET status='ready', compiler=$2, pdf_data=$3, skim_score=$4::jsonb,
    verified_fields=$5, error_message='', updated_at=now()
WHERE id=$1 AND status='compiling'`, versionID, compiler, pdf, skimRaw, found)
	return err
}

func markFailed(ctx context.Context, pool *pgxpool.Pool, id, msg string) error {
	if len(msg) > 2000 {
		msg = msg[:2000]
	}
	_, err := pool.Exec(ctx, `
UPDATE career_resume_versions
SET status='failed', error_message=$2, updated_at=now()
WHERE id=$1`, id, msg)
	if err != nil {
		return err
	}
	return errors.New(msg)
}

func containsAll(have []string, need ...string) bool {
	set := map[string]struct{}{}
	for _, h := range have {
		set[h] = struct{}{}
	}
	for _, n := range need {
		if _, ok := set[n]; !ok {
			return false
		}
	}
	return true
}

func joinCSV(items []string) string {
	if len(items) == 0 {
		return ""
	}
	out := items[0]
	for i := 1; i < len(items); i++ {
		out += ", " + items[i]
	}
	return out
}

// RunCompileLoop polls for queued resume versions until ctx is done.
func RunCompileLoop(ctx context.Context, pool *pgxpool.Pool, compile CompileFunc, every time.Duration) {
	if every < time.Second {
		every = time.Second
	}
	tick := time.NewTicker(every)
	defer tick.Stop()
	for {
		ProcessQueuedCompiles(ctx, pool, compile, 4)
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}
