package playback

import (
	"context"
	"math"
	"net/http"
	"sync"
	"time"

	"courseforge/backend/internal/httpx"
	"courseforge/backend/internal/identity"
	"courseforge/backend/internal/ratelimit"
)

// TelemetryPayload is the small validated QoE sample from the browser player.
type TelemetryPayload struct {
	SessionID       string `json:"session_id"`
	StartupMs       int    `json:"startup_ms"`
	RebufferMs      int    `json:"rebuffer_ms"`
	PlayMs          int    `json:"play_ms"`
	Errors          int    `json:"errors"`
	BitrateSwitches int    `json:"bitrate_switches"`
}

// TelemetryAggregate is the administrator rollup over a recent window.
type TelemetryAggregate struct {
	Samples       int     `json:"samples"`
	StartupP50Ms  float64 `json:"startup_p50_ms"`
	StartupP95Ms  float64 `json:"startup_p95_ms"`
	RebufferRatio float64 `json:"rebuffer_ratio"`
	ErrorRate     float64 `json:"error_rate"`
	WindowHours   int     `json:"window_hours"`
}

type telemetryLimiter struct {
	mu   sync.Mutex
	last map[string]time.Time
	min  time.Duration
	now  func() time.Time
}

func newTelemetryLimiter(min time.Duration, now func() time.Time) *telemetryLimiter {
	if now == nil {
		now = time.Now
	}
	return &telemetryLimiter{last: make(map[string]time.Time), min: min, now: now}
}

func (l *telemetryLimiter) allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	if t, ok := l.last[key]; ok && now.Sub(t) < l.min {
		return false
	}
	l.last[key] = now
	if len(l.last) > 20_000 {
		for k, t := range l.last {
			if now.Sub(t) > 10*time.Minute {
				delete(l.last, k)
			}
		}
	}
	return true
}

// ValidateTelemetry checks bounds for the POST body (pure; unit-tested).
func ValidateTelemetry(p TelemetryPayload) bool {
	if len(p.SessionID) < 3 || len(p.SessionID) > 200 {
		return false
	}
	if p.StartupMs < 0 || p.StartupMs >= 600_000 {
		return false
	}
	if p.RebufferMs < 0 || p.RebufferMs >= 3_600_000 {
		return false
	}
	if p.PlayMs < 0 || p.PlayMs >= 86_400_000 {
		return false
	}
	if p.Errors < 0 || p.Errors >= 10_000 {
		return false
	}
	if p.BitrateSwitches < 0 || p.BitrateSwitches >= 100_000 {
		return false
	}
	return true
}

func (s *Service) postTelemetry(w http.ResponseWriter, r *http.Request) {
	p, ok := s.principal(w, r)
	if !ok {
		return
	}
	if s.telemetryLimit == nil {
		s.telemetryLimit = newTelemetryLimiter(2*time.Second, s.Now)
	}
	ip := ratelimit.ClientIP(r, false)
	if !s.telemetryLimit.allow(p.UserID + "|" + ip) {
		w.Header().Set("Retry-After", "2")
		httpx.Error(w, http.StatusTooManyRequests, "rate_limited", "Telemetry rate limited")
		return
	}
	var body TelemetryPayload
	if !read(w, r, &body) {
		return
	}
	if !ValidateTelemetry(body) {
		write(w, 422, map[string]string{"detail": "Invalid telemetry payload."})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	var lessonID *string
	var lid string
	err := s.Pool.QueryRow(ctx, `SELECT lesson_id FROM playback_sessions WHERE id=$1 AND user_id=$2`, body.SessionID, p.UserID).Scan(&lid)
	if err == nil && lid != "" {
		lessonID = &lid
	}
	_, err = s.Pool.Exec(ctx, `
		INSERT INTO player_telemetry(user_id,session_id,lesson_id,startup_ms,rebuffer_ms,play_ms,errors,bitrate_switches)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
		p.UserID, body.SessionID, lessonID, body.StartupMs, body.RebufferMs, body.PlayMs, body.Errors, body.BitrateSwitches)
	if err != nil {
		fail(w, err)
		return
	}
	write(w, 202, map[string]any{"ok": true})
}

// AggregateTelemetry computes p50/p95 startup, rebuffer ratio, and error rate.
func AggregateTelemetry(startups []int, rebufferMs, playMs []int64, errorCounts []int) TelemetryAggregate {
	agg := TelemetryAggregate{Samples: len(startups)}
	if len(startups) == 0 {
		return agg
	}
	agg.StartupP50Ms = percentile(startups, 0.50)
	agg.StartupP95Ms = percentile(startups, 0.95)
	var reb, play int64
	var sessionsWithError int
	for i := range startups {
		if i < len(rebufferMs) {
			reb += rebufferMs[i]
		}
		if i < len(playMs) {
			play += playMs[i]
		}
		if i < len(errorCounts) && errorCounts[i] > 0 {
			sessionsWithError++
		}
	}
	if play > 0 {
		agg.RebufferRatio = float64(reb) / float64(play)
	}
	agg.ErrorRate = float64(sessionsWithError) / float64(len(startups))
	return agg
}

func percentile(values []int, p float64) float64 {
	if len(values) == 0 {
		return 0
	}
	cp := append([]int(nil), values...)
	// insertion sort — payloads are small (admin window samples)
	for i := 1; i < len(cp); i++ {
		j := i
		for j > 0 && cp[j-1] > cp[j] {
			cp[j-1], cp[j] = cp[j], cp[j-1]
			j--
		}
	}
	if p <= 0 {
		return float64(cp[0])
	}
	if p >= 1 {
		return float64(cp[len(cp)-1])
	}
	idx := int(math.Ceil(p*float64(len(cp)))) - 1
	if idx < 0 {
		idx = 0
	}
	if idx >= len(cp) {
		idx = len(cp) - 1
	}
	return float64(cp[idx])
}

func (s *Service) telemetryAggregate(w http.ResponseWriter, r *http.Request) {
	p, ok := identity.FromContext(r.Context())
	if !ok {
		write(w, 401, map[string]string{"detail": "Sign in required."})
		return
	}
	if p.Role != "admin" {
		httpx.Error(w, 403, "admin_required", "Administrator access required")
		return
	}
	hours := 24
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	rows, err := s.Pool.Query(ctx, `
		SELECT startup_ms, rebuffer_ms, play_ms, errors
		FROM player_telemetry
		WHERE created_at > now() - make_interval(hours => $1)
		ORDER BY created_at DESC
		LIMIT 5000`, hours)
	if err != nil {
		fail(w, err)
		return
	}
	defer rows.Close()
	var startups []int
	var rebuffers, plays []int64
	var errs []int
	for rows.Next() {
		var start, reb, play, ecount int
		if err = rows.Scan(&start, &reb, &play, &ecount); err != nil {
			fail(w, err)
			return
		}
		startups = append(startups, start)
		rebuffers = append(rebuffers, int64(reb))
		plays = append(plays, int64(play))
		errs = append(errs, ecount)
	}
	agg := AggregateTelemetry(startups, rebuffers, plays, errs)
	agg.WindowHours = hours
	write(w, 200, agg)
}
