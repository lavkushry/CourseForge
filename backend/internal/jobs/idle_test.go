package jobs

import (
	"context"
	"encoding/json"
	"testing"
)

func TestIdleMaintenancePrunesDeliveredOutboxAndTerminalJobs(t *testing.T) {
	q, alice, _ := fixture(t)
	ctx := context.Background()

	oldJob := submit(t, q, alice, "idle-old-job")
	freshJob := submit(t, q, alice, "idle-fresh-job")
	for range []Job{oldJob, freshJob} {
		l := claim(t, q, "idle-worker")
		if e := q.Complete(ctx, l, json.RawMessage(`{"ok":true}`), nil); e != nil {
			t.Fatal(e)
		}
	}
	if _, e := q.Pool.Exec(ctx, `UPDATE jobs SET finished_at=now()-interval '20 days' WHERE id=$1`, oldJob.ID); e != nil {
		t.Fatal(e)
	}

	oldOut := submit(t, q, alice, "idle-old-outbox")
	freshOut := submit(t, q, alice, "idle-fresh-outbox")
	for _, j := range []Job{oldOut, freshOut} {
		l := claim(t, q, "idle-out-worker")
		if e := q.Complete(ctx, l, json.RawMessage(`{"ok":true}`), nil); e != nil {
			t.Fatal(e)
		}
		ev, err := q.ClaimOutbox(ctx, "idle-outbox-"+j.ID)
		if err != nil {
			t.Fatal(err)
		}
		if e := q.AckOutbox(ctx, ev); e != nil {
			t.Fatal(e)
		}
	}
	if _, e := q.Pool.Exec(ctx, `UPDATE job_outbox SET delivered_at=now()-interval '10 days' WHERE job_id=$1`, oldOut.ID); e != nil {
		t.Fatal(e)
	}

	stats, err := q.IdleMaintenance(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if stats.JobsPruned < 1 || stats.OutboxPruned < 1 {
		t.Fatalf("expected prune work, got %+v", stats)
	}

	var oldJobN, freshJobN, oldOutN, freshOutN int
	_ = q.Pool.QueryRow(ctx, `SELECT count(*) FROM jobs WHERE id=$1`, oldJob.ID).Scan(&oldJobN)
	_ = q.Pool.QueryRow(ctx, `SELECT count(*) FROM jobs WHERE id=$1`, freshJob.ID).Scan(&freshJobN)
	_ = q.Pool.QueryRow(ctx, `SELECT count(*) FROM job_outbox WHERE job_id=$1`, oldOut.ID).Scan(&oldOutN)
	_ = q.Pool.QueryRow(ctx, `SELECT count(*) FROM job_outbox WHERE job_id=$1`, freshOut.ID).Scan(&freshOutN)
	if oldJobN != 0 || freshJobN != 1 || oldOutN != 0 || freshOutN != 1 {
		t.Fatalf("oldJob=%d freshJob=%d oldOut=%d freshOut=%d", oldJobN, freshJobN, oldOutN, freshOutN)
	}
}
