package jobs

import (
	"context"
	"encoding/json"
	"testing"
)

func TestPruneTerminalJobsRemovesExpiredOnly(t *testing.T) {
	q, alice, _ := fixture(t)
	ctx := context.Background()
	old := submit(t, q, alice, "prune-job-old")
	fresh := submit(t, q, alice, "prune-job-new")
	for range []Job{old, fresh} {
		l := claim(t, q, "job-worker")
		if e := q.Complete(ctx, l, json.RawMessage(`{"ok":true}`), nil); e != nil {
			t.Fatal(e)
		}
	}
	if _, e := q.Pool.Exec(ctx, `UPDATE jobs SET finished_at=now()-interval '20 days',updated_at=now()-interval '20 days' WHERE id=$1`, old.ID); e != nil {
		t.Fatal(e)
	}
	n, err := q.PruneTerminalJobs(ctx, TerminalJobRetention, 100)
	if err != nil || n < 1 {
		t.Fatalf("prune n=%d err=%v", n, err)
	}
	var oldCount, newCount, queued int
	if e := q.Pool.QueryRow(ctx, `SELECT count(*) FROM jobs WHERE id=$1`, old.ID).Scan(&oldCount); e != nil {
		t.Fatal(e)
	}
	if e := q.Pool.QueryRow(ctx, `SELECT count(*) FROM jobs WHERE id=$1`, fresh.ID).Scan(&newCount); e != nil {
		t.Fatal(e)
	}
	alive := submit(t, q, alice, "prune-job-queued")
	if e := q.Pool.QueryRow(ctx, `SELECT count(*) FROM jobs WHERE id=$1 AND state='queued'`, alive.ID).Scan(&queued); e != nil || queued != 1 {
		t.Fatalf("queued touched queued=%d err=%v", queued, e)
	}
	if oldCount != 0 || newCount != 1 {
		t.Fatalf("old=%d new=%d", oldCount, newCount)
	}
}
