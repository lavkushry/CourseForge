package paths

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"courseforge/backend/internal/httpx"
	"courseforge/backend/internal/identity"
	"courseforge/backend/internal/jobs"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrInvalid = errors.New("invalid path command")
var ErrConflict = errors.New("path command or source revision conflict")
var ErrUnavailable = errors.New("generation unavailable")
var identifiers = regexp.MustCompile(`^[A-Za-z0-9_-]{1,100}$`)

type Service struct {
	Pool              *pgxpool.Pool
	Queue             *jobs.Queue
	ExecutorAvailable bool
}

func New(pool *pgxpool.Pool, queue *jobs.Queue) *Service { return &Service{Pool: pool, Queue: queue} }

// ReadPath provides the SQL-only current source/access projection for adjacent
// learning modules. The caller owns the transaction and principal lock; this
// never performs model/provider work or grants checklist/mastery credit.
func (s *Service) ReadPath(ctx context.Context, tx pgx.Tx, p identity.Principal, id string) (Path, error) {
	return s.load(ctx, tx, p, id, false)
}
func (s *Service) Register(mux *http.ServeMux, auth *identity.Service) {
	for route, h := range map[string]http.HandlerFunc{
		"GET /api/v1/learning-paths": s.list, "POST /api/v1/learning-paths": s.generatePath,
		"POST /api/v1/learning-paths/manual": s.manual, "GET /api/v1/learning-paths/{id}": s.get,
		"PUT /api/v1/learning-paths/{id}": s.manual, "DELETE /api/v1/learning-paths/{id}": s.delete,
		"PUT /api/v1/learning-paths/{id}/steps/{step_id}":                     s.complete,
		"POST /api/v1/learning-paths/{id}/steps/{step_id}/assessments":        s.generateAssessment,
		"POST /api/v1/learning-paths/{id}/steps/{step_id}/assessments/manual": s.manualAssessment,
		"GET /api/v1/assessments/{id}":                                        s.getAssessment, "POST /api/v1/assessments/{id}/attempts": s.attempt,
		"GET /api/v1/learning-paths/{id}/assessment-history": s.history,
	} {
		mux.Handle(route, auth.Require(h))
	}
}

type Source struct {
	LessonID string  `json:"lesson_id"`
	CourseID string  `json:"course_id"`
	Start    float64 `json:"start"`
	ChunkID  string  `json:"chunk_id,omitempty"`
	Title    string  `json:"title,omitempty"`
}
type Step struct {
	ID            string   `json:"id"`
	Title         string   `json:"title"`
	Objectives    []string `json:"objectives"`
	Sources       []Source `json:"sources"`
	Prerequisites []string `json:"prerequisites"`
	GoalFocus     bool     `json:"goal_focus"`
}
type Definition struct {
	ID               string   `json:"id"`
	Goal             string   `json:"goal"`
	CourseIDs        []string `json:"course_ids"`
	Steps            []Step   `json:"steps"`
	ExpectedRevision int64    `json:"expected_revision"`
}
type Mastery struct {
	LastScore     int       `json:"last_score"`
	Status        string    `json:"status"`
	Attempts      int       `json:"attempts"`
	LastAttemptAt time.Time `json:"last_attempt_at"`
	Correct       int       `json:"correct_count"`
	Total         int       `json:"total_count"`
}
type PublicStep struct {
	Step
	Completed      bool     `json:"completed"`
	WatchedSources int      `json:"watched_sources"`
	Mastery        *Mastery `json:"mastery"`
}
type Path struct {
	ID                string       `json:"id"`
	Goal              string       `json:"goal"`
	CourseIDs         []string     `json:"course_ids"`
	Steps             []PublicStep `json:"steps"`
	Provenance        string       `json:"provenance"`
	Fingerprint       string       `json:"source_fingerprint"`
	Revision          int64        `json:"revision"`
	Outdated          bool         `json:"outdated"`
	CompletedSteps    int          `json:"completed_steps"`
	CompletionPercent int          `json:"completion_percent"`
	AssessedTopics    int          `json:"assessed_topics"`
	NeedsPractice     int          `json:"topics_needing_practice"`
	NextStepID        *string      `json:"next_step_id"`
	CreatedAt         time.Time    `json:"created_at"`
	UpdatedAt         time.Time    `json:"updated_at"`
	definition        Definition
}

func principal(r *http.Request) identity.Principal {
	p, _ := identity.FromContext(r.Context())
	return p
}
func text(v string, min, max int) bool {
	n := utf8.RuneCountInString(v)
	return n >= min && n <= max && strings.TrimSpace(v) == v
}
func id(prefix string) string {
	b := make([]byte, 16)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return prefix + hex.EncodeToString(b)
}
func digest(v any) string {
	b, _ := json.Marshal(v)
	return digestBytes(b)
}
func digestBytes(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}
func failure(w http.ResponseWriter, e error) {
	switch {
	case errors.Is(e, pgx.ErrNoRows):
		httpx.Error(w, 404, "not_found", "Private path or source unavailable")
	case errors.Is(e, ErrInvalid), errors.Is(e, jobs.ErrInvalid):
		httpx.Error(w, 422, "invalid_path", "Check source references, questions and path definition")
	case errors.Is(e, ErrConflict), errors.Is(e, jobs.ErrConflict):
		httpx.Error(w, 409, "conflict", "The command, revision or source changed")
	case errors.Is(e, ErrUnavailable):
		httpx.Error(w, 503, "generation_unavailable", "A real generation executor is not configured")
	default:
		httpx.Error(w, 503, "paths_unavailable", "Path service unavailable")
	}
}
func courseAccess(ctx context.Context, tx pgx.Tx, p identity.Principal, courses []string) error {
	for _, course := range courses {
		var v string
		e := tx.QueryRow(ctx, `SELECT id FROM courses c WHERE id=$2 AND ($3='admin' OR (published AND EXISTS(SELECT 1 FROM enrollments WHERE user_id=$1 AND course_id=c.id))) FOR SHARE OF c`, p.UserID, course, p.Role).Scan(&v)
		if e != nil {
			return e
		}
		if p.Role != "admin" {
			e = tx.QueryRow(ctx, `SELECT course_id FROM enrollments WHERE user_id=$1 AND course_id=$2 FOR SHARE`, p.UserID, course).Scan(&v)
			if e != nil {
				return e
			}
		}
	}
	return nil
}
func (s *Service) transaction(r *http.Request) (pgx.Tx, error) {
	tx, e := s.Pool.Begin(r.Context())
	if e == nil {
		e = identity.LockPrincipal(r.Context(), tx, principal(r))
		if e != nil {
			tx.Rollback(r.Context())
		}
	}
	return tx, e
}
