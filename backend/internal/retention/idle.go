package retention

import (
	"context"
	"time"
)

// IdleBatchLimit is the per-kind DELETE/UPDATE bound used by worker idle sweeps.
const IdleBatchLimit = 100

// IdleSweepInterval is the minimum gap between idle retention passes on one
// worker goroutine so empty claim loops do not hammer cleanup.
const IdleSweepInterval = 30 * time.Second

// DrainOrder is the contract ordering for draining a finite backlog. Dependency
// kinds run first; independent event/token/admission/telemetry kinds follow.
var DrainOrder = []Kind{
	KindActivityExpiry,
	KindPlaybackExpiry,
	KindActivityLeases,
	KindPlaybackLeases,
	KindActivityDetail,
	KindPlaybackDetail,
	KindAuthSessions,
	KindAccessEvents,
	KindAdminAudit,
	KindAccountTokens,
	KindLoginLimits,
	KindActivityOpenLimits,
	KindPlayerTelemetry,
}

// IdleStats summarizes one IdleSweep without private IDs or row payloads.
type IdleStats struct {
	KindsRun int
	Changed  int64
	ByKind   map[string]int64
}

// IdleSweep runs one bounded Cleanup per DrainOrder kind. Partial progress is
// returned if a later kind fails. Call only from worker idle paths (no job
// lease held). No HTTP route or API-process startup path invokes this.
func (s *Service) IdleSweep(ctx context.Context, limitPerKind int) (IdleStats, error) {
	stats := IdleStats{ByKind: make(map[string]int64, len(DrainOrder))}
	if limitPerKind < 1 {
		limitPerKind = IdleBatchLimit
	}
	if limitPerKind > 1000 {
		limitPerKind = 1000
	}
	for _, kind := range DrainOrder {
		res, err := s.Cleanup(ctx, kind, limitPerKind)
		stats.KindsRun++
		stats.ByKind[string(kind)] = res.Changed
		stats.Changed += res.Changed
		if err != nil {
			return stats, err
		}
	}
	return stats, nil
}
