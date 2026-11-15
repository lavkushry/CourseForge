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
	ApplicationName   string
}

// PoolRole identifies a capacity-domain connection budget.
type PoolRole string

const (
	PoolAPI       PoolRole = "api"
	PoolAPIJobs   PoolRole = "api_jobs"
	PoolMediaAuth PoolRole = "media"
	PoolWorkerAI  PoolRole = "worker_ai"
	PoolEncode    PoolRole = "worker_encode"
)

// PoolConfigFor returns per-role defaults for a single process. These are planning
// starting points from docs/GO_TYPESCRIPT_CAPACITY.md, not measured capacity.
func PoolConfigFor(role PoolRole) PoolConfig {
	cfg := DefaultPoolConfig()
	switch role {
	case PoolAPI:
		cfg.MaxConns, cfg.MinConns = 16, 2
		cfg.ApplicationName = "courseforge-api"
	case PoolAPIJobs:
		cfg.MaxConns, cfg.MinConns = 2, 0
		cfg.ApplicationName = "courseforge-api_jobs"
	case PoolMediaAuth:
		cfg.MaxConns, cfg.MinConns = 8, 1
		cfg.ApplicationName = "courseforge-media"
	case PoolWorkerAI:
		cfg.MaxConns, cfg.MinConns = 4, 1
		cfg.ApplicationName = "courseforge-worker_ai"
	case PoolEncode:
		cfg.MaxConns, cfg.MinConns = 2, 0
		cfg.ApplicationName = "courseforge-worker_encode"
	default:
		cfg.ApplicationName = "courseforge-go"
	}
	return cfg
}

// SplitAPIPools carves a jobs-submit pool from the API MaxConns budget so AI/job
// saturation cannot exhaust playback/catalog connections. jobsOverride 0 uses
// PoolConfigFor(PoolAPIJobs).MaxConns (2).
func SplitAPIPools(total, jobsOverride int32) (apiCfg, jobsCfg PoolConfig, err error) {
	if total < 2 {
		return PoolConfig{}, PoolConfig{}, fmt.Errorf("API pool split requires total MaxConns >= 2")
	}
	jobsCfg = PoolConfigFor(PoolAPIJobs)
	if jobsOverride > 0 {
		jobsCfg.MaxConns = jobsOverride
	}
	if jobsCfg.MaxConns >= total {
		return PoolConfig{}, PoolConfig{}, fmt.Errorf("jobs pool %d must leave headroom under total %d", jobsCfg.MaxConns, total)
	}
	apiCfg = PoolConfigFor(PoolAPI)
	apiCfg.MaxConns = total - jobsCfg.MaxConns
	if apiCfg.MinConns > apiCfg.MaxConns {
		apiCfg.MinConns = apiCfg.MaxConns
	}
	if jobsCfg.MinConns > jobsCfg.MaxConns {
		jobsCfg.MinConns = jobsCfg.MaxConns
	}
	return apiCfg, jobsCfg, nil
}

// DefaultPoolConfig returns sane defaults for ~2 vCPU / 0.5–1 GiB.
func DefaultPoolConfig() PoolConfig {
	return PoolConfig{
		MaxConns:          16,
		MinConns:          2,
		MaxConnLifetime:   30 * time.Minute,
		MaxConnIdleTime:   5 * time.Minute,
		HealthCheckPeriod: time.Minute,
		ApplicationName:   "courseforge-go",
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
	appName := cfg.ApplicationName
	if appName == "" {
		appName = "courseforge-go"
	}
	c.ConnConfig.RuntimeParams["application_name"] = appName
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
