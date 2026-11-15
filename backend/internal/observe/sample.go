package observe

import (
	"context"
	"sync"
	"time"
)

// Hot-path info logs (media admit, playlist fetch) are sampled so concurrent
// learners cannot unbounded-grow slog volume. Errors and lease state changes
// always emit via Logger(...).Error / Info without sampling.

const (
	defaultSampleInterval = 2 * time.Second
	sampleCardinalityCap  = 20_000
)

type logSampler struct {
	mu       sync.Mutex
	last     map[string]time.Time
	interval time.Duration
	now      func() time.Time
}

func newLogSampler(interval time.Duration) *logSampler {
	if interval <= 0 {
		interval = defaultSampleInterval
	}
	return &logSampler{last: make(map[string]time.Time), interval: interval, now: time.Now}
}

func (s *logSampler) allow(key string) bool {
	if key == "" {
		key = "_"
	}
	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()
	if t, ok := s.last[key]; ok && now.Sub(t) < s.interval {
		return false
	}
	s.last[key] = now
	if len(s.last) > sampleCardinalityCap {
		for k, t := range s.last {
			if now.Sub(t) > 10*time.Minute {
				delete(s.last, k)
			}
		}
		if len(s.last) > sampleCardinalityCap {
			for k := range s.last {
				delete(s.last, k)
				if len(s.last) < sampleCardinalityCap*4/5 {
					break
				}
			}
		}
	}
	return true
}

var hotPathSampler = newLogSampler(defaultSampleInterval)

// SampledInfo logs at Info at most once per key per interval.
// Use for repetitive media/playlist admissions. Prefer Error/Warn for failures.
func SampledInfo(ctx context.Context, key, msg string, args ...any) {
	if !hotPathSampler.allow(key) {
		return
	}
	Logger(ctx).Info(msg, args...)
}

// AlwaysError always emits an error log (never sampled).
func AlwaysError(ctx context.Context, msg string, args ...any) {
	Logger(ctx).Error(msg, args...)
}

// AlwaysWarn always emits a warn log (never sampled) for lease failures / denials.
func AlwaysWarn(ctx context.Context, msg string, args ...any) {
	Logger(ctx).Warn(msg, args...)
}

// ResetSamplerForTest clears sampling state (unit tests only).
func ResetSamplerForTest() {
	hotPathSampler.mu.Lock()
	hotPathSampler.last = make(map[string]time.Time)
	hotPathSampler.mu.Unlock()
}

// SetSamplerIntervalForTest overrides the hot-path interval (unit tests only).
func SetSamplerIntervalForTest(d time.Duration, now func() time.Time) {
	hotPathSampler.mu.Lock()
	hotPathSampler.interval = d
	if now != nil {
		hotPathSampler.now = now
	}
	hotPathSampler.mu.Unlock()
}
