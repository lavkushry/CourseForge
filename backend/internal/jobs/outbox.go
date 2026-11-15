package jobs

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// OutboxEvent is a durable side-effect record committed with job completion.
// External IO runs only after ClaimOutbox; AckOutbox/NackOutbox require the
// current fence so a stale consumer cannot mark delivery.
type OutboxEvent struct {
	ID        string
	JobID     string
	UserID    string
	EventType string
	Payload   json.RawMessage
	Attempt   int
	Fence     int64
	WorkerID  string
}

// OutboxLease bounds how long a consumer may hold an undelivered event.
const OutboxLease = 30 * time.Second

// OutboxMaxAttempts caps delivery retries before the event is parked (not
// silently dropped): available_at is pushed forward so ops can inspect rows.
const OutboxMaxAttempts = 8

// ClaimOutbox reserves one pending outbox row with SKIP LOCKED + fence bump.
// Returns pgx.ErrNoRows when the queue is empty.
func (q *Queue) ClaimOutbox(ctx context.Context, worker string) (OutboxEvent, error) {
	if worker == "" || len(worker) > 128 {
		return OutboxEvent{}, ErrInvalid
	}
	tx, err := q.Pool.Begin(ctx)
	if err != nil {
		return OutboxEvent{}, err
	}
	defer tx.Rollback(ctx)

	// Expired leases become reclaimable; bump fence so the dead worker cannot Ack.
	if _, err = tx.Exec(ctx, `UPDATE job_outbox SET fence=fence+1,worker_id=NULL,lease_until=NULL WHERE delivered_at IS NULL AND lease_until IS NOT NULL AND lease_until<=clock_timestamp()`); err != nil {
		return OutboxEvent{}, err
	}

	var id string
	err = tx.QueryRow(ctx, `SELECT id FROM job_outbox WHERE delivered_at IS NULL AND available_at<=now() AND (lease_until IS NULL OR lease_until<=clock_timestamp()) AND attempt< $1 ORDER BY available_at,created_at,id FOR UPDATE SKIP LOCKED LIMIT 1`, OutboxMaxAttempts).Scan(&id)
	if err != nil {
		return OutboxEvent{}, err
	}
	var e OutboxEvent
	err = tx.QueryRow(ctx, `UPDATE job_outbox SET attempt=attempt+1,fence=fence+1,worker_id=$2,lease_until=clock_timestamp()+$3*interval '1 second' WHERE id=$1 RETURNING id,job_id,user_id,event_type,payload,attempt,fence,worker_id`, id, worker, OutboxLease.Seconds()).Scan(
		&e.ID, &e.JobID, &e.UserID, &e.EventType, &e.Payload, &e.Attempt, &e.Fence, &e.WorkerID,
	)
	if err != nil {
		return OutboxEvent{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return OutboxEvent{}, err
	}
	return e, nil
}

// AckOutbox marks delivery complete for the current fence only.
func (q *Queue) AckOutbox(ctx context.Context, e OutboxEvent) error {
	tag, err := q.Pool.Exec(ctx, `UPDATE job_outbox SET delivered_at=now(),lease_until=NULL,worker_id=NULL WHERE id=$1 AND worker_id=$2 AND fence=$3 AND delivered_at IS NULL`, e.ID, e.WorkerID, e.Fence)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrStale
	}
	return nil
}

// NackOutbox releases the lease and schedules a bounded retry. After
// OutboxMaxAttempts the row stays undelivered with a long available_at so it
// does not busy-loop.
func (q *Queue) NackOutbox(ctx context.Context, e OutboxEvent, retryAfter time.Duration) error {
	if retryAfter < time.Second || retryAfter > time.Hour {
		return ErrInvalid
	}
	delay := retryAfter.Seconds()
	if e.Attempt >= OutboxMaxAttempts {
		delay = (time.Hour).Seconds()
	}
	tag, err := q.Pool.Exec(ctx, `UPDATE job_outbox SET fence=fence+1,worker_id=NULL,lease_until=NULL,available_at=now()+$4*interval '1 second' WHERE id=$1 AND worker_id=$2 AND fence=$3 AND delivered_at IS NULL`, e.ID, e.WorkerID, e.Fence, delay)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrStale
	}
	return nil
}

// DrainOutboxOnce claims one event, runs deliver, and Acks on success.
// deliver must be idempotent by event/job ID (JOBS_CONTRACT).
// When the outbox is idle, exhausted undelivered rows are parked so they do
// not stay in the hot SKIP LOCKED window forever.
func (q *Queue) DrainOutboxOnce(ctx context.Context, worker string, deliver func(context.Context, OutboxEvent) error) error {
	e, err := q.ClaimOutbox(ctx, worker)
	if err != nil {
		if IsOutboxIdle(err) || errors.Is(err, pgx.ErrNoRows) {
			_, _ = q.ParkExhaustedOutbox(ctx)
		}
		return err
	}
	if deliver != nil {
		if err = deliver(ctx, e); err != nil {
			_ = q.NackOutbox(ctx, e, 5*time.Second)
			return err
		}
	}
	if err = q.AckOutbox(ctx, e); err != nil {
		return err
	}
	return nil
}

// ParkExhaustedOutbox moves attempts-exhausted undelivered rows out of the
// hot claim window (available_at far future). Safe to call periodically.
func (q *Queue) ParkExhaustedOutbox(ctx context.Context) (int64, error) {
	tag, err := q.Pool.Exec(ctx, `UPDATE job_outbox SET available_at=now()+interval '1 day',lease_until=NULL,worker_id=NULL WHERE delivered_at IS NULL AND attempt>=$1 AND (lease_until IS NULL OR lease_until<=clock_timestamp())`, OutboxMaxAttempts)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// OutboxDeliveredRetention bounds durable delivered-event storage after Ack.
const OutboxDeliveredRetention = 7 * 24 * time.Hour

// OutboxPruneBatch caps delete work per call so worker loops stay bounded.
const OutboxPruneBatch = 500

// PruneDeliveredOutbox deletes the oldest delivered outbox rows past retention.
// Undelivered / in-flight rows are never touched (JOBS_CONTRACT recovery).
func (q *Queue) PruneDeliveredOutbox(ctx context.Context, olderThan time.Duration, limit int) (int64, error) {
	if olderThan <= 0 {
		olderThan = OutboxDeliveredRetention
	}
	if limit < 1 {
		limit = OutboxPruneBatch
	}
	hours := int(olderThan.Hours())
	if hours < 1 {
		hours = 1
	}
	tag, err := q.Pool.Exec(ctx, `
		DELETE FROM job_outbox
		WHERE id IN (
			SELECT id FROM job_outbox
			WHERE delivered_at IS NOT NULL
			  AND delivered_at < now() - make_interval(hours => $1)
			ORDER BY delivered_at ASC
			LIMIT $2
		)`, hours, limit)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// ErrOutboxEmpty is returned by helpers when no work is available.
var ErrOutboxEmpty = errors.New("outbox empty")

// IsOutboxIdle reports whether err means no pending outbox work.
func IsOutboxIdle(err error) bool {
	return errors.Is(err, pgx.ErrNoRows) || errors.Is(err, ErrOutboxEmpty)
}
