// Package cache provides a small TTL key/value store for hot read endpoints.
package cache

import (
	"context"
	"strings"
	"sync"
	"time"
)

// Cache stores opaque byte values with optional TTL.
type Cache interface {
	Get(ctx context.Context, key string) ([]byte, bool, error)
	Set(ctx context.Context, key string, value []byte, ttl time.Duration) error
	Delete(ctx context.Context, key string) error
	// DeletePrefix removes every key that equals prefix or starts with prefix+"/".
	DeletePrefix(ctx context.Context, prefix string) error
	Close() error
}

type entry struct {
	value     []byte
	expiresAt time.Time
}

// Memory is a process-local TTL map. Suitable for single-replica caches and tests.
type Memory struct {
	mu      sync.RWMutex
	items   map[string]entry
	now     func() time.Time
	maxKeys int
}

// NewMemory builds an in-memory cache. maxKeys bounds cardinality (0 → 10_000).
func NewMemory(maxKeys int) *Memory {
	if maxKeys <= 0 {
		maxKeys = 10_000
	}
	return &Memory{items: make(map[string]entry), now: time.Now, maxKeys: maxKeys}
}

func (m *Memory) Get(_ context.Context, key string) ([]byte, bool, error) {
	m.mu.RLock()
	e, ok := m.items[key]
	m.mu.RUnlock()
	if !ok {
		return nil, false, nil
	}
	if !e.expiresAt.IsZero() && !m.now().Before(e.expiresAt) {
		m.mu.Lock()
		delete(m.items, key)
		m.mu.Unlock()
		return nil, false, nil
	}
	out := make([]byte, len(e.value))
	copy(out, e.value)
	return out, true, nil
}

func (m *Memory) Set(_ context.Context, key string, value []byte, ttl time.Duration) error {
	cp := make([]byte, len(value))
	copy(cp, value)
	var exp time.Time
	if ttl > 0 {
		exp = m.now().Add(ttl)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.items) >= m.maxKeys {
		m.evictExpiredLocked()
	}
	if len(m.items) >= m.maxKeys {
		// Drop an arbitrary key to keep memory bounded under stampede.
		for k := range m.items {
			delete(m.items, k)
			break
		}
	}
	m.items[key] = entry{value: cp, expiresAt: exp}
	return nil
}

func (m *Memory) Delete(_ context.Context, key string) error {
	m.mu.Lock()
	delete(m.items, key)
	m.mu.Unlock()
	return nil
}

func (m *Memory) DeletePrefix(_ context.Context, prefix string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for k := range m.items {
		if k == prefix || strings.HasPrefix(k, prefix+"/") {
			delete(m.items, k)
		}
	}
	return nil
}

func (m *Memory) Close() error {
	m.mu.Lock()
	m.items = map[string]entry{}
	m.mu.Unlock()
	return nil
}

func (m *Memory) evictExpiredLocked() {
	now := m.now()
	for k, e := range m.items {
		if !e.expiresAt.IsZero() && !now.Before(e.expiresAt) {
			delete(m.items, k)
		}
	}
}

// Open selects Redis when REDIS_URL is set, otherwise an in-memory TTL cache.
func Open(redisURL string) (Cache, error) {
	if strings.TrimSpace(redisURL) == "" {
		return NewMemory(10_000), nil
	}
	return NewRedis(redisURL)
}
