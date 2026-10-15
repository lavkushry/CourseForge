package cache

import (
	"context"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// Redis adapts go-redis to Cache. Keys are namespaced under "cf:".
type Redis struct {
	client *redis.Client
}

// NewRedis connects using a redis:// or rediss:// URL.
func NewRedis(rawURL string) (*Redis, error) {
	opt, err := redis.ParseURL(rawURL)
	if err != nil {
		return nil, fmt.Errorf("REDIS_URL: %w", err)
	}
	if u, err := url.Parse(rawURL); err != nil || (u.Scheme != "redis" && u.Scheme != "rediss") {
		return nil, fmt.Errorf("REDIS_URL must use redis:// or rediss://")
	}
	client := redis.NewClient(opt)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err = client.Ping(ctx).Err(); err != nil {
		_ = client.Close()
		return nil, fmt.Errorf("redis unavailable: %w", err)
	}
	return &Redis{client: client}, nil
}

func (r *Redis) key(k string) string { return "cf:" + k }

func (r *Redis) Get(ctx context.Context, key string) ([]byte, bool, error) {
	b, err := r.client.Get(ctx, r.key(key)).Bytes()
	if err == redis.Nil {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return b, true, nil
}

func (r *Redis) Set(ctx context.Context, key string, value []byte, ttl time.Duration) error {
	return r.client.Set(ctx, r.key(key), value, ttl).Err()
}

func (r *Redis) Delete(ctx context.Context, key string) error {
	return r.client.Del(ctx, r.key(key)).Err()
}

func (r *Redis) DeletePrefix(ctx context.Context, prefix string) error {
	pattern := r.key(prefix) + "*"
	var cursor uint64
	for {
		keys, next, err := r.client.Scan(ctx, cursor, pattern, 100).Result()
		if err != nil {
			return err
		}
		if len(keys) > 0 {
			filtered := keys[:0]
			ns := r.key(prefix)
			for _, k := range keys {
				if k == ns || strings.HasPrefix(k, ns+"/") {
					filtered = append(filtered, k)
				}
			}
			if len(filtered) > 0 {
				if err = r.client.Del(ctx, filtered...).Err(); err != nil {
					return err
				}
			}
		}
		cursor = next
		if cursor == 0 {
			return nil
		}
	}
}

func (r *Redis) Close() error { return r.client.Close() }
