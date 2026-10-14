package paths

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"unicode/utf16"

	"courseforge/backend/internal/httpx"
	"courseforge/backend/internal/identity"
	"courseforge/backend/internal/jobs"

	"github.com/jackc/pgx/v5"
	"golang.org/x/text/cases"
)

// StablePathID retains the legacy owner/courses/casefolded-goal namespace,
// including Python json.dumps spacing and ASCII escaping. Migration can retain
// supplied IDs directly; it must never recompute IDs from relocated source paths.
func StablePathID(user string, courses []string, goal string) string {
	ordered := append([]string(nil), courses...)
	fold := cases.Fold()
	sort.SliceStable(ordered, func(i, j int) bool { return fold.String(ordered[i]) < fold.String(ordered[j]) })
	var encoded bytes.Buffer
	encoder := json.NewEncoder(&encoded)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode([]any{user, ordered, fold.String(goal)})
	var python strings.Builder
	quoted, escaped := false, false
	for _, char := range strings.TrimSuffix(encoded.String(), "\n") {
		if char == '"' && !escaped {
			quoted = !quoted
		}
		if char > 127 {
			if char <= 0xffff {
				fmt.Fprintf(&python, "\\u%04x", char)
			} else {
				high, low := utf16.EncodeRune(char)
				fmt.Fprintf(&python, "\\u%04x\\u%04x", high, low)
			}
		} else {
			python.WriteRune(char)
			if char == ',' && !quoted {
				python.WriteByte(' ')
			}
		}
		if char == '\\' {
			escaped = !escaped
		} else {
			escaped = false
		}
	}
	return "lp_" + digestBytes([]byte(python.String()))[:20]
}

// GenerationPayload belongs to Go; the executor cannot choose an owner or source.
type GenerationPayload struct {
	Version          int      `json:"version"`
	Product          string   `json:"product"`
	PathID           string   `json:"path_id"`
	StepID           string   `json:"step_id,omitempty"`
	Goal             string   `json:"goal,omitempty"`
	CourseIDs        []string `json:"course_ids"`
	Sources          []Source `json:"sources"`
	Fingerprint      string   `json:"source_fingerprint"`
	ExpectedRevision int64    `json:"expected_revision"`
	Count            int      `json:"count,omitempty"`
}
type GenerationResult struct {
	Version   int        `json:"version"`
	Product   string     `json:"product"`
	Steps     []Step     `json:"steps,omitempty"`
	Questions []Question `json:"questions,omitempty"`
}

func (s *Service) generatePath(w http.ResponseWriter, r *http.Request) {
	var in struct {
		CourseIDs        []string `json:"course_ids"`
		Goal             string   `json:"goal"`
		ExpectedRevision int64    `json:"expected_revision"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if !text(in.Goal, 3, 180) || len(in.CourseIDs) < 1 || len(in.CourseIDs) > 8 || in.ExpectedRevision < 0 {
		failure(w, ErrInvalid)
		return
	}
	sort.Strings(in.CourseIDs)
	for i, c := range in.CourseIDs {
		if !text(c, 1, 200) || (i > 0 && c == in.CourseIDs[i-1]) {
			failure(w, ErrInvalid)
			return
		}
	}
	tx, e := s.transaction(r)
	if e != nil {
		failure(w, e)
		return
	}
	defer tx.Rollback(r.Context())
	p := principal(r)
	if e = courseAccess(r.Context(), tx, p, in.CourseIDs); e != nil {
		failure(w, e)
		return
	}
	if done, err := s.replayGeneration(w, r, tx, "path", GenerationPayload{Product: "learning_path", PathID: StablePathID(p.UserID, in.CourseIDs, in.Goal), Goal: in.Goal, CourseIDs: in.CourseIDs, ExpectedRevision: in.ExpectedRevision}); done || err != nil {
		if err != nil {
			failure(w, err)
		}
		return
	}
	if !s.ExecutorAvailable || s.Queue == nil {
		failure(w, ErrUnavailable)
		return
	}
	rows, e := tx.Query(r.Context(), `SELECT l.id,l.course_id,l.title,c.id,c.start_seconds FROM lessons l JOIN transcript_chunks c ON c.lesson_id=l.id WHERE l.course_id=ANY($1) AND length(trim(c.text))>0 AND c.start_seconds<=l.duration_seconds ORDER BY l.course_id,l.id,c.start_seconds,c.id LIMIT 41 FOR SHARE OF l,c`, in.CourseIDs)
	if e != nil {
		failure(w, e)
		return
	}
	sources := []Source{}
	for rows.Next() {
		v := Source{}
		if e = rows.Scan(&v.LessonID, &v.CourseID, &v.Title, &v.ChunkID, &v.Start); e != nil {
			rows.Close()
			failure(w, e)
			return
		}
		sources = append(sources, v)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		failure(w, e)
		return
	}
	if len(sources) == 0 || len(sources) > 40 {
		failure(w, ErrInvalid)
		return
	}
	pathID := StablePathID(p.UserID, in.CourseIDs, in.Goal)
	d := Definition{ID: pathID, Goal: in.Goal, CourseIDs: in.CourseIDs, Steps: []Step{}}
	for i, src := range sources {
		d.Steps = append(d.Steps, Step{ID: src.ChunkID, Title: src.Title, Sources: []Source{sources[i]}})
	}
	fp, e := sourceFingerprint(r.Context(), tx, p, d)
	if e != nil {
		failure(w, e)
		return
	}
	payload := GenerationPayload{Version: 1, Product: "learning_path", PathID: pathID, Goal: in.Goal, CourseIDs: in.CourseIDs, Sources: sources, Fingerprint: fp, ExpectedRevision: in.ExpectedRevision}
	if e = tx.Commit(r.Context()); e != nil {
		failure(w, e)
		return
	}
	s.enqueue(w, r, "path", sources[0].LessonID, payload)
}
func (s *Service) generateAssessment(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Count            int   `json:"count"`
		ExpectedRevision int64 `json:"expected_revision"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.Count < 3 || in.Count > 5 || in.ExpectedRevision < 1 {
		failure(w, ErrInvalid)
		return
	}
	tx, e := s.transaction(r)
	if e != nil {
		failure(w, e)
		return
	}
	defer tx.Rollback(r.Context())
	if done, err := s.replayGeneration(w, r, tx, "quiz", GenerationPayload{Product: "topic_assessment", PathID: r.PathValue("id"), StepID: r.PathValue("step_id"), Count: in.Count, ExpectedRevision: in.ExpectedRevision}); done || err != nil {
		if err != nil {
			failure(w, err)
		}
		return
	}
	v, e := s.load(r.Context(), tx, principal(r), r.PathValue("id"), true)
	if e != nil {
		failure(w, e)
		return
	}
	if v.Outdated || v.Revision != in.ExpectedRevision {
		failure(w, ErrConflict)
		return
	}
	step, e := findStep(v, r.PathValue("step_id"))
	if e != nil {
		failure(w, e)
		return
	}
	if !s.ExecutorAvailable || s.Queue == nil {
		failure(w, ErrUnavailable)
		return
	}
	hasEvidence := false
	for _, src := range step.Sources {
		var found bool
		e = tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM transcript_chunks WHERE lesson_id=$1 AND abs(start_seconds-$2)<=300 AND length(trim(text))>0)`, src.LessonID, src.Start).Scan(&found)
		if e != nil {
			failure(w, e)
			return
		}
		hasEvidence = hasEvidence || found
	}
	if !hasEvidence {
		failure(w, ErrInvalid)
		return
	}
	payload := GenerationPayload{Version: 1, Product: "topic_assessment", PathID: v.ID, StepID: step.ID, CourseIDs: v.CourseIDs, Sources: step.Sources, Fingerprint: assessmentFingerprint(v, step), ExpectedRevision: v.Revision, Count: in.Count}
	if e = tx.Commit(r.Context()); e != nil {
		failure(w, e)
		return
	}
	s.enqueue(w, r, "quiz", step.Sources[0].LessonID, payload)
}
func (s *Service) enqueue(w http.ResponseWriter, r *http.Request, kind, lesson string, payload GenerationPayload) {
	raw, _ := json.Marshal(payload)
	job, e := s.Queue.Submit(r.Context(), principal(r), r.Header.Get("Idempotency-Key"), jobs.Command{Kind: kind, LessonID: lesson, Payload: raw})
	if e != nil {
		failure(w, e)
		return
	}
	httpx.JSON(w, 202, s.Queue.PublicJob(job))
}

// An accepted generation submission retains its own immutable source snapshot.
// Replay compares the original public command, not a newly rebuilt fingerprint
// or current path revision. Current identity/course/citation scope still applies.
func (s *Service) replayGeneration(w http.ResponseWriter, r *http.Request, tx pgx.Tx, kind string, request GenerationPayload) (bool, error) {
	key := r.Header.Get("Idempotency-Key")
	if !text(key, 1, 128) {
		return false, ErrInvalid
	}
	var job jobs.Job
	err := tx.QueryRow(r.Context(), `SELECT id,user_id,lesson_id,kind,resource,state,attempt,max_attempts,payload,result,error_code,created_at,updated_at FROM jobs WHERE user_id=$1 AND idempotency_key=$2`, principal(r).UserID, key).Scan(&job.ID, &job.UserID, &job.LessonID, &job.Kind, &job.Resource, &job.State, &job.Attempt, &job.MaxAttempts, &job.Payload, &job.Result, &job.ErrorCode, &job.CreatedAt, &job.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	var stored GenerationPayload
	if json.Unmarshal(job.Payload, &stored) != nil || stored.Version != 1 || job.Kind != kind || stored.Product != request.Product || stored.PathID != request.PathID || stored.StepID != request.StepID || stored.ExpectedRevision != request.ExpectedRevision || stored.Count != request.Count {
		return false, ErrConflict
	}
	if request.Product == "learning_path" && (stored.Goal != request.Goal || digest(stored.CourseIDs) != digest(request.CourseIDs)) {
		return false, ErrConflict
	}
	if len(stored.CourseIDs) < 1 || len(stored.CourseIDs) > 8 || len(stored.Sources) == 0 {
		return false, ErrConflict
	}
	if err = courseAccess(r.Context(), tx, principal(r), stored.CourseIDs); err != nil {
		return false, err
	}
	if err = validateSnapshotSources(r.Context(), tx, job.Payload); err != nil {
		return false, err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return false, err
	}
	httpx.JSON(w, 202, s.Queue.PublicJob(job))
	return true, nil
}

// PublishResult must be called only inside the current Queue.Complete fenced
// transaction. It neither accepts a client owner nor performs network work.
func (s *Service) PublishResult(ctx context.Context, tx pgx.Tx, job jobs.Job, raw json.RawMessage) error {
	if len(raw) == 0 || len(raw) > 1<<20 {
		return jobs.ErrInvalid
	}
	var payload GenerationPayload
	var result GenerationResult
	var user, lesson, kind string
	var payloadRaw json.RawMessage
	if err := tx.QueryRow(ctx, `SELECT user_id,lesson_id,kind,payload FROM jobs WHERE id=$1 AND state='running'`, job.ID).Scan(&user, &lesson, &kind, &payloadRaw); err != nil {
		return err
	}
	if user != job.UserID || lesson != job.LessonID || kind != job.Kind {
		return jobs.ErrDenied
	}
	if json.Unmarshal(payloadRaw, &payload) != nil || json.Unmarshal(raw, &result) != nil || payload.Version != 1 || result.Version != 1 || payload.Product != result.Product {
		return jobs.ErrInvalid
	}
	var role string
	e := tx.QueryRow(ctx, `SELECT role FROM users WHERE id=$1 AND verified AND NOT suspended FOR SHARE`, job.UserID).Scan(&role)
	if e != nil {
		return jobs.ErrDenied
	}
	p := identity.Principal{UserID: job.UserID, Role: role, Verified: true}
	if e = courseAccess(ctx, tx, p, payload.CourseIDs); e != nil {
		return jobs.ErrDenied
	}
	switch payload.Product {
	case "learning_path":
		if job.Kind != "path" || len(result.Questions) > 0 || len(payload.Sources) == 0 || job.LessonID != payload.Sources[0].LessonID {
			return jobs.ErrInvalid
		}
		snapshot := Definition{ID: payload.PathID, Goal: payload.Goal, CourseIDs: payload.CourseIDs, Steps: []Step{}}
		for _, src := range payload.Sources {
			snapshot.Steps = append(snapshot.Steps, Step{ID: src.ChunkID, Title: src.Title, Sources: []Source{src}})
		}
		fp, e := sourceFingerprint(ctx, tx, p, snapshot)
		if e != nil || fp != payload.Fingerprint {
			return jobs.ErrInvalid
		}
		for _, step := range result.Steps {
			for _, src := range step.Sources {
				found := false
				for _, allowed := range payload.Sources {
					if src.LessonID == allowed.LessonID && src.CourseID == allowed.CourseID && src.Start == allowed.Start && src.ChunkID == allowed.ChunkID {
						found = true
					}
				}
				if !found {
					return jobs.ErrInvalid
				}
			}
		}
		d := Definition{ID: payload.PathID, Goal: payload.Goal, CourseIDs: payload.CourseIDs, Steps: result.Steps, ExpectedRevision: payload.ExpectedRevision}
		if e = saveDefinition(ctx, tx, p, d, "generated"); e != nil {
			return jobs.ErrInvalid
		}
		return nil
	case "topic_assessment":
		if job.Kind != "quiz" || len(result.Steps) > 0 || len(result.Questions) != payload.Count {
			return jobs.ErrInvalid
		}
		v, e := s.load(ctx, tx, p, payload.PathID, true)
		if e != nil {
			return jobs.ErrInvalid
		}
		step, e := findStep(v, payload.StepID)
		if e != nil || v.Outdated || v.Revision != payload.ExpectedRevision || assessmentFingerprint(v, step) != payload.Fingerprint || len(step.Sources) == 0 || job.LessonID != step.Sources[0].LessonID {
			return jobs.ErrInvalid
		}
		_, e = saveAssessment(ctx, tx, p, v, step, result.Questions, "generated", GeneratedAssessmentID(job.ID))
		if e != nil {
			return jobs.ErrInvalid
		}
		return nil
	default:
		return jobs.ErrInvalid
	}
}

var _ jobs.Publisher = (*Service)(nil).PublishResult

// GeneratedAssessmentID binds the public result reference to one durable job.
// It is stable across worker retries; queue fencing still owns publication.
func GeneratedAssessmentID(jobID string) string { return "ta_" + digestBytes([]byte(jobID))[:32] }

// ProjectResult claims only this module's typed product namespaces. The queue
// retains its private executor result for recovery; public status carries only a
// resource reference whose own endpoint rechecks current ownership/source scope.
// No SQL is needed, including while projecting a bounded job-status list.
func ProjectResult(job jobs.Job) (json.RawMessage, bool) {
	var payload GenerationPayload
	if json.Unmarshal(job.Payload, &payload) != nil {
		return nil, false
	}
	if payload.Product != "learning_path" && payload.Product != "topic_assessment" {
		return nil, false
	}
	if payload.Version != 1 || len(job.Result) == 0 {
		return nil, true
	}
	switch payload.Product {
	case "topic_assessment":
		if job.Kind != "quiz" {
			return nil, true
		}
		raw, _ := json.Marshal(map[string]string{"product": payload.Product, "assessment_id": GeneratedAssessmentID(job.ID)})
		return raw, true
	case "learning_path":
		if job.Kind != "path" || !identifiers.MatchString(payload.PathID) {
			return nil, true
		}
		raw, _ := json.Marshal(map[string]string{"product": payload.Product, "path_id": payload.PathID})
		return raw, true
	}
	return nil, false
}

// ProjectJobResult preserves the convenience wrapper for module callers. Queue
// HTTP handlers must use Queue.PublicJob for its fail-closed fallback policy.
func ProjectJobResult(job jobs.Job) jobs.Job {
	if raw, handled := ProjectResult(job); handled {
		job.Result = raw
	}
	return job
}
