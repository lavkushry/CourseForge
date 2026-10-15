package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"log/slog"
	"os"
	"os/signal"
	"strconv"
	"sync"
	"syscall"
	"time"

	"courseforge/backend/internal/career"
	"courseforge/backend/internal/jobs"
	"courseforge/backend/internal/learning"
	"courseforge/backend/internal/paths"
	"courseforge/backend/internal/publication"
	"courseforge/backend/internal/store"

	"github.com/jackc/pgx/v5"
)

func main() {
	if e := run(); e != nil {
		slog.Error("Job worker stopped", "error", e)
		os.Exit(1)
	}
}
func run() error {
	resource := os.Getenv("CF_JOB_RESOURCE")
	if resource != "ai" && resource != "media_processing" && resource != "lab" && resource != "export" {
		return errors.New("CF_JOB_RESOURCE must select a configured resource")
	}
	parallel := 1
	if value := os.Getenv("CF_JOB_PARALLELISM"); value != "" {
		n, e := strconv.Atoi(value)
		if e != nil || n < 1 || n > 16 {
			return errors.New("CF_JOB_PARALLELISM must be1..16")
		}
		parallel = n
	}
	if os.Getenv("CF_DATABASE_URL") == "" {
		return errors.New("CF_DATABASE_URL is required")
	}
	executor, e := jobs.NewHTTPExecutor(os.Getenv("CF_JOB_EXECUTOR_URL"), os.Getenv("CF_JOB_EXECUTOR_TOKEN"), 2*time.Minute)
	if e != nil {
		return errors.New("invalid configured executor")
	}
	defer executor.Close()
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	startup, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	pool, e := store.Open(startup, os.Getenv("CF_DATABASE_URL"), 4)
	if e != nil {
		return errors.New("cannot connect to configured PostgreSQL")
	}
	defer pool.Close()
	q, e := jobs.New(pool, jobs.Config{MaxQueued: 5000, MaxQueuedPerUser: 20, Lease: 30 * time.Second})
	if e != nil {
		return e
	}
	learner := learning.New(pool, q)
	pathService := paths.New(pool, q)
	publish := (publication.Router{Learning: learner.PublishResult, Paths: pathService.PublishResult}).Publish
	workerID := make([]byte, 16)
	if _, e = rand.Read(workerID); e != nil {
		return e
	}
	prefix := hex.EncodeToString(workerID)
	var wg sync.WaitGroup
	// Export workers also drain career resume LaTeX compile jobs (tectonic/latexmk)
	// and poll apply-early careers boards (Greenhouse/Lever/Ashby) for in-app alerts.
	if resource == "export" {
		wg.Go(func() {
			career.RunCompileLoop(ctx, pool, career.CompileLaTeX, time.Second)
		})
		wg.Go(func() {
			career.RunAlertPollLoop(ctx, pool, nil, 15*time.Second)
		})
	}
	for i := 0; i < parallel; i++ {
		worker := prefix + "-" + strconv.Itoa(i)
		wg.Go(func() {
			for ctx.Err() == nil {
				claim, stopClaim := context.WithTimeout(ctx, 5*time.Second)
				lease, e := q.Claim(claim, resource, worker)
				stopClaim()
				if e == nil {
					_ = q.ExecuteLeaseWithPublisher(ctx, lease, executor, publish)
				} else if !errors.Is(e, pgx.ErrNoRows) && !errors.Is(e, jobs.ErrBusy) && ctx.Err() == nil {
					slog.Warn("Job claim unavailable", "resource", resource)
				}
				wait := time.NewTimer(time.Second)
				select {
				case <-ctx.Done():
					wait.Stop()
					return
				case <-wait.C:
				}
			}
		})
	}
	slog.Info("Job worker started", "resource", resource, "parallelism", parallel, "database_connections", 4)
	wg.Wait()
	return nil
}
