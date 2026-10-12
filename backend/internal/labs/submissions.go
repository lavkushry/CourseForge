package labs

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"courseforge/backend/internal/httpx"
	"courseforge/backend/internal/identity"
	"courseforge/backend/internal/jobs"
	"github.com/jackc/pgx/v5"
)

type Payload struct {
	Version        int    `json:"version"`
	Product        string `json:"product"`
	SessionID      string `json:"session_id"`
	SubmissionID   string `json:"submission_id"`
	Slug           string `json:"slug"`
	Filename       string `json:"filename"`
	Revision       int64  `json:"revision"`
	ContentHash    string `json:"content_hash"`
	GraderVersion  string `json:"grader_version"`
	ValidateInKind bool   `json:"validate_in_kind"`
}
type Submission struct {
	ID             string    `json:"id"`
	OwnerID        string    `json:"-"`
	SessionID      string    `json:"session_id"`
	Slug           string    `json:"slug"`
	Filename       string    `json:"filename"`
	Revision       int64     `json:"revision"`
	ContentHash    string    `json:"content_hash"`
	Content        string    `json:"-"`
	GraderVersion  string    `json:"grader_version"`
	ValidateInKind bool      `json:"validate_in_kind"`
	JobID          *string   `json:"job_id"`
	State          string    `json:"state"`
	Result         *Grade    `json:"result"`
	CreatedAt      time.Time `json:"created_at"`
}

func (v Submission) Payload() Payload {
	return Payload{1, "curated_lab", v.SessionID, v.ID, v.Slug, v.Filename, v.Revision, v.ContentHash, v.GraderVersion, v.ValidateInKind}
}
func (s *Service) ReadSubmission(ctx context.Context, tx pgx.Tx, p identity.Principal, id string) (Submission, error) {
	v := Submission{}
	e := tx.QueryRow(ctx, `SELECT t.id,t.user_id,t.session_id,l.slug,r.filename,t.revision,t.content_hash,r.content,t.grader_version,t.validate_in_kind,t.job_id,coalesce(j.state,'unavailable'),t.created_at FROM lab_submissions t JOIN lab_sessions l ON l.id=t.session_id AND l.user_id=t.user_id JOIN lab_revisions r ON r.session_id=t.session_id AND r.revision=t.revision AND r.user_id=t.user_id LEFT JOIN jobs j ON j.id=t.job_id AND j.user_id=t.user_id WHERE t.id=$1 AND t.user_id=$2`, id, p.UserID).Scan(&v.ID, &v.OwnerID, &v.SessionID, &v.Slug, &v.Filename, &v.Revision, &v.ContentHash, &v.Content, &v.GraderVersion, &v.ValidateInKind, &v.JobID, &v.State, &v.CreatedAt)
	if e != nil {
		return v, e
	}
	if d, ok := definitions[v.Slug]; !ok || d.Filename != v.Filename || bytesHash([]byte(v.Content)) != v.ContentHash {
		return v, ErrInvalid
	}
	g, e := loadGrade(ctx, tx, p, id)
	if e == nil {
		v.Result = &g
	} else if !errors.Is(e, pgx.ErrNoRows) {
		return v, e
	}
	return v, nil
}
func (s *Service) submit(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ExpectedRevision int64 `json:"expected_revision"`
		ValidateInKind   bool  `json:"validate_in_kind"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.ExpectedRevision < 1 {
		failure(w, ErrInvalid)
		return
	}
	tx, e := s.transaction(r)
	if e != nil {
		failure(w, e)
		return
	}
	defer tx.Rollback(r.Context())
	p := principal(r)
	key := r.Header.Get("Idempotency-Key")
	digest := hash([]any{r.URL.Path, in})
	done, e := replay(w, r, tx, key, digest)
	if done || e != nil {
		if e != nil {
			failure(w, e)
		}
		return
	}
	v, e := s.loadSession(r.Context(), tx, p, r.PathValue("id"), true)
	if e != nil {
		failure(w, e)
		return
	}
	if v.Revision != in.ExpectedRevision {
		failure(w, ErrConflict)
		return
	}
	if in.ValidateInKind && v.Slug != "k8s-resilient-service" {
		failure(w, ErrInvalid)
		return
	}
	if !s.gradingAvailable() || (in.ValidateInKind && !s.KindAvailable) {
		failure(w, ErrUnavailable)
		return
	}
	submission := Submission{ID: newID("ls_"), OwnerID: p.UserID, SessionID: v.SessionID, Slug: v.Slug, Filename: v.Filename, Revision: v.Revision, ContentHash: v.ContentHash, Content: v.Content, GraderVersion: GraderVersion, ValidateInKind: in.ValidateInKind}
	e = tx.QueryRow(r.Context(), `INSERT INTO lab_submissions(id,user_id,session_id,revision,content_hash,grader_version,validate_in_kind)VALUES($1,$2,$3,$4,$5,$6,$7)RETURNING created_at`, submission.ID, p.UserID, v.SessionID, v.Revision, v.ContentHash, GraderVersion, in.ValidateInKind).Scan(&submission.CreatedAt)
	if e != nil {
		failure(w, e)
		return
	}
	job, e := s.Queue.Enqueue(r.Context(), tx, p, key, submission)
	if e != nil {
		failure(w, e)
		return
	}
	raw, _ := json.Marshal(submission.Payload())
	var valid bool
	e = tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM jobs WHERE id=$1 AND user_id=$2 AND kind='lab' AND state='queued' AND payload=$3::jsonb)`, job.ID, p.UserID, raw).Scan(&valid)
	if e != nil {
		failure(w, e)
		return
	}
	if !valid || job.Kind != "lab" || job.UserID != p.UserID {
		failure(w, ErrInvalid)
		return
	}
	_, e = tx.Exec(r.Context(), `UPDATE lab_submissions SET job_id=$2 WHERE id=$1 AND user_id=$3`, submission.ID, job.ID, p.UserID)
	if e == nil {
		job.Result = nil
		e = finish(w, r, tx, key, digest, 202, map[string]any{"submission_id": submission.ID, "job": job})
	}
	if e != nil {
		failure(w, e)
	}
}
func (s *Service) getSubmission(w http.ResponseWriter, r *http.Request) {
	tx, e := s.transaction(r)
	if e != nil {
		failure(w, e)
		return
	}
	defer tx.Rollback(r.Context())
	v, e := s.ReadSubmission(r.Context(), tx, principal(r), r.PathValue("id"))
	if e != nil {
		failure(w, e)
		return
	}
	httpx.JSON(w, 200, v)
}
func (s *Service) submissions(w http.ResponseWriter, r *http.Request) {
	limit, mark, e := page(r)
	if e != nil {
		failure(w, e)
		return
	}
	tx, e := s.transaction(r)
	if e != nil {
		failure(w, e)
		return
	}
	defer tx.Rollback(r.Context())
	p := principal(r)
	if _, e = s.loadSession(r.Context(), tx, p, r.PathValue("id"), false); e != nil {
		failure(w, e)
		return
	}
	rows, e := tx.Query(r.Context(), `SELECT id,created_at FROM lab_submissions WHERE user_id=$1 AND session_id=$2 AND (created_at,id)<($3,$4) ORDER BY created_at DESC,id DESC LIMIT $5`, p.UserID, r.PathValue("id"), mark.At, mark.ID, limit+1)
	if e != nil {
		failure(w, e)
		return
	}
	ids := []string{}
	times := []time.Time{}
	for rows.Next() {
		var id string
		var created time.Time
		if e = rows.Scan(&id, &created); e != nil {
			rows.Close()
			failure(w, e)
			return
		}
		ids = append(ids, id)
		times = append(times, created)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		failure(w, e)
		return
	}
	next := ""
	if len(ids) > limit {
		ids = ids[:limit]
		next = encodeCursor(times[limit-1], ids[limit-1])
	}
	items := []Submission{}
	for _, id := range ids {
		v, e := s.ReadSubmission(r.Context(), tx, p, id)
		if e != nil {
			failure(w, e)
			return
		}
		items = append(items, v)
	}
	httpx.JSON(w, 200, map[string]any{"submissions": items, "next_cursor": next})
}

// ExecutionInput rechecks the actual current shared lease before releasing an
// immutable source snapshot to the separately integrated internal runner protocol.
func (s *Service) ExecutionInput(ctx context.Context, tx pgx.Tx, job jobs.Job) (Submission, error) {
	if job.Kind != "lab" || job.WorkerID == nil {
		return Submission{}, jobs.ErrDenied
	}
	var actual jobs.Job
	e := tx.QueryRow(ctx, `SELECT j.user_id,j.kind,j.payload FROM jobs j JOIN users u ON u.id=j.user_id WHERE j.id=$1 AND j.state='running' AND j.fence=$2 AND j.worker_id=$3 AND j.lease_until>clock_timestamp() AND u.verified AND NOT u.suspended FOR SHARE OF u`, job.ID, job.Fence, *job.WorkerID).Scan(&actual.UserID, &actual.Kind, &actual.Payload)
	if e != nil {
		return Submission{}, jobs.ErrDenied
	}
	if actual.UserID != job.UserID || actual.Kind != job.Kind {
		return Submission{}, jobs.ErrDenied
	}
	var payload Payload
	decoder := json.NewDecoder(bytes.NewReader(actual.Payload))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&payload) != nil || payload.Version != 1 || payload.Product != "curated_lab" {
		return Submission{}, jobs.ErrInvalid
	}
	v, e := s.ReadSubmission(ctx, tx, identity.Principal{UserID: job.UserID}, payload.SubmissionID)
	if e != nil {
		return v, e
	}
	if v.JobID == nil || *v.JobID != job.ID || hash(payload) != hash(v.Payload()) {
		return v, jobs.ErrInvalid
	}
	return v, nil
}

// ProjectResult claims only the lab product namespace and carries a safe immutable
// submission reference. Results/feedback are read through its private endpoint.
func ProjectResult(job jobs.Job) (json.RawMessage, bool) {
	var payload Payload
	if json.Unmarshal(job.Payload, &payload) != nil || payload.Product != "curated_lab" {
		return nil, false
	}
	if payload.Version != 1 || job.Kind != "lab" || !bounded(payload.SubmissionID, 100) || len(job.Result) == 0 {
		return nil, true
	}
	raw, _ := json.Marshal(map[string]string{"product": "curated_lab", "submission_id": payload.SubmissionID})
	return raw, true
}
