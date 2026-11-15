// migratecutover runs an isolated SQLite→PostgreSQL DryRun or Apply rehearsal.
//
// This is NOT a production cutover. Do not point at live courseforge.sqlite3.
// Production import remains blocked until the migration checklist in
// docs/rewrite/MIGRATION_INVENTORY.md and docs/research/STREAMING_BACKEND_ARCHITECTURE.md
// is satisfied (isolated snapshot, artifact/vector recovery, operator sign-off).
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"courseforge/backend/internal/migrate"
)

func main() {
	fs := flag.NewFlagSet("migratecutover", flag.ExitOnError)
	sqlite := fs.String("sqlite", "", "path to synthetic or *copied* isolated SQLite (never data/courseforge.sqlite3)")
	dbURL := fs.String("database-url", envOr("CF_TEST_DATABASE_URL", ""), "PostgreSQL URL for throwaway schema")
	schema := fs.String("schema", "", "throwaway schema name (cf_rehearsal_* or cf_test_*; empty=random)")
	mode := fs.String("mode", "dry-run", "dry-run | apply")
	assertIsolated := fs.Bool("assert-isolated", false, "required: operator asserts path is an isolated snapshot/copy")
	refuseLive := fs.Bool("refuse-live-path", true, "refuse live courseforge.sqlite3 paths (keep true)")
	confirmApply := fs.Bool("confirm-apply", false, "required for --mode=apply")
	dropAfter := fs.Bool("drop-schema-after", true, "DROP SCHEMA CASCADE after apply rehearsal")
	artifactSrc := fs.String("artifact-source", "", "optional root of tiny placeholder fixtures")
	artifactDst := fs.String("artifact-dest", "", "optional dest root for placeholder copy")
	_ = fs.Bool("help-checklist", false, "unused; see banner")
	fs.Usage = func() {
		fmt.Fprintf(os.Stderr, `migratecutover — isolated DryRun/Apply rehearsal (NOT production cutover)

Usage:
  migratecutover --sqlite PATH --database-url URL --assert-isolated [--mode dry-run|apply] [flags]

Required for any run:
  --assert-isolated     operator confirms PATH is synthetic or a copied isolated snapshot
  --refuse-live-path    default true; refuses courseforge.sqlite3 / data/courseforge.sqlite3

Apply additionally requires:
  --confirm-apply       explicit confirmation; without it apply exits non-zero

Optional artifact fixtures (tiny files only, no Qdrant / no large videos):
  --artifact-source DIR --artifact-dest DIR

Environment:
  CF_TEST_DATABASE_URL  default for --database-url (e.g. postgres on :15439)

This tool creates a throwaway PostgreSQL schema (cf_rehearsal_*), runs store migrations,
and may Apply then DROP. It does not authorize production cutover.

`)
		fs.PrintDefaults()
	}
	_ = fs.Parse(os.Args[1:])

	fmt.Fprintln(os.Stderr, "migratecutover: NOT production cutover until migration checklist is passed.")

	if !*assertIsolated {
		fail("refusing to run without --assert-isolated")
	}
	if !*refuseLive {
		fail("--refuse-live-path must remain true for this CLI")
	}
	if *sqlite == "" {
		fail("--sqlite is required")
	}
	if *mode == "apply" && *dbURL == "" {
		fail("--database-url is required for apply (or set CF_TEST_DATABASE_URL)")
	}
	if err := migrate.AssertIsolatedSQLitePath(*sqlite, true); err != nil {
		fail(err.Error())
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	out, err := migrate.RunIsolatedRehearsal(ctx, migrate.RehearsalOptions{
		DatabaseURL:        *dbURL,
		Schema:             *schema,
		SQLitePath:         *sqlite,
		AssertIsolated:     true,
		Mode:               *mode,
		ConfirmApply:       *confirmApply,
		DropSchemaAfter:    *dropAfter,
		ArtifactSourceRoot: *artifactSrc,
		ArtifactDestRoot:   *artifactDst,
	})
	if err != nil {
		fail(err.Error())
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	_ = enc.Encode(map[string]any{
		"not_production":     out.NotProductionNote,
		"mode":               out.Mode,
		"schema":             out.Schema,
		"transform_version":  out.Plan.TransformVersion,
		"row_counts":         out.Plan.RowCounts,
		"canonical_checksum": out.Plan.CanonicalChecksum,
		"generation": func() string {
			if out.Result != nil {
				return out.Result.Generation
			}
			return ""
		}(),
		"artifacts_copied": out.ArtifactsCopied,
		"duration_ms":      out.Duration.Milliseconds(),
		"sqlite":           filepath.Clean(*sqlite),
	})
}

func envOr(k, def string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return def
}

func fail(msg string) {
	fmt.Fprintln(os.Stderr, "error:", msg)
	os.Exit(1)
}
