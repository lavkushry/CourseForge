package api_test

import (
	"context"
	"io"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"courseforge/backend/internal/cache"
)

type countingCache struct {
	inner cache.Cache
	sets  atomic.Int64
	gets  atomic.Int64
}

func (c *countingCache) Get(ctx context.Context, key string) ([]byte, bool, error) {
	c.gets.Add(1)
	return c.inner.Get(ctx, key)
}
func (c *countingCache) Set(ctx context.Context, key string, value []byte, ttl time.Duration) error {
	c.sets.Add(1)
	return c.inner.Set(ctx, key, value, ttl)
}
func (c *countingCache) Delete(ctx context.Context, key string) error {
	return c.inner.Delete(ctx, key)
}
func (c *countingCache) DeletePrefix(ctx context.Context, prefix string) error {
	return c.inner.DeletePrefix(ctx, prefix)
}
func (c *countingCache) Close() error { return c.inner.Close() }

func (b browser) do(t *testing.T, method, path string, headers map[string]string) (int, http.Header, []byte) {
	t.Helper()
	r, err := http.NewRequest(method, b.base+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	r.Header.Set("Origin", b.base)
	if b.csrf != "" {
		r.Header.Set("X-CSRF-Token", b.csrf)
	}
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	res, err := b.client.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	data, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	return res.StatusCode, res.Header.Clone(), data
}

func enableReadCache(t *testing.T, f fixture) *countingCache {
	t.Helper()
	c := &countingCache{inner: cache.NewMemory(1000)}
	f.app.Cache = c
	f.app.CacheTTL = time.Minute
	return c
}

func TestAnonymousHomeFeedAndTrendingCacheHitMissAndInvalidation(t *testing.T) {
	f := setup(t)
	enableReadCache(t, f)
	anon := guest(f)
	admin := f.login(t, "admin")

	status, hdr, body := anon.do(t, "GET", "/api/v1/streaming/trending", nil)
	if status != 200 || hdr.Get("X-Cache") != "MISS" {
		t.Fatalf("trending miss: status=%d x-cache=%s body=%s", status, hdr.Get("X-Cache"), body)
	}
	if hdr.Get("Cache-Control") != "public, max-age=30, stale-while-revalidate=60" || hdr.Get("ETag") == "" {
		t.Fatalf("trending public headers: cc=%q etag=%q", hdr.Get("Cache-Control"), hdr.Get("ETag"))
	}
	if hdr.Get("Vary") != "Cookie" {
		t.Fatalf("public responses must Vary on Cookie, got %q", hdr.Get("Vary"))
	}
	status, hdr, body2 := anon.do(t, "GET", "/api/v1/streaming/trending", nil)
	if status != 200 || hdr.Get("X-Cache") != "HIT" || string(body2) != string(body) {
		t.Fatalf("trending hit: status=%d x-cache=%s", status, hdr.Get("X-Cache"))
	}

	status, hdr, feed := anon.do(t, "GET", "/api/v1/streaming/home-feed", nil)
	if status != 200 || hdr.Get("X-Cache") != "MISS" {
		t.Fatalf("home-feed miss: status=%d x-cache=%s", status, hdr.Get("X-Cache"))
	}
	status, hdr, _ = anon.do(t, "GET", "/api/v1/streaming/home-feed", nil)
	if status != 200 || hdr.Get("X-Cache") != "HIT" {
		t.Fatalf("home-feed hit: status=%d x-cache=%s", status, hdr.Get("X-Cache"))
	}

	// Authenticated home-feed must not be served from the anonymous public cache entry.
	alice := f.login(t, "alice")
	status, hdr, _ = alice.do(t, "GET", "/api/v1/streaming/home-feed", nil)
	if status != 200 {
		t.Fatalf("auth home-feed status %d", status)
	}
	if hdr.Get("X-Cache") != "" || hdr.Get("Cache-Control") != "no-store" {
		t.Fatalf("auth home-feed must be personal no-store, got x-cache=%q cc=%q", hdr.Get("X-Cache"), hdr.Get("Cache-Control"))
	}
	expect(t, alice, "PUT", "/api/v1/lessons/lesson-z/progress", map[string]any{"position": 40, "percent": 30}, 200, nil)
	var authFeed []byte
	status, hdr, authFeed = alice.do(t, "GET", "/api/v1/streaming/home-feed", nil)
	if status != 200 || hdr.Get("Cache-Control") != "no-store" {
		t.Fatalf("auth personalized feed: status=%d cc=%s", status, hdr.Get("Cache-Control"))
	}
	if string(authFeed) == string(feed) {
		t.Fatal("authenticated home-feed unexpectedly identical to anonymous cached feed")
	}

	expect(t, admin, "PATCH", "/api/v1/admin/courses/course-b", map[string]any{"published": false, "expected_version": 1}, 200, nil)
	status, hdr, _ = anon.do(t, "GET", "/api/v1/streaming/trending", nil)
	if status != 200 || hdr.Get("X-Cache") != "MISS" {
		t.Fatalf("trending after catalog write should miss: x-cache=%s", hdr.Get("X-Cache"))
	}
	status, hdr, _ = anon.do(t, "GET", "/api/v1/streaming/home-feed", nil)
	if status != 200 || hdr.Get("X-Cache") != "MISS" {
		t.Fatalf("home-feed after catalog write should miss: x-cache=%s", hdr.Get("X-Cache"))
	}
}

func TestAnonymousCatalogAndFeedETagNotModified(t *testing.T) {
	f := setup(t)
	enableReadCache(t, f)
	anon := guest(f)

	status, hdr, _ := anon.do(t, "GET", "/api/v1/public/courses", nil)
	if status != 200 {
		t.Fatal(status)
	}
	etag := hdr.Get("ETag")
	if etag == "" || hdr.Get("Cache-Control") != "public, max-age=30, stale-while-revalidate=60" {
		t.Fatalf("public catalog headers: etag=%q cc=%q", etag, hdr.Get("Cache-Control"))
	}
	status, hdr, body := anon.do(t, "GET", "/api/v1/public/courses", map[string]string{"If-None-Match": etag})
	if status != 304 || len(body) != 0 {
		t.Fatalf("catalog 304: status=%d len=%d cc=%s", status, len(body), hdr.Get("Cache-Control"))
	}
	if hdr.Get("ETag") != etag {
		t.Fatalf("304 etag mismatch %q vs %q", hdr.Get("ETag"), etag)
	}

	status, hdr, _ = anon.do(t, "GET", "/api/v1/streaming/home-feed", nil)
	etag = hdr.Get("ETag")
	if status != 200 || etag == "" {
		t.Fatalf("home-feed first fetch: status=%d etag=%q", status, etag)
	}
	status, hdr, body = anon.do(t, "GET", "/api/v1/streaming/home-feed", map[string]string{"If-None-Match": etag})
	if status != 304 || len(body) != 0 || hdr.Get("ETag") != etag {
		t.Fatalf("home-feed 304: status=%d etag=%s", status, hdr.Get("ETag"))
	}

	alice := f.login(t, "alice")
	status, hdr, _ = alice.do(t, "GET", "/api/v1/public/courses", nil)
	if status != 200 || hdr.Get("Cache-Control") != "no-store" || hdr.Get("ETag") != "" {
		t.Fatalf("authenticated public catalog must stay no-store without etag: cc=%q etag=%q", hdr.Get("Cache-Control"), hdr.Get("ETag"))
	}
}

func TestTrendingSingleflightCollapsesConcurrentMisses(t *testing.T) {
	f := setup(t)
	c := enableReadCache(t, f)
	anon := guest(f)

	const n = 40
	var wg sync.WaitGroup
	var failed atomic.Int64
	wg.Add(n)
	for range n {
		go func() {
			defer wg.Done()
			r, err := http.NewRequest("GET", anon.base+"/api/v1/streaming/trending", nil)
			if err != nil {
				failed.Add(1)
				return
			}
			res, err := anon.client.Do(r)
			if err != nil {
				failed.Add(1)
				return
			}
			_, _ = io.Copy(io.Discard, res.Body)
			res.Body.Close()
			if res.StatusCode != 200 {
				failed.Add(1)
			}
		}()
	}
	wg.Wait()
	if failed.Load() != 0 {
		t.Fatalf("concurrent trending failed (%d)", failed.Load())
	}
	if sets := c.sets.Load(); sets != 1 {
		t.Fatalf("singleflight should Set once on concurrent miss, got %d sets", sets)
	}
}

func TestReadinessCachesDBPingForOneSecond(t *testing.T) {
	f := setup(t)
	anon := guest(f)

	status, _, body := anon.do(t, "GET", "/health/ready", nil)
	if status != 200 || string(body) == "" {
		t.Fatalf("ready warm: %d %s", status, body)
	}
	status, _, _ = anon.do(t, "GET", "/health/live", nil)
	if status != 200 {
		t.Fatal("live must stay trivial")
	}

	f.app.Pool.Close()
	status, _, _ = anon.do(t, "GET", "/health/ready", nil)
	if status != 200 {
		t.Fatalf("ready should use 1s cached ping after pool close, got %d", status)
	}

	deadline := time.Now().Add(3 * time.Second)
	var last int
	for time.Now().Before(deadline) {
		time.Sleep(200 * time.Millisecond)
		last, _, _ = anon.do(t, "GET", "/health/ready", nil)
		if last == 503 {
			return
		}
	}
	t.Fatalf("ready did not expire cached ping; last status=%d", last)
}
