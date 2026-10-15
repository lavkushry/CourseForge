package cache_test

import (
	"context"
	"testing"
	"time"

	"courseforge/backend/internal/cache"
)

func TestMemoryTTLGetSetDeletePrefix(t *testing.T) {
	t.Parallel()
	m := cache.NewMemory(100)
	ctx := context.Background()
	if err := m.Set(ctx, "catalog/list/a", []byte("one"), 50*time.Millisecond); err != nil {
		t.Fatal(err)
	}
	if err := m.Set(ctx, "catalog/list/b", []byte("two"), time.Hour); err != nil {
		t.Fatal(err)
	}
	if err := m.Set(ctx, "other", []byte("x"), time.Hour); err != nil {
		t.Fatal(err)
	}
	got, ok, err := m.Get(ctx, "catalog/list/a")
	if err != nil || !ok || string(got) != "one" {
		t.Fatalf("miss: %v %v %q", ok, err, got)
	}
	time.Sleep(60 * time.Millisecond)
	if _, ok, err = m.Get(ctx, "catalog/list/a"); err != nil || ok {
		t.Fatal("expired entry still present")
	}
	if err = m.DeletePrefix(ctx, "catalog/list"); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ = m.Get(ctx, "catalog/list/b"); ok {
		t.Fatal("prefix delete missed")
	}
	if _, ok, _ = m.Get(ctx, "other"); !ok {
		t.Fatal("unrelated key deleted")
	}
	_ = m.Delete(ctx, "other")
	if _, ok, _ = m.Get(ctx, "other"); ok {
		t.Fatal("delete failed")
	}
}

func TestMemoryBoundsCardinality(t *testing.T) {
	t.Parallel()
	m := cache.NewMemory(2)
	ctx := context.Background()
	_ = m.Set(ctx, "a", []byte("1"), time.Hour)
	_ = m.Set(ctx, "b", []byte("2"), time.Hour)
	_ = m.Set(ctx, "c", []byte("3"), time.Hour)
	count := 0
	for _, k := range []string{"a", "b", "c"} {
		if _, ok, _ := m.Get(ctx, k); ok {
			count++
		}
	}
	if count > 2 {
		t.Fatalf("expected bounded cache, got %d live keys", count)
	}
}

func TestOpenDefaultsToMemory(t *testing.T) {
	t.Parallel()
	c, err := cache.Open("")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if _, ok := c.(*cache.Memory); !ok {
		t.Fatalf("expected memory cache, got %T", c)
	}
}
