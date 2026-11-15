package jobs

import (
	"context"
	"time"
)

// IdleStats reports bounded maintenance work performed when the claim loop is empty.
type IdleStats struct {
	Parked        int64
	OutboxPruned  int64
	JobsPruned    int64
}

// IdleMaintenance parks exhausted outbox rows and prunes delivered outbox /
// terminal jobs past retention. Call only from worker idle paths (no job lease
// held). Each prune is independently bounded; failures after a successful step
// still return partial stats with the error.
func (q *Queue) IdleMaintenance(ctx context.Context) (IdleStats, error) {
	var stats IdleStats
	parked, err := q.ParkExhaustedOutbox(ctx)
	if err != nil {
		return stats, err
	}
	stats.Parked = parked
	outbox, err := q.PruneDeliveredOutbox(ctx, OutboxDeliveredRetention, OutboxPruneBatch)
	if err != nil {
		return stats, err
	}
	stats.OutboxPruned = outbox
	jobs, err := q.PruneTerminalJobs(ctx, TerminalJobRetention, TerminalJobPruneBatch)
	if err != nil {
		return stats, err
	}
	stats.JobsPruned = jobs
	return stats, nil
}

// IdleMaintenanceInterval is the minimum gap between idle maintenance passes
// on a single worker goroutine so empty claim loops do not hammer DELETE.
const IdleMaintenanceInterval = 30 * time.Second
