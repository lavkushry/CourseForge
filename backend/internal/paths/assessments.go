package paths

import (
	"bytes"
	"context"
	"courseforge/backend/internal/httpx"
	"courseforge/backend/internal/identity"
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5"
	"math"
	"net/http"
	"strings"
	"time"
)

type Question struct {
	ID           string   `json:"id"`
	Question     string   `json:"question"`
	Options      []string `json:"options"`
	CorrectIndex int      `json:"correct_index"`
	Explanation  string   `json:"explanation"`
	Concept      string   `json:"concept"`
	Source       Source   `json:"source"`
	Excerpt      string   `json:"excerpt"`
}

// Null is not answer zero. Keep provider/manual JSON validation equivalent to
// the legacy strict integer index check.
func (q *Question) UnmarshalJSON(raw []byte) error {
	type plain Question
	var value struct {
		*plain
		CorrectIndex *int `json:"correct_index"`
	}
	value.plain = (*plain)(q)
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err := d.Decode(&value); err != nil {
		return err
	}
	if value.CorrectIndex == nil {
		return ErrInvalid
	}
	q.CorrectIndex = *value.CorrectIndex
	return nil
}

type Assessment struct {
	ID          string     `json:"id"`
	PathID      string     `json:"path_id"`
	StepID      string     `json:"step_id"`
	Questions   []Question `json:"questions"`
	Provenance  string     `json:"provenance"`
	CreatedAt   time.Time  `json:"created_at"`
	Fingerprint string     `json:"-"`
}
type Feedback struct {
	QuestionID   string `json:"question_id"`
	Correct      bool   `json:"correct"`
	ChosenIndex  int    `json:"chosen_index"`
	CorrectIndex int    `json:"correct_index"`
	Explanation  string `json:"explanation"`
	Concept      string `json:"concept"`
	Source       Source `json:"source"`
}
type Result struct {
	ID            string     `json:"id"`
	AssessmentID  string     `json:"assessment_id"`
	PathID        string     `json:"path_id"`
	StepID        string     `json:"step_id"`
	Score         int        `json:"score"`
	CorrectCount  int        `json:"correct_count"`
	TotalCount    int        `json:"total_count"`
	Status        string     `json:"status"`
	CompletedAt   time.Time  `json:"completed_at"`
	Feedback      []Feedback `json:"feedback"`
	ReviewSources []Source   `json:"review_sources"`
}

func masteryStatus(score int) string {
	if score < 70 {
		return "needs_practice"
	}
	if score < 85 {
		return "developing"
	}
	return "ready_for_review"
}
func publicAssessment(a Assessment) any {
	qs := []map[string]any{}
	for _, q := range a.Questions {
		qs = append(qs, map[string]any{"id": q.ID, "question": q.Question, "options": q.Options, "concept": q.Concept, "source": q.Source, "excerpt": q.Excerpt})
	}
	return map[string]any{"id": a.ID, "path_id": a.PathID, "step_id": a.StepID, "questions": qs, "question_count": len(qs), "provenance": a.Provenance, "created_at": a.CreatedAt}
}
func findStep(v Path, key string) (Step, error) {
	for _, step := range v.definition.Steps {
		if step.ID == key {
			return step, nil
		}
	}
	return Step{}, pgx.ErrNoRows
}
func assessmentFingerprint(v Path, step Step) string { return digest([]any{v.Fingerprint, step}) }
func validateQuestions(ctx context.Context, tx pgx.Tx, step Step, questions []Question) error {
	if len(questions) < 3 || len(questions) > 5 {
		return ErrInvalid
	}
	ids := map[string]bool{}
	prompts := map[string]bool{}
	for _, q := range questions {
		if !identifiers.MatchString(q.ID) || ids[q.ID] || !text(q.Question, 12, 350) || prompts[strings.ToLower(q.Question)] || len(q.Options) != 4 || q.CorrectIndex < 0 || q.CorrectIndex > 3 || !text(q.Explanation, 10, 800) || len(q.Concept) > 100 || q.Source.ChunkID == "" {
			return ErrInvalid
		}
		ids[q.ID] = true
		prompts[strings.ToLower(q.Question)] = true
		options := map[string]bool{}
		for _, o := range q.Options {
			if !text(o, 1, 240) || options[strings.ToLower(o)] {
				return ErrInvalid
			}
			options[strings.ToLower(o)] = true
		}
		var content string
		var start float64
		var lesson string
		e := tx.QueryRow(ctx, `SELECT text,start_seconds,lesson_id FROM transcript_chunks WHERE id=$1 AND length(trim(text))>0 FOR SHARE`, q.Source.ChunkID).Scan(&content, &start, &lesson)
		if e != nil {
			return e
		}
		if math.IsNaN(q.Source.Start) || math.IsInf(q.Source.Start, 0) || q.Source.Start != start || q.Source.LessonID != lesson {
			return ErrInvalid
		}
		matched := false
		for _, src := range step.Sources {
			if src.LessonID == lesson && src.CourseID == q.Source.CourseID && math.Abs(src.Start-start) <= 300 {
				matched = true
			}
		}
		if !matched {
			return ErrInvalid
		}
		if len(q.Excerpt) > 280 || !strings.Contains(content, q.Excerpt) {
			return ErrInvalid
		}
	}
	return nil
}
func saveAssessment(ctx context.Context, tx pgx.Tx, p identity.Principal, v Path, step Step, questions []Question, provenance, assessmentID string) (Assessment, error) {
	a := Assessment{ID: id("ta_"), PathID: v.ID, StepID: step.ID, Questions: questions, Provenance: provenance, Fingerprint: assessmentFingerprint(v, step)}
	if assessmentID != "" {
		a.ID = assessmentID
	}
	if v.Outdated {
		return a, ErrConflict
	}
	if e := validateQuestions(ctx, tx, step, questions); e != nil {
		return a, e
	}
	raw, _ := json.Marshal(a)
	e := tx.QueryRow(ctx, `INSERT INTO topic_assessments(id,user_id,path_id,step_id,source_fingerprint,content,provenance)VALUES($1,$2,$3,$4,$5,$6,$7)RETURNING created_at`, a.ID, p.UserID, a.PathID, a.StepID, a.Fingerprint, raw, provenance).Scan(&a.CreatedAt)
	return a, e
}
func (s *Service) assessment(ctx context.Context, tx pgx.Tx, p identity.Principal, key string) (Assessment, Path, error) {
	a := Assessment{}
	var raw []byte
	e := tx.QueryRow(ctx, `SELECT content,source_fingerprint,created_at,provenance FROM topic_assessments WHERE id=$1 AND user_id=$2`, key, p.UserID).Scan(&raw, &a.Fingerprint, &a.CreatedAt, &a.Provenance)
	if e != nil {
		return a, Path{}, e
	}
	fp, created, prov := a.Fingerprint, a.CreatedAt, a.Provenance
	if e = json.Unmarshal(raw, &a); e != nil {
		return a, Path{}, e
	}
	a.Fingerprint, a.CreatedAt, a.Provenance = fp, created, prov
	if e = snapshotAccess(ctx, tx, p, raw); e != nil {
		return a, Path{}, e
	}
	v, e := s.load(ctx, tx, p, a.PathID, true)
	return a, v, e
}
func (s *Service) manualAssessment(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Questions        []Question `json:"questions"`
		ExpectedRevision int64      `json:"expected_revision"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	tx, e := s.transaction(r)
	if e != nil {
		failure(w, e)
		return
	}
	defer tx.Rollback(r.Context())
	key := r.Header.Get("Idempotency-Key")
	hash := digest([]any{r.URL.Path, in})
	done, e := replayHTTP(w, r, tx, key, hash)
	if e != nil {
		failure(w, e)
		return
	}
	if done {
		return
	}
	v, e := s.load(r.Context(), tx, principal(r), r.PathValue("id"), true)
	if e != nil {
		failure(w, e)
		return
	}
	if v.Revision != in.ExpectedRevision {
		failure(w, ErrConflict)
		return
	}
	step, e := findStep(v, r.PathValue("step_id"))
	if e != nil {
		failure(w, e)
		return
	}
	a, e := saveAssessment(r.Context(), tx, principal(r), v, step, in.Questions, "manual", "")
	if e != nil {
		failure(w, e)
		return
	}
	if e = finish(w, r, tx, key, hash, v.CourseIDs, 201, publicAssessment(a)); e != nil {
		failure(w, e)
	}
}
func (s *Service) getAssessment(w http.ResponseWriter, r *http.Request) {
	tx, e := s.transaction(r)
	if e != nil {
		failure(w, e)
		return
	}
	defer tx.Rollback(r.Context())
	a, _, e := s.assessment(r.Context(), tx, principal(r), r.PathValue("id"))
	if e != nil {
		failure(w, e)
		return
	}
	httpx.JSON(w, 200, publicAssessment(a))
}
func (s *Service) attempt(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Answers map[string]*int `json:"answers"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	tx, e := s.transaction(r)
	if e != nil {
		failure(w, e)
		return
	}
	defer tx.Rollback(r.Context())
	key := r.Header.Get("Idempotency-Key")
	hash := digest([]any{r.URL.Path, in})
	done, e := replayHTTP(w, r, tx, key, hash)
	if e != nil {
		failure(w, e)
		return
	}
	if done {
		return
	}
	a, v, e := s.assessment(r.Context(), tx, principal(r), r.PathValue("id"))
	if e != nil {
		failure(w, e)
		return
	}
	step, e := findStep(v, a.StepID)
	if e != nil {
		failure(w, e)
		return
	}
	if v.Outdated || a.Fingerprint != assessmentFingerprint(v, step) {
		failure(w, ErrConflict)
		return
	}
	if len(in.Answers) != len(a.Questions) {
		failure(w, ErrInvalid)
		return
	}
	result := Result{ID: id("at_"), AssessmentID: a.ID, PathID: v.ID, StepID: a.StepID, TotalCount: len(a.Questions), Feedback: []Feedback{}, ReviewSources: []Source{}}
	for _, q := range a.Questions {
		answer, ok := in.Answers[q.ID]
		if !ok || answer == nil || *answer < 0 || *answer > 3 {
			failure(w, ErrInvalid)
			return
		}
		correct := *answer == q.CorrectIndex
		if correct {
			result.CorrectCount++
		} else {
			result.ReviewSources = append(result.ReviewSources, q.Source)
		}
		result.Feedback = append(result.Feedback, Feedback{q.ID, correct, *answer, q.CorrectIndex, q.Explanation, q.Concept, q.Source})
	}
	result.Score = int(math.RoundToEven(100 * float64(result.CorrectCount) / float64(result.TotalCount)))
	result.Status = masteryStatus(result.Score)
	if e = tx.QueryRow(r.Context(), `SELECT now()`).Scan(&result.CompletedAt); e != nil {
		failure(w, e)
		return
	}
	answers, _ := json.Marshal(in.Answers)
	raw, _ := json.Marshal(result)
	_, e = tx.Exec(r.Context(), `INSERT INTO topic_assessment_attempts(id,user_id,assessment_id,score,correct_count,total_count,answers,result,completed_at)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, result.ID, principal(r).UserID, a.ID, result.Score, result.CorrectCount, result.TotalCount, answers, raw, result.CompletedAt)
	if e != nil {
		failure(w, e)
		return
	}
	if e = finish(w, r, tx, key, hash, v.CourseIDs, 201, result); e != nil {
		failure(w, e)
	}
}
func (s *Service) history(w http.ResponseWriter, r *http.Request) {
	limit, cursor, ok := page(w, r)
	if !ok {
		return
	}
	mark, e := cursorValue(cursor)
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
	v, e := s.load(r.Context(), tx, principal(r), r.PathValue("id"), false)
	if e != nil {
		failure(w, e)
		return
	}
	step := r.URL.Query().Get("step_id")
	if step != "" {
		if _, e = findStep(v, step); e != nil {
			failure(w, e)
			return
		}
	}
	rows, e := tx.Query(r.Context(), `SELECT t.id,t.result,t.completed_at FROM topic_assessment_attempts t JOIN topic_assessments a ON a.id=t.assessment_id WHERE t.user_id=$1 AND a.user_id=$1 AND a.path_id=$2 AND ($3='' OR a.step_id=$3) AND (t.completed_at,t.id)<($4,$5) ORDER BY t.completed_at DESC,t.id DESC LIMIT $6`, principal(r).UserID, v.ID, step, mark.At, mark.ID, limit+1)
	if e != nil {
		failure(w, e)
		return
	}
	items := []json.RawMessage{}
	ids := []string{}
	times := []time.Time{}
	for rows.Next() {
		var key string
		var raw []byte
		var at time.Time
		if e = rows.Scan(&key, &raw, &at); e != nil {
			rows.Close()
			failure(w, e)
			return
		}
		ids = append(ids, key)
		times = append(times, at)
		items = append(items, json.RawMessage(raw))
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		failure(w, e)
		return
	}
	next := ""
	if len(items) > limit {
		items = items[:limit]
		next = encodeCursor(times[limit-1], ids[limit-1])
	}
	visible := []json.RawMessage{}
	for _, raw := range items {
		if e = snapshotAccess(r.Context(), tx, principal(r), raw); errors.Is(e, pgx.ErrNoRows) {
			continue
		} else if e != nil {
			failure(w, e)
			return
		}
		visible = append(visible, raw)
	}
	httpx.JSON(w, 200, map[string]any{"attempts": visible, "next_cursor": next})
}
