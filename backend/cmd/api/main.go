package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"courseforge/backend/internal/activity"
	"courseforge/backend/internal/administration"
	"courseforge/backend/internal/api"
	"courseforge/backend/internal/certificates"
	"courseforge/backend/internal/config"
	"courseforge/backend/internal/contract"
	"courseforge/backend/internal/identity"
	"courseforge/backend/internal/jobs"
	"courseforge/backend/internal/learning"
	"courseforge/backend/internal/media"
	"courseforge/backend/internal/observe"
	"courseforge/backend/internal/paths"
	"courseforge/backend/internal/planning"
	"courseforge/backend/internal/playback"
	"courseforge/backend/internal/practice"
	"courseforge/backend/internal/store"
)

func main() {
	if err := run(); err != nil {
		slog.Error("API stopped", "error", err)
		os.Exit(1)
	}
}
func run() error {
	c, err := config.FromEnv()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	startup, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	pool, err := store.Open(startup, c.DatabaseURL, c.MaxConnections)
	if err != nil {
		return errors.New("cannot connect to configured PostgreSQL")
	}
	defer pool.Close()
	if c.Migrate {
		if err = store.Migrate(startup, pool); err != nil {
			return err
		}
	}
	mailer, err := identity.NewSMTPFromEnv()
	if err != nil {
		return err
	}
	auth, err := identity.New(pool, identity.Config{PublicOrigin: c.PublicOrigin, CookieSecure: c.CookieSecure, PasswordConcurrency: c.PasswordConcurrency, RegistrationOpen: c.RegistrationOpen, RegistrationMode: c.RegistrationMode, Mailer: mailer})
	if err != nil {
		return err
	}
	app := api.New(pool, auth)
	contract.Register(app.Mux)
	auth.RegisterAdminRoutes(app.Mux)
	reports := administration.New(pool)
	reports.Capabilities.RegistrationMode = c.RegistrationMode
	reports.Register(app.Mux, auth)
	player := playback.New(pool, auth)
	player.Register(app.Mux)
	queue, err := jobs.New(pool, jobs.Config{MaxQueued: 5000, MaxQueuedPerUser: 20, Lease: 30 * time.Second})
	if err != nil {
		return err
	}
	queue.Register(app.Mux, auth)
	learning.New(pool, queue).Register(app.Mux, auth)
	pathService := paths.New(pool, queue)
	queue.ResultProjector = paths.ProjectResult
	pathService.Register(app.Mux, auth)
	practice.New(pool, pathService).Register(app.Mux, auth)
	planner := planning.New(pool)
	planner.Paths = paths.PlanningAdapter{Service: pathService}
	planner.Register(app.Mux, auth)
	certificates.New(pool).Register(app.Mux, auth)
	activity.New(pool).Register(app.Mux, auth)
	if c.MediaMode == "embedded" {
		resolver, mediaConfig, closeResolver, err := media.FromEnvironment(c.CookieSecure, os.Getenv)
		if err != nil {
			return err
		}
		defer closeResolver()
		gateway := media.New(player, resolver, mediaConfig)
		defer gateway.Close()
		gateway.Register(app.Mux, auth)
	}
	metrics := observe.New(pool)
	if address := os.Getenv("CF_OBSERVABILITY_ADDR"); address != "" {
		closeMetrics, e := metrics.Start(address)
		if e != nil {
			return e
		}
		defer closeMetrics()
	}
	server := &http.Server{Addr: c.Address, Handler: api.Middleware(metrics.Wrap(app.Handler()), c.RequestTimeout), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10}
	stopped := make(chan error, 1)
	go func() { stopped <- server.ListenAndServe() }()
	slog.Info("CourseForge API listening", "address", c.Address, "database_connections", c.MaxConnections)
	select {
	case err = <-stopped:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
	}
	drain, cancelDrain := context.WithTimeout(context.Background(), 15*time.Second)
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
