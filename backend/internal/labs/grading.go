package labs

import (
	"bytes"
	"context"
	"encoding/json"
	"time"

	"courseforge/backend/internal/identity"
	"courseforge/backend/internal/jobs"

	"github.com/jackc/pgx/v5"
)

type Check struct {
	Name    string `json:"name"`
	Passed  bool   `json:"passed"`
	Details string `json:"details,omitempty"`
}

// Missing/null pass is never silently accepted as a well-formed grader check.
func (c *Check) UnmarshalJSON(raw []byte) error {
	type value Check
	var parsed struct {
		*value
		Passed *bool `json:"passed"`
	}
	parsed.value = (*value)(c)
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if e := d.Decode(&parsed); e != nil {
		return e
	}
	if parsed.Passed == nil {
		return ErrInvalid
	}
	c.Passed = *parsed.Passed
	return nil
}

type KindResult struct {
	Passed  bool   `json:"passed"`
	Skipped bool   `json:"skipped"`
	Reason  string `json:"reason,omitempty"`
	Details string `json:"details,omitempty"`
}
type ExecutionResult struct {
	Version         int         `json:"version"`
	Product         string      `json:"product"`
	SubmissionID    string      `json:"submission_id"`
	ContentHash     string      `json:"content_hash"`
	GraderVersion   string      `json:"grader_version"`
	RunnerReceiptID string      `json:"runner_receipt_id"`
	Passed          bool        `json:"passed"`
	Checks          []Check     `json:"checks"`
	Kind            *KindResult `json:"kind,omitempty"`
	CompletedAt     time.Time   `json:"completed_at"`
}
type Grade struct {
	ID           string      `json:"id"`
	SubmissionID string      `json:"submission_id"`
	Passed       bool        `json:"passed"`
	Checks       []Check     `json:"checks"`
	Kind         *KindResult `json:"kind,omitempty"`
	CompletedAt  time.Time   `json:"completed_at"`
}

func loadGrade(ctx context.Context, tx pgx.Tx, p identity.Principal, submissionID string) (Grade, error) {
	v := Grade{}
	var checks, kind []byte
	e := tx.QueryRow(ctx, `SELECT id,submission_id,passed,checks,kind_result,completed_at FROM lab_grades WHERE submission_id=$1 AND user_id=$2`, submissionID, p.UserID).Scan(&v.ID, &v.SubmissionID, &v.Passed, &checks, &kind, &v.CompletedAt)
	if e != nil {
		return v, e
	}
	if e = json.Unmarshal(checks, &v.Checks); e != nil {
		return v, e
	}
	if len(kind) > 0 {
		if e = json.Unmarshal(kind, &v.Kind); e != nil {
			return v, e
		}
	}
	return v, nil
}

// ReadGrade is the SQL-only private evidence bridge used by practice. It returns
// the exact immutable accepted grade ID and separately retained input provenance.
func (s *Service) ReadGrade(ctx context.Context, tx pgx.Tx, p identity.Principal, sessionID, evidenceID string) (Grade, Submission, error) {
	var submissionID string
	e := tx.QueryRow(ctx, `SELECT t.id FROM lab_grades g JOIN lab_submissions t ON t.id=g.submission_id AND t.user_id=g.user_id WHERE g.id=$1 AND g.user_id=$2 AND t.session_id=$3`, evidenceID, p.UserID, sessionID).Scan(&submissionID)
	if e != nil {
		return Grade{}, Submission{}, e
	}
	submission, e := s.ReadSubmission(ctx, tx, p, submissionID)
	if e != nil {
		return Grade{}, Submission{}, e
	}
	grade, e := loadGrade(ctx, tx, p, submissionID)
	return grade, submission, e
}

// PublishResult is called only by current fenced Queue.Complete. A result cannot
// assert its own trusted runner provenance; an actual durable verifier is required.
func (s *Service) PublishResult(ctx context.Context, tx pgx.Tx, job jobs.Job, raw json.RawMessage) error {
	if !s.ExecutorAvailable || s.Verifier == nil {
		return ErrUnavailable
	}
	if len(raw) == 0 || len(raw) > 100000 {
		return jobs.ErrInvalid
	}
	var result ExecutionResult
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(&result) != nil || result.Version != 1 || result.Product != "curated_lab" || !bounded(result.RunnerReceiptID, 100) || len(result.Checks) < 1 || len(result.Checks) > 128 {
		return jobs.ErrInvalid
	}
	submission, e := s.ExecutionInput(ctx, tx, job)
	if e != nil {
		return e
	}
	if result.SubmissionID != submission.ID || result.ContentHash != submission.ContentHash || result.GraderVersion != submission.GraderVersion || result.CompletedAt.IsZero() || result.CompletedAt.Before(submission.CreatedAt) || result.CompletedAt.After(time.Now().Add(time.Minute)) {
		return jobs.ErrInvalid
	}
	names := map[string]bool{}
	allPassed := true
	for _, check := range result.Checks {
		if !bounded(check.Name, 120) || len(check.Details) > 250 || names[check.Name] {
			return jobs.ErrInvalid
		}
		names[check.Name] = true
		allPassed = allPassed && check.Passed
	}
	if result.Kind != nil && (len(result.Kind.Reason) > 500 || len(result.Kind.Details) > 1500) {
		return jobs.ErrInvalid
	}
	if !submission.ValidateInKind && result.Kind != nil {
		return jobs.ErrInvalid
	}
	passed := result.Passed && allPassed
	if submission.ValidateInKind {
		passed = passed && result.Kind != nil && !result.Kind.Skipped && result.Kind.Passed
	}
	if e = s.Verifier.Verify(ctx, tx, job, submission, result); e != nil {
		return e
	}
	checks, _ := json.Marshal(result.Checks)
	var kind []byte
	if result.Kind != nil {
		kind, _ = json.Marshal(result.Kind)
	}
	provenance, _ := json.Marshal(map[string]any{"runner_receipt_id": result.RunnerReceiptID, "job_id": job.ID, "fence": job.Fence, "grader_version": submission.GraderVersion, "submission_hash": submission.ContentHash})
	_, e = tx.Exec(ctx, `INSERT INTO lab_grades(id,user_id,submission_id,passed,checks,kind_result,provenance,completed_at)VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, "lg_"+bytesHash([]byte(submission.ID))[:32], submission.OwnerID, submission.ID, passed, checks, kind, provenance, result.CompletedAt)
	return e
}

var _ jobs.Publisher = (*Service)(nil).PublishResult
