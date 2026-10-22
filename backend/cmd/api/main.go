package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"courseforge/backend/internal/activity"
	"courseforge/backend/internal/administration"
	"courseforge/backend/internal/ai"
	"courseforge/backend/internal/api"
	"courseforge/backend/internal/cache"
	"courseforge/backend/internal/career"
	"courseforge/backend/internal/certificates"
	"courseforge/backend/internal/config"
	"courseforge/backend/internal/identity"
	"courseforge/backend/internal/jobs"
	"courseforge/backend/internal/knowledge"
	"courseforge/backend/internal/labs"
	"courseforge/backend/internal/learning"
	"courseforge/backend/internal/media"
	"courseforge/backend/internal/observe"
	"courseforge/backend/internal/paths"
	"courseforge/backend/internal/planning"
	"courseforge/backend/internal/playback"
	"courseforge/backend/internal/practice"
	"courseforge/backend/internal/ratelimit"
	"courseforge/backend/internal/spatial"
	"courseforge/backend/internal/store"

	"github.com/KimMachineGun/automemlimit/memlimit"
	_ "go.uber.org/automaxprocs"
)

func main() {
	if err := run(); err != nil {
		slog.Error("API stopped", "error", err)
		os.Exit(1)
	}
}
func run() error {
	// Align GOMAXPROCS with cgroup CPU quota and GOMEMLIMIT with container memory.
	_, _ = memlimit.Set(memlimit.WithRatio(0.9))

	loadEnvFile("/home/ubuntu/CourseForge/.env", ".env", "../.env")
	c, err := config.FromEnv()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	startup, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	pool, err := store.OpenWithConfig(startup, c.DatabaseURL, store.PoolConfig{
		MaxConns:          c.MaxConnections,
		MinConns:          c.MinConnections,
		MaxConnLifetime:   c.MaxConnLifetime,
		MaxConnIdleTime:   c.MaxConnIdleTime,
		HealthCheckPeriod: c.HealthCheckPeriod,
	})
	if err != nil {
		return errors.New("cannot connect to configured PostgreSQL")
	}
	defer pool.Close()
	if c.Migrate {
		if err = store.Migrate(startup, pool); err != nil {
			return err
		}
	}
	readCache, err := cache.Open(c.RedisURL)
	if err != nil {
		return err
	}
	defer readCache.Close()
	mailer, err := identity.NewSMTPFromEnv()
	if err != nil {
		return err
	}
	auth, err := identity.New(pool, identity.Config{PublicOrigin: c.PublicOrigin, CookieSecure: c.CookieSecure, PasswordConcurrency: c.PasswordConcurrency, RegistrationOpen: c.RegistrationOpen, RegistrationMode: c.RegistrationMode, Mailer: mailer})
	if err != nil {
		return err
	}
	app := api.New(pool, auth)
	app.Cache = readCache
	app.CacheTTL = c.CacheTTL
	reports := administration.New(pool)
	reports.Capabilities.RegistrationMode = c.RegistrationMode
	player := playback.New(pool, auth)
	queue, err := jobs.New(pool, jobs.Config{MaxQueued: 5000, MaxQueuedPerUser: 20, Lease: 30 * time.Second})
	if err != nil {
		return err
	}
	pathService := paths.New(pool, queue)
	queue.ResultProjector = paths.ProjectResult
	planner := planning.New(pool)
	planner.Paths = paths.PlanningAdapter{Service: pathService}
	aiService := ai.New(pool)
	deps := apiRouteDeps{
		Auth:         auth,
		Reports:      reports,
		Player:       player,
		Queue:        queue,
		Learning:     learning.New(pool, queue),
		Paths:        pathService,
		Practice:     practice.New(pool, pathService),
		Planner:      planner,
		Certificates: certificates.New(pool),
		Activity:     activity.New(pool),
		Labs:         labs.New(pool),
		AI:           aiService,
		Career:       career.New(pool, aiService),
		Knowledge:    knowledge.New(pool),
		Spatial:      spatial.New(pool),
	}
	deps.Knowledge.Generator = deps.AI
	if knowledge.EmbedderModeFromEnv() != "hash" {
		deps.Knowledge.Embedder = knowledge.AIEmbedder{
			Model: deps.AI.EmbeddingModel,
			Fn:    deps.AI.Embed,
		}
	}
	if c.MediaMode == "embedded" {
		resolver, mediaConfig, closeResolver, err := media.FromEnvironment(c.CookieSecure, os.Getenv)
		if err != nil {
			return err
		}
		defer closeResolver()
		gateway := media.New(player, resolver, mediaConfig)
		defer gateway.Close()
		deps.Media = gateway
	}
	registerAPIRoutes(app.Mux, deps)
	metrics := observe.New(pool)
	if address := firstNonEmpty(c.PprofAddr, os.Getenv("CF_OBSERVABILITY_ADDR")); address != "" {
		closeMetrics, e := metrics.Start(address)
		if e != nil {
			return e
		}
		defer closeMetrics()
	}
	limiter := ratelimit.New(ratelimit.Config{
		Enabled:    c.RateLimitEnabled,
		RPS:        c.RateLimitRPS,
		Burst:      c.RateLimitBurst,
		TrustProxy: c.TrustProxy,
	})
	handler := limiter.Middleware(api.Middleware(metrics.Wrap(app.Handler()), c.RequestTimeout))
	readHeader, readTimeout, writeTimeout, idleTimeout, maxHeader := c.HTTPServerTimeouts()
	server := &http.Server{
		Addr:              c.Address,
		Handler:           handler,
		ReadHeaderTimeout: readHeader,
		ReadTimeout:       readTimeout,
		WriteTimeout:      writeTimeout,
		IdleTimeout:       idleTimeout,
		MaxHeaderBytes:    maxHeader,
	}
	stopped := make(chan error, 1)
	go func() { stopped <- server.ListenAndServe() }()
	slog.Info("CourseForge API listening",
		"address", c.Address,
		"database_connections", c.MaxConnections,
		"database_min_connections", c.MinConnections,
		"rate_limit", c.RateLimitEnabled,
		"cache_ttl", c.CacheTTL.String(),
	)
	select {
	case err = <-stopped:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
	}
	// Drain in-flight requests, then release pool/workers via deferred Close calls.
	drain, cancelDrain := context.WithTimeout(context.Background(), c.ShutdownTimeout)
	defer cancelDrain()
	if err = server.Shutdown(drain); err != nil {
		_ = server.Close()
	}
	listenErr := <-stopped
	if !errors.Is(listenErr, http.ErrServerClosed) {
		return listenErr
	}
	return err
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

func loadEnvFile(paths ...string) {
	for _, p := range paths {
		data, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(data), "\n") {
			line = strings.TrimSpace(line)
			if strings.HasPrefix(line, "#") || !strings.Contains(line, "=") {
				continue
			}
			parts := strings.SplitN(line, "=", 2)
			k := strings.TrimSpace(parts[0])
			v := strings.Trim(strings.TrimSpace(parts[1]), "\"\x27")
			if os.Getenv(k) == "" {
				_ = os.Setenv(k, v)
			}
		}
	}
}
