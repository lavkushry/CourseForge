package migrate

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strings"
	"time"

	"courseforge/backend/internal/store"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// RehearsalOutcome documents a throwaway-schema DryRun+Apply (not production cutover).
type RehearsalOutcome struct {
	Schema            string
	Mode              string // dry-run | apply
	Plan              Plan
	Result            *Result
	ArtifactsCopied   int
	Duration          time.Duration
	NotProductionNote string
}

// RehearsalOptions configures an isolated schema rehearsal against PostgreSQL.
type RehearsalOptions struct {
	DatabaseURL        string
	Schema             string // empty → random cf_rehearsal_*
	SQLitePath         string
	AssertIsolated     bool
	Mode               string // dry-run | apply
	ConfirmApply       bool
	DropSchemaAfter    bool
	ArtifactSourceRoot string
	ArtifactDestRoot   string
}

// RunIsolatedRehearsal creates a throwaway schema, migrates it, and optionally Applies.
// Always refuses live courseforge.sqlite3 paths when AssertIsolated is used via Load.
func RunIsolatedRehearsal(ctx context.Context, opt RehearsalOptions) (RehearsalOutcome, error) {
	start := time.Now()
	out := RehearsalOutcome{
		NotProductionNote: "NOT production cutover — isolated rehearsal only; checklist required before any live import",
		Mode:              opt.Mode,
	}
	if opt.Mode != "dry-run" && opt.Mode != "apply" {
		return out, fmt.Errorf("mode must be dry-run or apply")
	}
	if opt.Mode == "apply" {
		if opt.DatabaseURL == "" {
			return out, fmt.Errorf("database url required for apply")
		}
		if !opt.ConfirmApply {
			return out, fmt.Errorf("apply requires --confirm-apply (explicit operator confirmation)")
		}
	}
	snap, err := LoadSnapshotFromSyntheticSQLite(opt.SQLitePath, opt.AssertIsolated)
	if err != nil {
		return out, err
	}
	plan, err := DryRun(snap)
	if err != nil {
		return out, err
	}
	out.Plan = plan
	if opt.Mode == "dry-run" {
		out.Duration = time.Since(start)
		return out, nil
	}

	schema := opt.Schema
	if schema == "" {
		b := make([]byte, 6)
		if _, err = rand.Read(b); err != nil {
			return out, err
		}
		schema = "cf_rehearsal_" + hex.EncodeToString(b)
	}
	if !safeSchemaName(schema) {
		return out, fmt.Errorf("unsafe schema name %q", schema)
	}
	out.Schema = schema

	admin, err := pgxpool.New(ctx, opt.DatabaseURL)
	if err != nil {
		return out, err
	}
	defer admin.Close()
	quoted := pgx.Identifier{schema}.Sanitize()
	if _, err = admin.Exec(ctx, "CREATE SCHEMA "+quoted); err != nil {
		return out, fmt.Errorf("create schema: %w", err)
	}
	drop := opt.DropSchemaAfter
	defer func() {
		if drop {
			_, _ = admin.Exec(context.Background(), "DROP SCHEMA "+quoted+" CASCADE")
		}
	}()

	cfg, err := pgxpool.ParseConfig(opt.DatabaseURL)
	if err != nil {
		return out, err
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return out, err
	}
	defer pool.Close()

	if err = store.Migrate(ctx, pool); err != nil {
		return out, fmt.Errorf("migrate schema: %w", err)
	}
	res, err := Apply(ctx, pool, snap)
	if err != nil {
		return out, err
	}
	out.Result = &res
	if opt.ArtifactSourceRoot != "" && opt.ArtifactDestRoot != "" {
		n, err := ArtifactMaterialize(snap, opt.ArtifactSourceRoot, opt.ArtifactDestRoot)
		if err != nil {
			return out, err
		}
		out.ArtifactsCopied = n
	}
	out.Duration = time.Since(start)
	return out, nil
}

func safeSchemaName(name string) bool {
	if name == "" || len(name) > 63 {
		return false
	}
	for i, r := range name {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '_' {
			continue
		}
		if i > 0 && r >= 'A' && r <= 'Z' {
			continue
		}
		return false
	}
	return strings.HasPrefix(name, "cf_rehearsal_") || strings.HasPrefix(name, "cf_test_")
}
