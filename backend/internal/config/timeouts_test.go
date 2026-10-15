package config

import (
	"testing"
	"time"
)

func TestHTTPServerTimeoutsRespectStreaming(t *testing.T) {
	t.Parallel()
	c := Config{
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 << 10,
		MediaMode:         "external",
	}
	rh, r, w, idle, maxH := c.HTTPServerTimeouts()
	if rh != 5*time.Second || r != 10*time.Second || w != 30*time.Second || idle != 60*time.Second || maxH != 16<<10 {
		t.Fatal("external mode should keep write timeout", rh, r, w, idle, maxH)
	}
	c.MediaMode = "embedded"
	_, _, w, _, _ = c.HTTPServerTimeouts()
	if w != 0 {
		t.Fatal("embedded media must disable server WriteTimeout", w)
	}
}

func TestPoolAndTimeoutEnvOverrides(t *testing.T) {
	validEnv(t)
	t.Setenv("CF_DB_MAX_CONNS", "16")
	t.Setenv("CF_DB_MIN_CONNS", "2")
	t.Setenv("CF_DB_MAX_CONN_LIFETIME", "15m")
	t.Setenv("CF_DB_MAX_CONN_IDLE_TIME", "2m")
	t.Setenv("CF_DB_HEALTH_CHECK_PERIOD", "30s")
	t.Setenv("CF_HTTP_WRITE_TIMEOUT", "45s")
	t.Setenv("CF_HTTP_READ_TIMEOUT", "12s")
	t.Setenv("CF_RATE_LIMIT_ENABLED", "false")
	t.Setenv("CF_CACHE_TTL", "15s")
	c, err := FromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if c.MaxConnections != 16 || c.MinConnections != 2 {
		t.Fatal("pool conns", c.MaxConnections, c.MinConnections)
	}
	if c.MaxConnLifetime != 15*time.Minute || c.MaxConnIdleTime != 2*time.Minute || c.HealthCheckPeriod != 30*time.Second {
		t.Fatal("pool timings", c.MaxConnLifetime, c.MaxConnIdleTime, c.HealthCheckPeriod)
	}
	if c.WriteTimeout != 45*time.Second || c.ReadTimeout != 12*time.Second {
		t.Fatal("http timeouts", c.WriteTimeout, c.ReadTimeout)
	}
	if c.RateLimitEnabled || c.CacheTTL != 15*time.Second {
		t.Fatal("rate/cache", c.RateLimitEnabled, c.CacheTTL)
	}
}
