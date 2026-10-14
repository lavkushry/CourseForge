package store

import (
	"context"
	"embed"
	"fmt"
	"sort"

	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed migrations/*.sql
var migrations embed.FS

// Open connects with MaxConns only; prefer OpenWithConfig for full pool tuning.
func Open(ctx context.Context, databaseURL string, maxConnections int32) (*pgxpool.Pool, error) {
	cfg := DefaultPoolConfig()
	cfg.MaxConns = maxConnections
	if maxConnections < 4 {
		cfg.MinConns = 0
	}
	return OpenWithConfig(ctx, databaseURL, cfg)
}

// Migrate serializes replicas with a transaction-scoped PostgreSQL advisory lock.
// Call only against the separate staging database or an explicitly approved release.
func Migrate(ctx context.Context, pool *pgxpool.Pool) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	// Lock per current_schema so parallel synthetic test schemas do not serialize
	// on one cluster-wide key (and trip connection lock_timeout).
	var schema string
	if err = tx.QueryRow(ctx, "SELECT current_schema()").Scan(&schema); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 673583404))", schema); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, "CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"); err != nil {
		return err
	}
	entries, err := migrations.ReadDir("migrations")
	if err != nil {
		return err
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	for _, entry := range entries {
		name := entry.Name()
		var applied bool
		if err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version=$1)", name).Scan(&applied); err != nil {
			return err
		}
		if applied {
			continue
		}
		sql, err := migrations.ReadFile("migrations/" + name)
		if err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, string(sql)); err != nil {
			return fmt.Errorf("migration %s: %w", name, err)
		}
		if _, err = tx.Exec(ctx, "INSERT INTO schema_migrations(version) VALUES($1)", name); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
