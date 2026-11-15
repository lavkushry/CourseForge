package store_test

import (
	"context"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"courseforge/backend/internal/store"
)

// TestJobsPoolSaturationLeavesAPIPoolAcquirable proves the carved jobs pool can
// be fully held without blocking acquires on the playback/API pool.
func TestJobsPoolSaturationLeavesAPIPoolAcquirable(t *testing.T) {
	dsn := os.Getenv("CF_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("CF_TEST_DATABASE_URL not set")
	}
	apiCfg, jobsCfg, err := store.SplitAPIPools(6, 2)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	apiPool, err := store.OpenWithConfig(ctx, dsn, apiCfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(apiPool.Close)
	jobsPool, err := store.OpenWithConfig(ctx, dsn, jobsCfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(jobsPool.Close)

	type hold struct{ release func() }
	var holds []hold
	var mu sync.Mutex
	for i := 0; i < int(jobsCfg.MaxConns); i++ {
		c, err := jobsPool.Acquire(ctx)
		if err != nil {
			t.Fatal("jobs acquire", err)
		}
		conn := c
		mu.Lock()
		holds = append(holds, hold{release: conn.Release})
		mu.Unlock()
	}
	t.Cleanup(func() {
		mu.Lock()
		defer mu.Unlock()
		for _, h := range holds {
			h.release()
		}
	})

	busyCtx, cancel := context.WithTimeout(ctx, 80*time.Millisecond)
	defer cancel()
	if c, err := jobsPool.Acquire(busyCtx); err == nil {
		c.Release()
		t.Fatal("expected jobs pool saturation")
	}

	var ok atomic.Int64
	var wg sync.WaitGroup
	for i := 0; i < int(apiCfg.MaxConns); i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c, err := apiPool.Acquire(ctx)
			if err != nil {
				return
			}
			ok.Add(1)
			c.Release()
		}()
	}
	wg.Wait()
	if ok.Load() != int64(apiCfg.MaxConns) {
		t.Fatalf("API pool starved while jobs saturated: ok=%d want=%d", ok.Load(), apiCfg.MaxConns)
	}
}
