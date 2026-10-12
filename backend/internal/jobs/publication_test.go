package jobs

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
)

type fixtureExecutor struct{ result json.RawMessage }

func (e fixtureExecutor) Execute(context.Context, Envelope) (json.RawMessage, error) {
	return e.result, nil
}

func TestExecutorResultPublishesWithJobAndOutboxAtomically(t *testing.T) {
	q, alice, _ := fixture(t)
	ctx := context.Background()
	j := submit(t, q, alice, "executor-publication")
	l := claim(t, q, "worker")
	e := q.ExecuteLeaseWithPublisher(ctx, l, fixtureExecutor{result: json.RawMessage(`{"answer":"synthetic"}`)}, func(ctx context.Context, tx pgx.Tx, job Job, result json.RawMessage) error {
		if job.UserID != "alice" || job.ID != j.ID {
			return ErrInvalid
		}
		_, e := tx.Exec(ctx, `INSERT INTO notes(id,user_id,lesson_id,position,content,idempotency_key)VALUES($1,$2,$3,0,'validated generated content',$1)`, job.ID, job.UserID, job.LessonID)
		return e
	})
	if e != nil {
		t.Fatal(e)
	}
	got, e := q.Get(ctx, alice, j.ID)
	if e != nil || got.State != "completed" {
		t.Fatal("execution did not commit", e)
	}
	var effects, events int
	if e = q.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM notes),(SELECT count(*) FROM job_outbox)`).Scan(&effects, &events); e != nil || effects != 1 || events != 1 {
		t.Fatalf("effects%d events%d err%v", effects, events, e)
	}
}

func TestInvalidTypedPublicationRetriesWithoutEffects(t *testing.T) {
	q, alice, _ := fixture(t)
	ctx := context.Background()
	j := submit(t, q, alice, "invalid-publication")
	l := claim(t, q, "worker")
	e := q.ExecuteLeaseWithPublisher(ctx, l, fixtureExecutor{result: json.RawMessage(`{"answer":"missing citations"}`)}, func(context.Context, pgx.Tx, Job, json.RawMessage) error { return ErrInvalid })
	if !errors.Is(e, ErrExecutor) {
		t.Fatalf("invalid publication%v", e)
	}
	got, e := q.Get(ctx, alice, j.ID)
	if e != nil || got.State != "queued" || got.ErrorCode == nil || *got.ErrorCode != "invalid_result" {
		t.Fatal("invalid publication retry state", e)
	}
	var count int
	if e = q.Pool.QueryRow(ctx, `SELECT count(*) FROM job_outbox`).Scan(&count); e != nil || count != 0 {
		t.Fatal("invalid publication emitted event", e)
	}
	if e = q.Complete(ctx, l, json.RawMessage(`{}`), nil); !errors.Is(e, ErrStale) {
		t.Fatal("rejected attempt kept fence", e)
	}
}
