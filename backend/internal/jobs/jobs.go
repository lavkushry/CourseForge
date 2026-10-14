// Package jobs owns durable queue state, leases, fencing and atomic publication.
// Executors run outside transactions and must use the current lease to publish.
package jobs

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"courseforge/backend/internal/identity"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrDenied   = errors.New("job access denied")
	ErrConflict = errors.New("idempotency key reused")
	ErrBusy     = errors.New("job queue at capacity")
	ErrStale    = errors.New("job lease is no longer current")
	ErrInvalid  = errors.New("invalid job command")
)

var resources = map[string]string{"tutor": "ai", "quiz": "ai", "review": "ai", "path": "ai", "transcribe": "media_processing", "index": "media_processing", "lab": "lab", "export": "export"}

type Config struct {
	MaxQueued        int
	MaxQueuedPerUser int
	Lease            time.Duration
}
type Queue struct {
	Pool   *pgxpool.Pool
	Config Config
	// Configure once before serving. A product projector returns only public
	// references; private executor output remains available to publication.
	ResultProjector func(Job) (json.RawMessage, bool)
}
type Command struct {
	Kind     string          `json:"kind"`
	LessonID string          `json:"lesson_id"`
	Payload  json.RawMessage `json:"payload"`
}
type Job struct {
	ID          string          `json:"id"`
	UserID      string          `json:"-"`
	LessonID    string          `json:"lesson_id"`
	Kind        string          `json:"kind"`
	Resource    string          `json:"resource"`
	State       string          `json:"state"`
	Attempt     int             `json:"attempt"`
	Fence       int64           `json:"-"`
	MaxAttempts int             `json:"max_attempts"`
	WorkerID    *string         `json:"-"`
	LeaseUntil  *time.Time      `json:"-"`
	Payload     json.RawMessage `json:"-"`
	Result      json.RawMessage `json:"result,omitempty"`
	ErrorCode   *string         `json:"error_code"`
	CreatedAt   time.Time       `json:"created_at"`
	UpdatedAt   time.Time       `json:"updated_at"`
}
type Lease struct {
	Job      Job
	WorkerID string
	Fence    int64
}

func New(pool *pgxpool.Pool, c Config) (*Queue, error) {
	if c.MaxQueued < 1 || c.MaxQueued > 100000 || c.MaxQueuedPerUser < 1 || c.MaxQueuedPerUser > 100 || c.Lease < 5*time.Second || c.Lease > 5*time.Minute {
		return nil, ErrInvalid
	}
	return &Queue{Pool: pool, Config: c}, nil
}
func id(prefix string) (string, error) {
	b := make([]byte, 16)
	_, e := rand.Read(b)
	return prefix + hex.EncodeToString(b), e
}

const columns = `id,user_id,lesson_id,kind,resource,state,attempt,fence,max_attempts,worker_id,lease_until,payload,result,error_code,created_at,updated_at`

func scan(row pgx.Row) (Job, error) {
	var j Job
	e := row.Scan(&j.ID, &j.UserID, &j.LessonID, &j.Kind, &j.Resource, &j.State, &j.Attempt, &j.Fence, &j.MaxAttempts, &j.WorkerID, &j.LeaseUntil, &j.Payload, &j.Result, &j.ErrorCode, &j.CreatedAt, &j.UpdatedAt)
	return j, e
}
func validObject(raw json.RawMessage, max int) bool {
	if len(raw) == 0 || len(raw) > max {
		return false
	}
	var v map[string]any
	return json.Unmarshal(raw, &v) == nil && v != nil
}
func allowed(ctx context.Context, tx pgx.Tx, user, lesson, kind string) error {
	var course string
	e := tx.QueryRow(ctx, `SELECT c.id FROM users u JOIN lessons l ON l.id=$2 JOIN courses c ON c.id=l.course_id WHERE u.id=$1 AND u.verified AND NOT u.suspended AND ($3 NOT IN ('index','export','transcribe') OR u.role='admin') AND (u.role='admin' OR (c.published AND EXISTS(SELECT 1 FROM enrollments e WHERE e.user_id=u.id AND e.course_id=c.id))) FOR SHARE OF c,l`, user, lesson, kind).Scan(&course)
	if errors.Is(e, pgx.ErrNoRows) {
		return ErrDenied
	}
	return e
}

// Submit serializes admission only; no executor or network work runs under locks.
func (q *Queue) Submit(ctx context.Context, p identity.Principal, key string, c Command) (Job, error) {
	resource, ok := resources[c.Kind]
	if !ok || len(c.LessonID) < 1 || len(c.LessonID) > 500 || len(key) < 1 || len(key) > 128 || strings.TrimSpace(key) != key || !validObject(c.Payload, 60<<10) {
		return Job{}, ErrInvalid
	}
	if (c.Kind == "index" || c.Kind == "export" || c.Kind == "transcribe") && p.Role != "admin" {
		return Job{}, ErrDenied
	}
	tx, e := q.Pool.Begin(ctx)
	if e != nil {
		return Job{}, e
	}
	defer tx.Rollback(ctx)
	if e = identity.LockPrincipal(ctx, tx, p); e != nil {
		return Job{}, ErrDenied
	}
	if e = allowed(ctx, tx, p.UserID, c.LessonID, c.Kind); e != nil {
		return Job{}, e
	}
	// One admission lock gives an exact fleet-wide queue bound, including retries.
	if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(673583405)`); e != nil {
		return Job{}, e
	}
	j, e := scan(tx.QueryRow(ctx, `SELECT `+columns+` FROM jobs WHERE user_id=$1 AND idempotency_key=$2`, p.UserID, key))
	if e == nil {
		var same bool
		e = tx.QueryRow(ctx, `SELECT kind=$3 AND lesson_id=$4 AND payload=$5::jsonb FROM jobs WHERE user_id=$1 AND idempotency_key=$2`, p.UserID, key, c.Kind, c.LessonID, c.Payload).Scan(&same)
		if e != nil {
			return Job{}, e
		}
		if !same {
			return Job{}, ErrConflict
		}
		return j, tx.Commit(ctx)
	}
	if !errors.Is(e, pgx.ErrNoRows) {
		return Job{}, e
	}
	var all, own int
	e = tx.QueryRow(ctx, `SELECT count(*),count(*) FILTER(WHERE user_id=$1) FROM jobs WHERE state IN ('queued','running')`, p.UserID).Scan(&all, &own)
	if e != nil {
		return Job{}, e
	}
	if all >= q.Config.MaxQueued || own >= q.Config.MaxQueuedPerUser {
		return Job{}, ErrBusy
	}
	jobID, e := id("job_")
	if e != nil {
		return Job{}, e
	}
	j, e = scan(tx.QueryRow(ctx, `INSERT INTO jobs(id,user_id,lesson_id,kind,resource,idempotency_key,payload)VALUES($1,$2,$3,$4,$5,$6,$7)RETURNING `+columns, jobID, p.UserID, c.LessonID, c.Kind, resource, key, c.Payload))
	if e != nil {
		return Job{}, e
	}
	return j, tx.Commit(ctx)
}

// Claim reserves one shared resource slot and commits before returning to execute.
func (q *Queue) Claim(ctx context.Context, resource, worker string) (Lease, error) {
	if len(worker) < 1 || len(worker) > 128 {
		return Lease{}, ErrInvalid
	}
	tx, e := q.Pool.Begin(ctx)
	if e != nil {
		return Lease{}, e
	}
	defer tx.Rollback(ctx)
	var limit int
	if e = tx.QueryRow(ctx, `SELECT max_running FROM job_resources WHERE name=$1 FOR UPDATE`, resource).Scan(&limit); e != nil {
		return Lease{}, e
	}
	// Exhausted dead workers become terminal and lose their publication fence.
	_, e = tx.Exec(ctx, `UPDATE jobs SET state='failed',error_code='attempts_exhausted',fence=fence+1,worker_id=NULL,lease_until=NULL,finished_at=now(),updated_at=now() WHERE resource=$1 AND state='running' AND lease_until<=clock_timestamp() AND attempt>=max_attempts`, resource)
	if e != nil {
		return Lease{}, e
	}
	var active int
	if e = tx.QueryRow(ctx, `SELECT count(*) FROM jobs WHERE resource=$1 AND state='running' AND lease_until>clock_timestamp()`, resource).Scan(&active); e != nil {
		return Lease{}, e
	}
	if active >= limit {
		if e = tx.Commit(ctx); e != nil {
			return Lease{}, e
		}
		return Lease{}, ErrBusy
	}
	var jobID string
	e = tx.QueryRow(ctx, `SELECT j.id FROM jobs j JOIN users u ON u.id=j.user_id JOIN lessons l ON l.id=j.lesson_id JOIN courses c ON c.id=l.course_id WHERE j.resource=$1 AND j.attempt<j.max_attempts AND j.available_at<=now() AND (j.state='queued' OR (j.state='running' AND j.lease_until<=clock_timestamp())) AND u.verified AND NOT u.suspended AND (j.kind NOT IN ('index','export','transcribe') OR u.role='admin') AND (u.role='admin' OR (c.published AND EXISTS(SELECT 1 FROM enrollments e WHERE e.user_id=u.id AND e.course_id=c.id))) ORDER BY j.available_at,j.created_at,j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1`, resource).Scan(&jobID)
	if e != nil {
		if errors.Is(e, pgx.ErrNoRows) {
			if commitErr := tx.Commit(ctx); commitErr != nil {
				return Lease{}, commitErr
			}
		}
		return Lease{}, e
	}
	j, e := scan(tx.QueryRow(ctx, `UPDATE jobs SET state='running',attempt=attempt+1,fence=fence+1,worker_id=$2,lease_until=clock_timestamp()+$3*interval '1 second',error_code=NULL,updated_at=now() WHERE id=$1 RETURNING `+columns, jobID, worker, q.Config.Lease.Seconds()))
	if e != nil {
		return Lease{}, e
	}
	if e = tx.Commit(ctx); e != nil {
		return Lease{}, e
	}
	return Lease{Job: j, WorkerID: worker, Fence: j.Fence}, nil
}
func (q *Queue) Renew(ctx context.Context, l Lease) error {
	tag, e := q.Pool.Exec(ctx, `UPDATE jobs j SET lease_until=clock_timestamp()+$4*interval '1 second',updated_at=now() FROM users u,lessons l,courses c WHERE j.id=$1 AND j.worker_id=$2 AND j.fence=$3 AND j.state='running' AND j.lease_until>clock_timestamp() AND u.id=j.user_id AND l.id=j.lesson_id AND c.id=l.course_id AND u.verified AND NOT u.suspended AND (j.kind NOT IN ('index','export','transcribe') OR u.role='admin') AND (u.role='admin' OR (c.published AND EXISTS(SELECT 1 FROM enrollments e WHERE e.user_id=u.id AND e.course_id=c.id)))`, l.Job.ID, l.WorkerID, l.Fence, q.Config.Lease.Seconds())
	if e != nil {
		return e
	}
	if tag.RowsAffected() != 1 {
		return ErrStale
	}
	return nil
}

// Complete atomically commits the result, optional bounded SQL effects and outbox.
// publish must do SQL only: external IO belongs to an idempotent outbox consumer.
func (q *Queue) Complete(ctx context.Context, l Lease, result json.RawMessage, publish func(context.Context, pgx.Tx) error) error {
	if !validObject(result, 1<<20) {
		return ErrInvalid
	}
	tx, e := q.Pool.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	var user string
	e = tx.QueryRow(ctx, `SELECT id FROM users WHERE id=$1 AND verified AND NOT suspended FOR SHARE`, l.Job.UserID).Scan(&user)
	if e != nil {
		if errors.Is(e, pgx.ErrNoRows) {
			return ErrDenied
		}
		return e
	}
	j, e := scan(tx.QueryRow(ctx, `SELECT `+columns+` FROM jobs WHERE id=$1 AND worker_id=$2 AND fence=$3 AND state='running' AND lease_until>clock_timestamp() FOR UPDATE`, l.Job.ID, l.WorkerID, l.Fence))
	if e != nil {
		if errors.Is(e, pgx.ErrNoRows) {
			return ErrStale
		}
		return e
	}
	if e = allowed(ctx, tx, j.UserID, j.LessonID, j.Kind); e != nil {
		return e
	}
	if publish != nil {
		if e = publish(ctx, tx); e != nil {
			return e
		}
	}
	tag, e := tx.Exec(ctx, `UPDATE jobs SET state='completed',result=$2,lease_until=NULL,worker_id=NULL,finished_at=now(),updated_at=now() WHERE id=$1 AND fence=$3 AND worker_id=$4 AND state='running' AND lease_until>clock_timestamp()`, j.ID, result, l.Fence, l.WorkerID)
	if e != nil {
		return e
	}
	if tag.RowsAffected() != 1 {
		return ErrStale
	}
	eventID, e := id("evt_")
	if e != nil {
		return e
	}
	body, _ := json.Marshal(map[string]string{"job_id": j.ID, "kind": j.Kind, "lesson_id": j.LessonID})
	_, e = tx.Exec(ctx, `INSERT INTO job_outbox(id,job_id,user_id,event_type,payload)VALUES($1,$2,$3,'job.completed',$4)`, eventID, j.ID, j.UserID, body)
	if e != nil {
		return e
	}
	return tx.Commit(ctx)
}
func (q *Queue) Fail(ctx context.Context, l Lease, code string, retryAfter time.Duration) error {
	if code != "provider_unavailable" && code != "timeout" && code != "invalid_result" && code != "executor_failed" {
		return ErrInvalid
	}
	if retryAfter < time.Second || retryAfter > time.Hour {
		return ErrInvalid
	}
	tag, e := q.Pool.Exec(ctx, `UPDATE jobs SET state=CASE WHEN attempt<max_attempts THEN 'queued' ELSE 'failed' END,error_code=$4,fence=fence+1,worker_id=NULL,lease_until=NULL,available_at=now()+$5*interval '1 second',finished_at=CASE WHEN attempt>=max_attempts THEN now() ELSE NULL END,updated_at=now() WHERE id=$1 AND worker_id=$2 AND fence=$3 AND state='running' AND lease_until>clock_timestamp()`, l.Job.ID, l.WorkerID, l.Fence, code, retryAfter.Seconds())
	if e != nil {
		return e
	}
	if tag.RowsAffected() != 1 {
		return ErrStale
	}
	return nil
}
func (q *Queue) Get(ctx context.Context, p identity.Principal, jobID string) (Job, error) {
	j, e := scan(q.Pool.QueryRow(ctx, `SELECT `+columns+` FROM jobs WHERE id=$1 AND user_id=$2`, jobID, p.UserID))
	if errors.Is(e, pgx.ErrNoRows) {
		return Job{}, ErrDenied
	}
	return j, e
}
func (q *Queue) Cancel(ctx context.Context, p identity.Principal, jobID string) error {
	tx, e := q.Pool.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	if e = identity.LockPrincipal(ctx, tx, p); e != nil {
		return ErrDenied
	}
	var state string
	e = tx.QueryRow(ctx, `SELECT state FROM jobs WHERE id=$1 AND user_id=$2 FOR UPDATE`, jobID, p.UserID).Scan(&state)
	if errors.Is(e, pgx.ErrNoRows) {
		return ErrDenied
	}
	if e != nil {
		return e
	}
	if state == "queued" || state == "running" {
		_, e = tx.Exec(ctx, `UPDATE jobs SET state='canceled',fence=fence+1,worker_id=NULL,lease_until=NULL,finished_at=now(),updated_at=now() WHERE id=$1`, jobID)
		if e != nil {
			return e
		}
	}
	return tx.Commit(ctx)
}
func (q *Queue) String() string {
	return fmt.Sprintf("durable queue limits %d total/%d per learner", q.Config.MaxQueued, q.Config.MaxQueuedPerUser)
}
