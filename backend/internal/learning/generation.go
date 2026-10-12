package learning

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"courseforge/backend/internal/httpx"
	"courseforge/backend/internal/identity"
	"courseforge/backend/internal/jobs"
	"github.com/jackc/pgx/v5"
)

// GenerationPayload is internal queue input; clients cannot choose arbitrary
// course/user IDs or model/provider endpoints.
type GenerationPayload struct {
	Version          int   `json:"version"`
	Count            int   `json:"count"`
	ExpectedRevision int64 `json:"expected_revision,omitempty"`
}

type GenerationResult struct {
	Version   int         `json:"version"`
	LessonID  string      `json:"lesson_id"`
	Cards     []CardInput `json:"cards,omitempty"`
	Questions []Question  `json:"questions,omitempty"`
}

// Defaults apply only to omitted fields. Explicit zero/null/invalid types cannot
// silently consume a queue slot for a larger default generation request.
func generationCount(raw json.RawMessage, fallback int) (int, bool) {
	if len(raw) == 0 {
		return fallback, true
	}
	var count int
	if json.Unmarshal(raw, &count) != nil || count < 1 || count > 20 {
		return 0, false
	}
	return count, true
}

func (s *Service) reviewGenerate(w http.ResponseWriter, r *http.Request) {
	var in struct {
		LessonID string          `json:"lesson_id"`
		Count    json.RawMessage `json:"count"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	count, valid := generationCount(in.Count, 8)
	if len(in.LessonID) < 1 || len(in.LessonID) > 500 || !valid {
		failure(w, ErrInvalid)
		return
	}
	s.submitGeneration(w, r, "review", in.LessonID, GenerationPayload{Version: 1, Count: count})
}

func (s *Service) quizGenerate(w http.ResponseWriter, r *http.Request) {
	if !admin(w, r) {
		return
	}
	var in struct {
		Count            json.RawMessage `json:"count"`
		ExpectedRevision *int64          `json:"expected_revision"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	count, valid := generationCount(in.Count, 5)
	if !valid || in.ExpectedRevision == nil || *in.ExpectedRevision < 0 {
		failure(w, ErrInvalid)
		return
	}
	s.submitGeneration(w, r, "quiz", r.PathValue("id"), GenerationPayload{Version: 1, Count: count, ExpectedRevision: *in.ExpectedRevision})
}

func (s *Service) submitGeneration(w http.ResponseWriter, r *http.Request, kind, lesson string, payload GenerationPayload) {
	if s.Queue == nil {
		httpx.Error(w, 503, "generation_unavailable", "Generation is not configured")
		return
	}
	if !s.lessonRead(w, r, lesson) {
		return
	}
	// Reject an impossible request without consuming a durable queue slot.
	var count int
	if err := s.Pool.QueryRow(r.Context(), `SELECT count(*) FROM transcript_chunks WHERE lesson_id=$1 AND length(trim(text))>0`, lesson).Scan(&count); err != nil {
		failure(w, err)
		return
	}
	if count == 0 {
		httpx.Error(w, 409, "sources_pending", "This lesson needs indexed source material before generation")
		return
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		failure(w, err)
		return
	}
	job, err := s.Queue.Submit(r.Context(), principal(r), r.Header.Get("Idempotency-Key"), jobs.Command{Kind: kind, LessonID: lesson, Payload: raw})
	if err != nil {
		failure(w, err)
		return
	}
	w.Header().Set("Location", "/api/v1/jobs/"+job.ID)
	httpx.JSON(w, 202, s.Queue.PublicJob(job))
}

func decodeGeneration(raw json.RawMessage, v any) error {
	if len(raw) == 0 || len(raw) > 1<<20 {
		return ErrInvalid
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(v) != nil || d.Decode(new(any)) != io.EOF {
		return ErrInvalid
	}
	return nil
}

// PublishResult is the SQL-only callback for Queue.Complete. The queue must call
// it inside its still-current lease/fence transaction; never call it after an
// external executor has committed. All cards are learner private. Generated quiz
// definitions enter draft status and need explicit administrator approval.
func (s *Service) PublishResult(ctx context.Context, tx pgx.Tx, job jobs.Job, raw json.RawMessage) (err error) {
	defer func() {
		if errors.Is(err, ErrInvalid) {
			err = errors.Join(jobs.ErrInvalid, err)
		}
	}()
	if job.Kind != "review" && job.Kind != "quiz" {
		return jobs.ErrInvalid
	}
	// Read immutable scope from the actual queue row, not an executor response.
	var user, lesson, kind string
	var payloadRaw json.RawMessage
	if err := tx.QueryRow(ctx, `SELECT user_id,lesson_id,kind,payload FROM jobs WHERE id=$1 AND state='running'`, job.ID).Scan(&user, &lesson, &kind, &payloadRaw); err != nil {
		return err
	}
	if kind != job.Kind || user != job.UserID || lesson != job.LessonID {
		return jobs.ErrDenied
	}
	var payload GenerationPayload
	var result GenerationResult
	if decodeGeneration(payloadRaw, &payload) != nil || decodeGeneration(raw, &result) != nil || payload.Version != 1 || payload.Count < 1 || payload.Count > 20 || result.Version != 1 || result.LessonID != lesson {
		return ErrInvalid
	}
	var course string
	if err := tx.QueryRow(ctx, `SELECT course_id FROM lessons WHERE id=$1`, lesson).Scan(&course); err != nil {
		return err
	}
	var role string
	if err := tx.QueryRow(ctx, `SELECT role FROM users WHERE id=$1 AND verified AND NOT suspended FOR SHARE`, user).Scan(&role); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return jobs.ErrDenied
		}
		return err
	}
	if err := courseWrite(ctx, tx, identity.Principal{UserID: user, Role: role}, course); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return jobs.ErrDenied
		}
		return err
	}
	if kind == "quiz" {
		if role != "admin" {
			return jobs.ErrDenied
		}
		if len(result.Cards) != 0 || len(result.Questions) != payload.Count {
			return ErrInvalid
		}
		q, err := saveQuiz(ctx, tx, lesson, payload.ExpectedRevision, quizInput{Questions: result.Questions, Status: "draft"}, true)
		if err == nil {
			err = auditQuiz(ctx, tx, user, "quiz_generated", q)
		}
		return err
	}
	if len(result.Questions) != 0 || len(result.Cards) != payload.Count {
		return ErrInvalid
	}
	for _, card := range result.Cards {
		if card.CourseID != course || card.LessonID == nil || *card.LessonID != lesson || card.SourceChunkID == nil || !validCard(card) {
			return ErrInvalid
		}
		if err := sourceBounds(ctx, tx, lesson, card.SourceStart, card.SourceChunkID); err != nil {
			return err
		}
	}
	for index, card := range result.Cards {
		if _, err := insertCard(ctx, tx, user, card, &job.ID, &index); err != nil {
			return err
		}
	}
	return nil
}
