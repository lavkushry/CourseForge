package jobs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func TestOutboxClaimAckAndStaleFence(t *testing.T) {
	q, alice, _ := fixture(t)
	ctx := context.Background()
	j := submit(t, q, alice, "outbox-ack")
	l := claim(t, q, "job-worker")
	if e := q.Complete(ctx, l, json.RawMessage(`{"answer":"ok"}`), nil); e != nil {
		t.Fatal(e)
	}

	ev, err := q.ClaimOutbox(ctx, "outbox-a")
	if err != nil {
		t.Fatal(err)
	}
	if ev.JobID != j.ID || ev.EventType != "job.completed" || ev.Fence < 1 {
		t.Fatalf("claim %#v", ev)
	}
	stale := ev
	stale.Fence = ev.Fence - 1
	if e := q.AckOutbox(ctx, stale); !errors.Is(e, ErrStale) {
		t.Fatalf("stale ack %v", e)
	}
	if e := q.AckOutbox(ctx, ev); e != nil {
		t.Fatal(e)
	}
	if e := q.AckOutbox(ctx, ev); !errors.Is(e, ErrStale) {
		t.Fatalf("double ack %v", e)
	}
	if _, e := q.ClaimOutbox(ctx, "outbox-b"); !errors.Is(e, pgx.ErrNoRows) {
		t.Fatalf("empty after ack %v", e)
	}
}

func TestOutboxExpiredLeaseReclaimBumpsFence(t *testing.T) {
	q, alice, _ := fixture(t)
	ctx := context.Background()
	j := submit(t, q, alice, "outbox-reclaim")
	l := claim(t, q, "job-worker")
	if e := q.Complete(ctx, l, json.RawMessage(`{"answer":"ok"}`), nil); e != nil {
		t.Fatal(e)
	}
	old, err := q.ClaimOutbox(ctx, "outbox-old")
	if err != nil {
		t.Fatal(err)
	}
	if _, e := q.Pool.Exec(ctx, `UPDATE job_outbox SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`, old.ID); e != nil {
		t.Fatal(e)
	}
	fresh, err := q.ClaimOutbox(ctx, "outbox-new")
	if err != nil {
		t.Fatal(err)
	}
	if fresh.ID != old.ID || fresh.Fence <= old.Fence || fresh.JobID != j.ID {
		t.Fatalf("reclaim old=%#v fresh=%#v", old, fresh)
	}
	if e := q.AckOutbox(ctx, old); !errors.Is(e, ErrStale) {
		t.Fatalf("dead worker ack %v", e)
	}
	if e := q.AckOutbox(ctx, fresh); e != nil {
		t.Fatal(e)
	}
}

func TestOutboxNackRetriesThenIdle(t *testing.T) {
	q, alice, _ := fixture(t)
	ctx := context.Background()
	j := submit(t, q, alice, "outbox-nack")
	l := claim(t, q, "job-worker")
	if e := q.Complete(ctx, l, json.RawMessage(`{"answer":"ok"}`), nil); e != nil {
		t.Fatal(e)
	}
	ev, err := q.ClaimOutbox(ctx, "outbox-n")
	if err != nil {
		t.Fatal(err)
	}
	if e := q.NackOutbox(ctx, ev, time.Second); e != nil {
		t.Fatal(e)
	}
	// Not available until retry delay elapses.
	if _, e := q.ClaimOutbox(ctx, "outbox-n2"); !errors.Is(e, pgx.ErrNoRows) {
		t.Fatalf("nack should delay reclaim, got %v", e)
	}
	if _, e := q.Pool.Exec(ctx, `UPDATE job_outbox SET available_at=now()-interval '1 second' WHERE job_id=$1`, j.ID); e != nil {
		t.Fatal(e)
	}
	again, err := q.ClaimOutbox(ctx, "outbox-n3")
	if err != nil || again.Attempt < 2 {
		t.Fatalf("retry claim %#v err=%v", again, err)
	}
	if e := q.AckOutbox(ctx, again); e != nil {
		t.Fatal(e)
	}
}

func TestOutboxConcurrentClaimSingleWinner(t *testing.T) {
	q, alice, _ := fixture(t)
	ctx := context.Background()
	j := submit(t, q, alice, "outbox-race")
	l := claim(t, q, "job-worker")
	if e := q.Complete(ctx, l, json.RawMessage(`{"answer":"ok"}`), nil); e != nil {
		t.Fatal(e)
	}
	var wins atomic.Int64
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		worker := fmt.Sprintf("race-%d", i)
		go func(w string) {
			defer wg.Done()
			if _, e := q.ClaimOutbox(ctx, w); e == nil {
				wins.Add(1)
			} else if !errors.Is(e, pgx.ErrNoRows) {
				t.Errorf("claim %v", e)
			}
		}(worker)
	}
	wg.Wait()
	if wins.Load() != 1 {
		t.Fatalf("concurrent outbox claims=%d want 1 (job %s)", wins.Load(), j.ID)
	}
}

func TestParkExhaustedOutboxLeavesHotClaimEmpty(t *testing.T) {
	q, alice, _ := fixture(t)
	ctx := context.Background()
	j := submit(t, q, alice, "outbox-park")
	l := claim(t, q, "job-worker")
	if e := q.Complete(ctx, l, json.RawMessage(`{"answer":"ok"}`), nil); e != nil {
		t.Fatal(e)
	}
	if _, e := q.Pool.Exec(ctx, `
		UPDATE job_outbox
		SET attempt=$2, available_at=now()-interval '1 second', lease_until=NULL, worker_id=NULL, delivered_at=NULL
		WHERE job_id=$1`, j.ID, OutboxMaxAttempts); e != nil {
		t.Fatal(e)
	}
	n, err := q.ParkExhaustedOutbox(ctx)
	if err != nil || n < 1 {
		t.Fatalf("park n=%d err=%v", n, err)
	}
	if _, e := q.ClaimOutbox(ctx, "park-claim"); !errors.Is(e, pgx.ErrNoRows) {
		t.Fatalf("exhausted row still claimable: %v", e)
	}
}

func TestPruneDeliveredOutboxRemovesExpiredOnly(t *testing.T) {
	q, alice, _ := fixture(t)
	ctx := context.Background()
	jOld := submit(t, q, alice, "outbox-prune-old")
	jNew := submit(t, q, alice, "outbox-prune-new")
	for _, j := range []Job{jOld, jNew} {
		l := claim(t, q, "job-worker")
		if e := q.Complete(ctx, l, json.RawMessage(`{"answer":"ok"}`), nil); e != nil {
			t.Fatal(e)
		}
		ev, err := q.ClaimOutbox(ctx, "prune-"+j.ID)
		if err != nil {
			t.Fatal(err)
		}
		if e := q.AckOutbox(ctx, ev); e != nil {
			t.Fatal(e)
		}
	}
	if _, e := q.Pool.Exec(ctx, `UPDATE job_outbox SET delivered_at=now()-interval '10 days' WHERE job_id=$1`, jOld.ID); e != nil {
		t.Fatal(e)
	}
	n, err := q.PruneDeliveredOutbox(ctx, OutboxDeliveredRetention, 100)
	if err != nil || n < 1 {
		t.Fatalf("prune n=%d err=%v", n, err)
	}
	var oldCount, newCount int
	if e := q.Pool.QueryRow(ctx, `SELECT count(*) FROM job_outbox WHERE job_id=$1`, jOld.ID).Scan(&oldCount); e != nil {
		t.Fatal(e)
	}
	if e := q.Pool.QueryRow(ctx, `SELECT count(*) FROM job_outbox WHERE job_id=$1`, jNew.ID).Scan(&newCount); e != nil {
		t.Fatal(e)
	}
	if oldCount != 0 || newCount != 1 {
		t.Fatalf("old=%d new=%d", oldCount, newCount)
	}
}

func TestDrainOutboxOnceIdempotentDeliver(t *testing.T) {
	q, alice, _ := fixture(t)
	ctx := context.Background()
	j := submit(t, q, alice, "outbox-drain")
	l := claim(t, q, "job-worker")
	if e := q.Complete(ctx, l, json.RawMessage(`{"answer":"ok"}`), nil); e != nil {
		t.Fatal(e)
	}
	var seen atomic.Int64
	deliver := func(ctx context.Context, e OutboxEvent) error {
		seen.Add(1)
		if e.JobID != j.ID {
			return errors.New("wrong job")
		}
		return nil
	}
	if e := q.DrainOutboxOnce(ctx, "drain-1", deliver); e != nil {
		t.Fatal(e)
	}
	if seen.Load() != 1 {
		t.Fatal("deliver not called")
	}
	if e := q.DrainOutboxOnce(ctx, "drain-2", deliver); !IsOutboxIdle(e) && !errors.Is(e, pgx.ErrNoRows) {
		t.Fatalf("second drain %v", e)
	}
	var delivered int
	if e := q.Pool.QueryRow(ctx, `SELECT count(*) FROM job_outbox WHERE job_id=$1 AND delivered_at IS NOT NULL`, j.ID).Scan(&delivered); e != nil || delivered != 1 {
		t.Fatalf("delivered=%d err=%v", delivered, e)
	}
}
