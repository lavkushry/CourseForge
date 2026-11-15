package ratelimit

import (
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync/atomic"

	"courseforge/backend/internal/httpx"
)

// Class is a service-level admission priority under overload.
// Critical work (lease/start/media) keeps reserved capacity; lower classes shed first.
type Class int

const (
	ClassCritical Class = iota // lease acquire/claim/release and media delivery
	ClassPulse                 // playback pulse and QoE telemetry
	ClassBrowse                // catalog, search, dashboard, ordinary reads
	ClassAI                    // tutor / job submit and other expensive work
	classCount
)

// String returns a stable label for logs and Retry-After classification headers.
func (c Class) String() string {
	switch c {
	case ClassCritical:
		return "critical"
	case ClassPulse:
		return "pulse"
	case ClassBrowse:
		return "browse"
	case ClassAI:
		return "ai"
	default:
		return "browse"
	}
}

// PriorityConfig sizes non-blocking concurrency slots per class.
// Zero values fall back to defaults that keep critical capacity ahead of AI/browse.
type PriorityConfig struct {
	Enabled       bool
	CriticalSlots int
	PulseSlots    int
	BrowseSlots   int
	AISlots       int
	Exempt        func(*http.Request) bool
}

// PriorityFromEnv builds an enabled PriorityConfig from CF_PRIORITY_*_SLOTS.
// Unset or non-positive values keep NewPriority defaults (critical ahead of browse/AI).
//
//	CF_PRIORITY_CRITICAL_SLOTS
//	CF_PRIORITY_PULSE_SLOTS
//	CF_PRIORITY_BROWSE_SLOTS
//	CF_PRIORITY_AI_SLOTS
func PriorityFromEnv(getenv func(string) string) PriorityConfig {
	if getenv == nil {
		getenv = os.Getenv
	}
	return PriorityConfig{
		Enabled:       true,
		CriticalSlots: envSlot(getenv, "CF_PRIORITY_CRITICAL_SLOTS"),
		PulseSlots:    envSlot(getenv, "CF_PRIORITY_PULSE_SLOTS"),
		BrowseSlots:   envSlot(getenv, "CF_PRIORITY_BROWSE_SLOTS"),
		AISlots:       envSlot(getenv, "CF_PRIORITY_AI_SLOTS"),
	}
}

func envSlot(getenv func(string) string, key string) int {
	raw := strings.TrimSpace(getenv(key))
	if raw == "" {
		return 0
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 1 {
		return 0
	}
	if n > 1_000_000 {
		return 1_000_000
	}
	return n
}

// PriorityLimiter is a Netflix PlayAPI-style partitioned concurrency gate:
// each class has its own budget; excess critical capacity is never stolen by AI/browse.
type PriorityLimiter struct {
	cfg   PriorityConfig
	slots [classCount]chan struct{}
	sheds [classCount]atomic.Int64
}

// NewPriority builds a priority limiter. Disabled configs return a no-op wrapper.
func NewPriority(cfg PriorityConfig) *PriorityLimiter {
	if cfg.CriticalSlots < 1 {
		cfg.CriticalSlots = 256
	}
	if cfg.PulseSlots < 1 {
		cfg.PulseSlots = 512
	}
	if cfg.BrowseSlots < 1 {
		cfg.BrowseSlots = 128
	}
	if cfg.AISlots < 1 {
		cfg.AISlots = 32
	}
	if cfg.Exempt == nil {
		cfg.Exempt = DefaultExempt
	}
	p := &PriorityLimiter{cfg: cfg}
	p.slots[ClassCritical] = make(chan struct{}, cfg.CriticalSlots)
	p.slots[ClassPulse] = make(chan struct{}, cfg.PulseSlots)
	p.slots[ClassBrowse] = make(chan struct{}, cfg.BrowseSlots)
	p.slots[ClassAI] = make(chan struct{}, cfg.AISlots)
	return p
}

// Classify maps method+path to an admission class without reading the body.
func Classify(method, path string) Class {
	path = strings.TrimSuffix(path, "/")
	if path == "" {
		path = "/"
	}
	switch {
	case isAIPath(path):
		return ClassAI
	case isCriticalPlayback(method, path):
		return ClassCritical
	case isPulsePath(method, path):
		return ClassPulse
	default:
		return ClassBrowse
	}
}

func isAIPath(path string) bool {
	switch {
	case strings.HasPrefix(path, "/api/v1/tutor"),
		strings.HasPrefix(path, "/api/v1/ai/"),
		strings.HasPrefix(path, "/api/v1/jobs"),
		strings.HasPrefix(path, "/api/v1/knowledge/jobs"),
		strings.HasPrefix(path, "/api/v1/labs/") && strings.Contains(path, "/submit"):
		return true
	default:
		return false
	}
}

func isCriticalPlayback(method, path string) bool {
	if !strings.HasPrefix(path, "/api/v1/playback/sessions") {
		return false
	}
	switch method {
	case http.MethodPost:
		// Open lease, claim, or release — never pulse (handled separately).
		if path == "/api/v1/playback/sessions" {
			return true
		}
		if strings.HasSuffix(path, "/claim") || strings.HasSuffix(path, "/release") {
			return true
		}
		return false
	case http.MethodGet, http.MethodHead:
		return strings.Contains(path, "/media") ||
			strings.Contains(path, "/hls/") ||
			strings.HasSuffix(path, "/poster")
	default:
		return false
	}
}

func isPulsePath(method, path string) bool {
	if method != http.MethodPost {
		return false
	}
	if strings.HasSuffix(path, "/pulse") && strings.HasPrefix(path, "/api/v1/playback/sessions/") {
		return true
	}
	return path == "/api/v1/player/telemetry"
}

// Try acquires one slot for class without waiting. Caller must release.
func (p *PriorityLimiter) Try(class Class) (release func(), ok bool) {
	if p == nil || !p.cfg.Enabled {
		return func() {}, true
	}
	if class < 0 || class >= classCount {
		class = ClassBrowse
	}
	select {
	case p.slots[class] <- struct{}{}:
		return func() { <-p.slots[class] }, true
	default:
		return nil, false
	}
}

// InUse reports occupied slots for tests and dashboards.
func (p *PriorityLimiter) InUse(class Class) int {
	if p == nil || class < 0 || class >= classCount {
		return 0
	}
	return len(p.slots[class])
}

// Capacity reports configured slot budget for dashboards (never a learner claim).
func (p *PriorityLimiter) Capacity(class Class) int {
	if p == nil || class < 0 || class >= classCount {
		return 0
	}
	return cap(p.slots[class])
}

// Sheds returns cumulative admission rejects for a class (no path/learner labels).
func (p *PriorityLimiter) Sheds(class Class) int64 {
	if p == nil || class < 0 || class >= classCount {
		return 0
	}
	return p.sheds[class].Load()
}

// Classes returns the admission classes for dashboard iteration.
func Classes() []Class {
	return []Class{ClassCritical, ClassPulse, ClassBrowse, ClassAI}
}

// Middleware sheds low-priority work with a cheap 429/503 before handler work.
// Critical saturation uses 503 (retry); browse/AI use 429.
func (p *PriorityLimiter) Middleware(next http.Handler) http.Handler {
	if p == nil || !p.cfg.Enabled {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if p.cfg.Exempt(r) {
			next.ServeHTTP(w, r)
			return
		}
		class := Classify(r.Method, r.URL.Path)
		release, ok := p.Try(class)
		if !ok {
			p.sheds[class].Add(1)
			w.Header().Set("Retry-After", "1")
			w.Header().Set("X-CourseForge-Admission-Class", class.String())
			status := http.StatusTooManyRequests
			code := "admission_shed"
			msg := "Server is busy; retry shortly"
			if class == ClassCritical {
				status = http.StatusServiceUnavailable
				code = "admission_saturated"
				msg = "Playback capacity is temporarily saturated"
			}
			httpx.Error(w, status, code, msg)
			return
		}
		defer release()
		w.Header().Set("X-CourseForge-Admission-Class", class.String())
		next.ServeHTTP(w, r)
	})
}
