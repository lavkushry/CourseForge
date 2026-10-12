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

	"courseforge/backend/internal/identity"
	"courseforge/backend/internal/testutil"
	"github.com/jackc/pgx/v5"
)

func fixture(t *testing.T) (*Queue, identity.Principal, identity.Principal) {
	t.Helper()
	pool := testutil.Postgres(t)
	ctx := context.Background()
	_, e := pool.Exec(ctx, `INSERT INTO users(id,email,name,password_hash,role,verified)VALUES('alice','alice@example.test','Alice','disabled','student',true),('bob','bob@example.test','Bob','disabled','student',true);
	INSERT INTO auth_sessions(id,user_id,token_hash,csrf_token,expires_at)VALUES('authalice','alice','alicehash','csrf',now()+interval '1 hour'),('authbob','bob','bobhash','csrf',now()+interval '1 hour');
	INSERT INTO courses(id,title,published)VALUES('course','Synthetic',true);
	INSERT INTO lessons(id,course_id,title,sort_order,duration_seconds)VALUES('lesson','course','Synthetic lesson',1,60);
	INSERT INTO enrollments(user_id,course_id)VALUES('alice','course'),('bob','course');`)
	if e != nil {
		t.Fatal(e)
	}
	q, e := New(pool, Config{MaxQueued: 100, MaxQueuedPerUser: 20, Lease: 30 * time.Second})
	if e != nil {
		t.Fatal(e)
	}
	return q, identity.Principal{UserID: "alice", SessionID: "authalice", Role: "student", Verified: true}, identity.Principal{UserID: "bob", SessionID: "authbob", Role: "student", Verified: true}
}
func command() Command {
	return Command{Kind: "tutor", LessonID: "lesson", Payload: json.RawMessage(`{"question":"synthetic"}`)}
}
func submit(t *testing.T, q *Queue, p identity.Principal, key string) Job {
	t.Helper()
	j, e := q.Submit(context.Background(), p, key, command())
	if e != nil {
		t.Fatal(e)
	}
	return j
}
func claim(t *testing.T, q *Queue, worker string) Lease {
	t.Helper()
	l, e := q.Claim(context.Background(), "ai", worker)
	if e != nil {
		t.Fatal(e)
	}
	return l
}

func TestConcurrentSubmissionDeduplicatesAndStaysPrivate(t *testing.T) {
	q, alice, bob := fixture(t)
	ctx := context.Background()
	var wg sync.WaitGroup
	ids := make(chan string, 8)
	errs := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Go(func() {
			j, e := q.Submit(ctx, alice, "same-command", command())
			if e != nil {
				errs <- e
			} else {
				ids <- j.ID
			}
		})
	}
	wg.Wait()
	close(ids)
	close(errs)
	for e := range errs {
		t.Error(e)
	}
	var one string
	for id := range ids {
		if one == "" {
			one = id
		}
		if id != one {
			t.Error("duplicate job")
		}
	}
	if one == "" {
		t.Fatal("no successful submission")
	}
	changed := command()
	changed.Payload = json.RawMessage(`{"question":"different"}`)
	if _, e := q.Submit(ctx, alice, "same-command", changed); !errors.Is(e, ErrConflict) {
		t.Fatalf("reused key %v", e)
	}
	if _, e := q.Get(ctx, bob, one); !errors.Is(e, ErrDenied) {
		t.Fatalf("private result leaked %v", e)
	}
	if e := q.Cancel(ctx, bob, one); !errors.Is(e, ErrDenied) {
		t.Fatalf("cross-user cancel %v", e)
	}
	var count int
	if e := q.Pool.QueryRow(ctx, `SELECT count(*) FROM jobs`).Scan(&count); e != nil || count != 1 {
		t.Fatalf("count %d error%v", count, e)
	}
}

func TestSharedAdmissionAndResourceBudgets(t *testing.T) {
	q, alice, bob := fixture(t)
	other, _ := New(q.Pool, Config{MaxQueued: 3, MaxQueuedPerUser: 2, Lease: 30 * time.Second})
	q.Config = other.Config
	ctx := context.Background()
	submit(t, q, alice, "a1")
	submit(t, other, alice, "a2")
	if _, e := other.Submit(ctx, alice, "a3", command()); !errors.Is(e, ErrBusy) {
		t.Fatalf("per-user budget %v", e)
	}
	submit(t, other, bob, "b1")
	if _, e := q.Submit(ctx, bob, "b2", command()); !errors.Is(e, ErrBusy) {
		t.Fatalf("global budget %v", e)
	}
	var wins atomic.Int64
	var wg sync.WaitGroup
	errs := make(chan error, 12)
	for i := 0; i < 12; i++ {
		worker := fmt.Sprintf("worker-%d", i)
		wg.Go(func() {
			_, e := other.Claim(ctx, "ai", worker)
			if e == nil {
				wins.Add(1)
			} else if !errors.Is(e, ErrBusy) {
				errs <- e
			}
		})
	}
	wg.Wait()
	close(errs)
	for e := range errs {
		t.Error(e)
	}
	if wins.Load() != 2 {
		t.Fatalf("resource budget allowed%d", wins.Load())
	}
}

func TestExpiredFenceCannotPublishOrRenew(t *testing.T) {
	q, alice, _ := fixture(t)
	ctx := context.Background()
	j := submit(t, q, alice, "retry")
	old := claim(t, q, "worker-old")
	if _, e := q.Pool.Exec(ctx, `UPDATE jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`, j.ID); e != nil {
		t.Fatal(e)
	}
	if e := q.Renew(ctx, old); !errors.Is(e, ErrStale) {
		t.Fatalf("expired renew%v", e)
	}
	fresh := claim(t, q, "worker-new")
	if fresh.Fence <= old.Fence || fresh.Job.Attempt != 2 {
		t.Fatal("fence did not advance")
	}
	called := false
	if e := q.Complete(ctx, old, json.RawMessage(`{"answer":"stale"}`), func(context.Context, pgx.Tx) error { called = true; return nil }); !errors.Is(e, ErrStale) || called {
		t.Fatalf("stale publication err%v called%v", e, called)
	}
	e := q.Complete(ctx, fresh, json.RawMessage(`{"answer":"current"}`), func(ctx context.Context, tx pgx.Tx) error {
		_, e := tx.Exec(ctx, `INSERT INTO notes(id,user_id,lesson_id,position,content,idempotency_key)VALUES($1,'alice','lesson',0,'current fenced publication',$1)`, j.ID)
		return e
	})
	if e != nil {
		t.Fatal(e)
	}
	if e = q.Complete(ctx, fresh, json.RawMessage(`{"answer":"duplicate"}`), nil); !errors.Is(e, ErrStale) {
		t.Fatalf("duplicate completion%v", e)
	}
	got, e := q.Get(ctx, alice, j.ID)
	if e != nil || got.State != "completed" || string(got.Result) != `{"answer": "current"}` {
		t.Fatalf("result%+v error%v", got, e)
	}
	var events, notes int
	if e = q.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM job_outbox),(SELECT count(*) FROM notes)`).Scan(&events, &notes); e != nil || events != 1 || notes != 1 {
		t.Fatalf("effects events%d notes%d err%v", events, notes, e)
	}
}

func TestCancellationAndRevocationPreventPublication(t *testing.T) {
	q, alice, _ := fixture(t)
	ctx := context.Background()
	j := submit(t, q, alice, "cancel")
	l := claim(t, q, "worker")
	if e := q.Cancel(ctx, alice, j.ID); e != nil {
		t.Fatal(e)
	}
	if e := q.Cancel(ctx, alice, j.ID); e != nil {
		t.Fatal("repeat cancellation", e)
	}
	if e := q.Complete(ctx, l, json.RawMessage(`{}`), nil); !errors.Is(e, ErrStale) {
		t.Fatalf("canceled publication%v", e)
	}
	submit(t, q, alice, "revoked")
	l = claim(t, q, "worker")
	if _, e := q.Pool.Exec(ctx, `DELETE FROM enrollments WHERE user_id='alice'`); e != nil {
		t.Fatal(e)
	}
	if e := q.Renew(ctx, l); !errors.Is(e, ErrStale) {
		t.Fatalf("revoked job renewed%v", e)
	}
	if e := q.Complete(ctx, l, json.RawMessage(`{}`), nil); !errors.Is(e, ErrDenied) {
		t.Fatalf("revoked publication%v", e)
	}
}

func TestDeadLastAttemptBecomesTerminalWithoutAnotherJob(t *testing.T) {
	q, alice, _ := fixture(t)
	ctx := context.Background()
	j := submit(t, q, alice, "dead")
	if _, e := q.Pool.Exec(ctx, `UPDATE jobs SET max_attempts=1 WHERE id=$1`, j.ID); e != nil {
		t.Fatal(e)
	}
	l := claim(t, q, "worker-dead")
	if _, e := q.Pool.Exec(ctx, `UPDATE jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`, j.ID); e != nil {
		t.Fatal(e)
	}
	if _, e := q.Claim(ctx, "ai", "worker-reaper"); !errors.Is(e, pgx.ErrNoRows) {
		t.Fatalf("unexpected claim %v", e)
	}
	got, e := q.Get(ctx, alice, j.ID)
	if e != nil || got.State != "failed" || got.ErrorCode == nil || *got.ErrorCode != "attempts_exhausted" {
		t.Fatalf("dead attempt %+v err%v", got, e)
	}
	if e := q.Complete(ctx, l, json.RawMessage(`{}`), nil); !errors.Is(e, ErrStale) {
		t.Fatalf("dead publication%v", e)
	}
}

func TestRetryDelayAndPublicationRollback(t *testing.T) {
	q, alice, _ := fixture(t)
	ctx := context.Background()
	j := submit(t, q, alice, "fail")
	l := claim(t, q, "worker")
	if e := q.Fail(ctx, l, "provider_unavailable", time.Second); e != nil {
		t.Fatal(e)
	}
	if _, e := q.Claim(ctx, "ai", "worker-new"); !errors.Is(e, pgx.ErrNoRows) {
		t.Fatalf("retry ignored delay%v", e)
	}
	if e := q.Renew(ctx, l); !errors.Is(e, ErrStale) {
		t.Fatalf("failed lease renewed%v", e)
	}
	if _, e := q.Pool.Exec(ctx, `UPDATE jobs SET available_at=now()-interval '1 second' WHERE id=$1`, j.ID); e != nil {
		t.Fatal(e)
	}
	l = claim(t, q, "worker-new")
	if e := q.Complete(ctx, l, json.RawMessage(`{}`), func(context.Context, pgx.Tx) error { return errors.New("publication rejected") }); e == nil {
		t.Fatal("failed effect accepted")
	}
	got, e := q.Get(ctx, alice, j.ID)
	if e != nil || got.State != "running" {
		t.Fatal("failed transaction committed", e)
	}
	var events int
	if e = q.Pool.QueryRow(ctx, `SELECT count(*) FROM job_outbox`).Scan(&events); e != nil || events != 0 {
		t.Fatal("failed publication emitted event", e)
	}
}

func TestLeaseExpiryDuringPublicationRollsBackEffects(t *testing.T) {
	q, alice, _ := fixture(t)
	ctx := context.Background()
	j := submit(t, q, alice, "short-publication")
	l := claim(t, q, "worker")
	if _, e := q.Pool.Exec(ctx, `UPDATE jobs SET lease_until=clock_timestamp()+interval '100 milliseconds' WHERE id=$1`, j.ID); e != nil {
		t.Fatal(e)
	}
	e := q.Complete(ctx, l, json.RawMessage(`{}`), func(ctx context.Context, tx pgx.Tx) error {
		_, e := tx.Exec(ctx, `SELECT pg_sleep(0.15)`)
		return e
	})
	if !errors.Is(e, ErrStale) {
		t.Fatalf("expired during publication%v", e)
	}
	var count int
	if e = q.Pool.QueryRow(ctx, `SELECT count(*) FROM job_outbox`).Scan(&count); e != nil || count != 0 {
		t.Fatal("expired publication committed", e)
	}
}
