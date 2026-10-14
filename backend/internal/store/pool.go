package store

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// PoolConfig tunes pgxpool for a constrained replica.
type PoolConfig struct {
	MaxConns          int32
	MinConns          int32
	MaxConnLifetime   time.Duration
	MaxConnIdleTime   time.Duration
	HealthCheckPeriod time.Duration
}

// DefaultPoolConfig returns sane defaults for ~2 vCPU / 0.5–1 GiB.
func DefaultPoolConfig() PoolConfig {
	return PoolConfig{
		MaxConns:          16,
		MinConns:          2,
		MaxConnLifetime:   30 * time.Minute,
		MaxConnIdleTime:   5 * time.Minute,
		HealthCheckPeriod: time.Minute,
	}
}

// OpenWithConfig connects with explicit pool budgets and idle health checks.
func OpenWithConfig(ctx context.Context, databaseURL string, cfg PoolConfig) (*pgxpool.Pool, error) {
	if cfg.MaxConns < 1 || cfg.MaxConns > 120 {
		return nil, fmt.Errorf("database connection budget must be 1..120")
	}
	if cfg.MinConns < 0 || cfg.MinConns > cfg.MaxConns {
		return nil, fmt.Errorf("database min connections must be 0..max")
	}
	if cfg.MaxConnLifetime <= 0 {
		cfg.MaxConnLifetime = 30 * time.Minute
	}
	if cfg.MaxConnIdleTime <= 0 {
		cfg.MaxConnIdleTime = 5 * time.Minute
	}
	if cfg.HealthCheckPeriod <= 0 {
		cfg.HealthCheckPeriod = time.Minute
	}
	c, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, err
	}
	c.MaxConns = cfg.MaxConns
	c.MinConns = cfg.MinConns
	c.MaxConnLifetime = cfg.MaxConnLifetime
	c.MaxConnLifetimeJitter = cfg.MaxConnLifetime / 6
	if c.MaxConnLifetimeJitter < time.Second {
		c.MaxConnLifetimeJitter = time.Second
	}
	c.MaxConnIdleTime = cfg.MaxConnIdleTime
	c.HealthCheckPeriod = cfg.HealthCheckPeriod
	c.ConnConfig.RuntimeParams["statement_timeout"] = "5000"
	c.ConnConfig.RuntimeParams["lock_timeout"] = "2000"
	c.ConnConfig.RuntimeParams["idle_in_transaction_session_timeout"] = "10000"
	c.ConnConfig.RuntimeParams["application_name"] = "courseforge-go"
	p, err := pgxpool.NewWithConfig(ctx, c)
	if err != nil {
		return nil, err
	}
	if err = p.Ping(ctx); err != nil {
		p.Close()
		return nil, err
	}
	return p, nil
}
