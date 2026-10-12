package jobs

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"courseforge/backend/internal/httpx"
	"courseforge/backend/internal/identity"
	"github.com/jackc/pgx/v5"
)

// Retained executor results are private recovery data. Browser reads additionally
// require current lesson access, including after unenrollment or unpublication.
const currentAccess = `EXISTS(SELECT 1 FROM users u JOIN lessons l ON l.id=jobs.lesson_id JOIN courses c ON c.id=l.course_id WHERE u.id=jobs.user_id AND u.verified AND NOT u.suspended AND (jobs.kind NOT IN ('index','export','transcribe') OR u.role='admin') AND (u.role='admin' OR (c.published AND EXISTS(SELECT 1 FROM enrollments e WHERE e.user_id=u.id AND e.course_id=c.id))))`

func (q *Queue) getVisible(ctx context.Context, p identity.Principal, id string) (Job, error) {
	j, err := scan(q.Pool.QueryRow(ctx, `SELECT `+columns+` FROM jobs WHERE id=$1 AND user_id=$2 AND `+currentAccess, id, p.UserID))
	if errors.Is(err, pgx.ErrNoRows) {
		return Job{}, ErrDenied
	}
	return j, err
}

func (q *Queue) Register(mux *http.ServeMux, auth *identity.Service) {
	mux.Handle("POST /api/v1/jobs", auth.Require(http.HandlerFunc(q.submitHTTP)))
	mux.Handle("GET /api/v1/jobs", auth.Require(http.HandlerFunc(q.listHTTP)))
	mux.Handle("GET /api/v1/jobs/{id}", auth.Require(http.HandlerFunc(q.getHTTP)))
	mux.Handle("POST /api/v1/jobs/{id}/cancel", auth.Require(http.HandlerFunc(q.cancelHTTP)))
}
func failure(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrInvalid):
		httpx.Error(w, 422, "invalid_job", "Invalid job command")
	case errors.Is(err, ErrDenied):
		httpx.Error(w, 404, "job_unavailable", "Job or lesson unavailable")
	case errors.Is(err, ErrConflict):
		httpx.Error(w, 409, "idempotency_conflict", "Idempotency key belongs to another command")
	case errors.Is(err, ErrBusy):
		w.Header().Set("Retry-After", "10")
		httpx.Error(w, 503, "queue_busy", "Job queue is full; retry later")
	default:
		httpx.Error(w, 503, "jobs_unavailable", "Jobs temporarily unavailable")
	}
}
func (q *Queue) submitHTTP(w http.ResponseWriter, r *http.Request) {
	p, _ := identity.FromContext(r.Context())
	var c Command
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		httpx.Error(w, 415, "content_type", "Use application/json")
		return
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&c) != nil || decoder.Decode(new(any)) != io.EOF {
		httpx.Error(w, 400, "invalid_json", "Expected one bounded JSON object")
		return
	}
	j, e := q.Submit(r.Context(), p, r.Header.Get("Idempotency-Key"), c)
	if e != nil {
		failure(w, e)
		return
	}
	w.Header().Set("Location", "/api/v1/jobs/"+j.ID)
	httpx.JSON(w, 202, q.PublicJob(j))
}
func (q *Queue) getHTTP(w http.ResponseWriter, r *http.Request) {
	p, _ := identity.FromContext(r.Context())
	j, e := q.getVisible(r.Context(), p, r.PathValue("id"))
	if e != nil {
		failure(w, e)
		return
	}
	httpx.JSON(w, 200, q.PublicJob(j))
}
func (q *Queue) cancelHTTP(w http.ResponseWriter, r *http.Request) {
	p, _ := identity.FromContext(r.Context())
	e := q.Cancel(r.Context(), p, r.PathValue("id"))
	if e != nil {
		failure(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]bool{"canceled": true})
}
func (q *Queue) listHTTP(w http.ResponseWriter, r *http.Request) {
	p, _ := identity.FromContext(r.Context())
	limit := 50
	if value := r.URL.Query().Get("limit"); value != "" {
		n, e := strconv.Atoi(value)
		if e != nil || n < 1 || n > 100 {
			failure(w, ErrInvalid)
			return
		}
		limit = n
	}
	at := time.Date(9999, 1, 1, 0, 0, 0, 0, time.UTC)
	key := ""
	if value := r.URL.Query().Get("cursor"); value != "" {
		if len(value) > 1000 {
			failure(w, ErrInvalid)
			return
		}
		raw, e := base64.RawURLEncoding.DecodeString(value)
		parts := strings.SplitN(string(raw), "|", 2)
		if e != nil || len(parts) != 2 {
			failure(w, ErrInvalid)
			return
		}
		at, e = time.Parse(time.RFC3339Nano, parts[0])
		if e != nil || len(parts[1]) > 100 {
			failure(w, ErrInvalid)
			return
		}
		key = parts[1]
	}
	rows, e := q.Pool.Query(r.Context(), `SELECT `+columns+` FROM jobs WHERE user_id=$1 AND `+currentAccess+` AND (created_at,id)<($2,$3) ORDER BY created_at DESC,id DESC LIMIT $4`, p.UserID, at, key, limit+1)
	if e != nil {
		failure(w, e)
		return
	}
	defer rows.Close()
	items := make([]Job, 0, limit)
	next := ""
	for rows.Next() {
		j, e := scan(rows)
		if e != nil {
			failure(w, e)
			return
		}
		if len(items) == limit {
			last := items[len(items)-1]
			next = base64.RawURLEncoding.EncodeToString([]byte(last.CreatedAt.Format(time.RFC3339Nano) + "|" + last.ID))
			break
		}
		items = append(items, q.PublicJob(j))
	}
	if e = rows.Err(); e != nil {
		failure(w, e)
		return
	}
	httpx.JSON(w, 200, map[string]any{"jobs": items, "next_cursor": next})
}

// Envelope is the versioned internal executor protocol; it is never a browser
// response. Workers receive scoped payloads, and results require the current fence.
type Envelope struct {
	Version  int             `json:"version"`
	JobID    string          `json:"job_id"`
	Kind     string          `json:"kind"`
	LessonID string          `json:"lesson_id"`
	UserID   string          `json:"user_id"`
	Attempt  int             `json:"attempt"`
	Fence    int64           `json:"fence"`
	Payload  json.RawMessage `json:"payload"`
}

func (l Lease) Envelope() Envelope {
	return Envelope{Version: 1, JobID: l.Job.ID, Kind: l.Job.Kind, LessonID: l.Job.LessonID, UserID: l.Job.UserID, Attempt: l.Job.Attempt, Fence: l.Fence, Payload: l.Job.Payload}
}
