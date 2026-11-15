// The media entrypoint isolates long-lived byte transfers from application calls.
// It shares authoritative authentication/playback state, never local ownership.
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

	"courseforge/backend/internal/api"
	"courseforge/backend/internal/config"
	"courseforge/backend/internal/httpx"
	"courseforge/backend/internal/identity"
	"courseforge/backend/internal/media"
	"courseforge/backend/internal/observe"
	"courseforge/backend/internal/playback"
	"courseforge/backend/internal/ratelimit"
	"courseforge/backend/internal/store"

	"github.com/KimMachineGun/automemlimit/memlimit"
	_ "go.uber.org/automaxprocs"
)

func main() {
	if err := run(); err != nil {
		slog.Error("Media gateway stopped", "error", err)
		os.Exit(1)
	}
}

func run() error {
	_, _ = memlimit.Set(memlimit.WithRatio(0.9))
	loadEnvFile("/home/ubuntu/CourseForge/.env", ".env", "../.env")
	c, err := config.FromEnv()
	if err != nil {
		return err
	}
	if c.Migrate {
		return errors.New("standalone media gateway requires migrations applied by the release/API entrypoint")
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	startup, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	// Media gateway pool is for lease/auth only; connections are never held while proxying bytes.
	mediaPool := store.PoolConfigFor(store.PoolMediaAuth)
	mediaPool.MaxConns = c.MaxConnections
	mediaPool.MinConns = c.MinConnections
	if mediaPool.MinConns > mediaPool.MaxConns {
		mediaPool.MinConns = mediaPool.MaxConns
	}
	mediaPool.MaxConnLifetime = c.MaxConnLifetime
	mediaPool.MaxConnIdleTime = c.MaxConnIdleTime
	mediaPool.HealthCheckPeriod = c.HealthCheckPeriod
	pool, err := store.OpenWithConfig(startup, c.DatabaseURL, mediaPool)
	if err != nil {
		return errors.New("cannot connect to configured PostgreSQL")
	}
	defer pool.Close()
	auth, err := identity.New(pool, identity.Config{PublicOrigin: c.PublicOrigin, CookieSecure: c.CookieSecure, PasswordConcurrency: c.PasswordConcurrency})
	if err != nil {
		return err
	}
	resolver, mediaConfig, closeResolver, err := media.FromEnvironment(c.CookieSecure, os.Getenv)
	if err != nil {
		return err
	}
	defer closeResolver()
	gateway := media.New(playback.New(pool, auth), resolver, mediaConfig)
	defer gateway.Close()
	mux := http.NewServeMux()
	gateway.Register(mux, auth)
	mux.HandleFunc("GET /health/live", func(w http.ResponseWriter, r *http.Request) {
		httpx.JSON(w, 200, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET /health/ready", func(w http.ResponseWriter, r *http.Request) {
		check, cancel := context.WithTimeout(r.Context(), time.Second)
		defer cancel()
		if pool.Ping(check) != nil {
			httpx.Error(w, 503, "database_unavailable", "Database unavailable")
			return
		}
		httpx.JSON(w, 200, map[string]string{"status": "ok"})
	})
	metrics := observe.New(pool)
	metrics.AttachMedia(gateway.Gauges)
	if circuit, ok := resolver.(interface{ CircuitGauges() observe.CircuitGauges }); ok {
		metrics.AttachCircuit(circuit.CircuitGauges)
	}
	// Media plane keeps its own admission budget so browse/AI saturation on the API
	// replica cannot starve Range delivery. Critical class covers /media and HLS.
	priority := ratelimit.NewPriority(ratelimit.PriorityFromEnv(os.Getenv))
	metrics.AttachAdmission(func() []observe.AdmissionGauges {
		out := make([]observe.AdmissionGauges, 0, 4)
		for _, class := range ratelimit.Classes() {
			out = append(out, observe.AdmissionGauges{
				Class: class.String(), InUse: priority.InUse(class),
				Capacity: priority.Capacity(class), Sheds: priority.Sheds(class),
			})
		}
		return out
	})
	if address := os.Getenv("CF_OBSERVABILITY_ADDR"); address != "" {
		closeMetrics, err := metrics.Start(address)
		if err != nil {
			return err
		}
		defer closeMetrics()
	}
	// Standalone media never sets WriteTimeout: range streams outlive ordinary API deadlines.
	// Product /metrics is loopback-only; pprof stays on CF_OBSERVABILITY_ADDR.
	readHeader, readTimeout, _, idleTimeout, maxHeader := c.HTTPServerTimeouts()
	server := &http.Server{
		Addr: c.Address,
		Handler: metrics.WithLoopbackMetrics(
			priority.Middleware(api.Middleware(metrics.Wrap(mux), c.RequestTimeout)),
		),
		ReadHeaderTimeout: readHeader,
		ReadTimeout:       readTimeout,
		WriteTimeout:      0,
		IdleTimeout:       idleTimeout,
		MaxHeaderBytes:    maxHeader,
	}
	stopped := make(chan error, 1)
	go func() { stopped <- server.ListenAndServe() }()
	slog.Info("CourseForge media gateway listening", "address", c.Address, "database_connections", c.MaxConnections, "transfer_limit", mediaConfig.MaxTransfers)
	select {
	case err = <-stopped:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
	}
	drain, cancelDrain := context.WithTimeout(context.Background(), c.ShutdownTimeout)
	defer cancelDrain()
	if err = server.Shutdown(drain); err != nil {
		_ = server.Close()
	}
	if listenErr := <-stopped; !errors.Is(listenErr, http.ErrServerClosed) {
		return listenErr
	}
	return err
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
