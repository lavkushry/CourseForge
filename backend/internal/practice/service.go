// Package practice keeps recommendations and verified lab outcomes separate from
// assessments, checklist state and video completion. Executors belong to labs.
package practice

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"courseforge/backend/internal/httpx"
	"courseforge/backend/internal/identity"
	"courseforge/backend/internal/paths"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrInvalid = errors.New("invalid practice command")
var ErrConflict = errors.New("practice command or evidence conflict")
var ErrUnavailable = errors.New("verified labs unavailable")

type PathReader interface {
	ReadPath(context.Context, pgx.Tx, identity.Principal, string) (paths.Path, error)
}

// Labs methods perform bounded SQL in the supplied transaction. A real adapter
// creates durable owned curated sessions and reads accepted fenced runner evidence.
// It must not invoke a runner or perform filesystem/network IO here.
type Labs interface {
	Start(context.Context, pgx.Tx, identity.Principal, string, string) (LabSession, error)
	Grade(context.Context, pgx.Tx, identity.Principal, string, string) (GradeEvidence, error)
}
type LabSession struct {
	SessionID       string   `json:"session_id"`
	OwnerID         string   `json:"-"`
	Slug            string   `json:"slug"`
	Status          string   `json:"status"`
	Title           string   `json:"title"`
	Type            string   `json:"type"`
	Category        string   `json:"category"`
	Level           string   `json:"level"`
	Filename        string   `json:"filename,omitempty"`
	Content         string   `json:"content,omitempty"`
	Objective       string   `json:"objective,omitempty"`
	Tip             string   `json:"tip,omitempty"`
	PracticeContext *Context `json:"practice_context,omitempty"`
}
type Context struct {
	PathID string `json:"path_id"`
	StepID string `json:"step_id"`
}
type Check struct {
	ID     string `json:"id"`
	Passed bool   `json:"passed"`
}
type GradeEvidence struct {
	ID             string    `json:"id"`
	OwnerID        string    `json:"owner_id"`
	SessionID      string    `json:"session_id"`
	Slug           string    `json:"slug"`
	GraderVersion  string    `json:"grader_version"`
	SubmissionHash string    `json:"submission_hash"`
	Accepted       bool      `json:"accepted"`
	Passed         bool      `json:"passed"`
	Checks         []Check   `json:"checks"`
	CompletedAt    time.Time `json:"completed_at"`
}
type Service struct {
	Pool  *pgxpool.Pool
	Paths PathReader
	Labs  Labs
}

func New(pool *pgxpool.Pool, reader PathReader) *Service { return &Service{Pool: pool, Paths: reader} }
func (s *Service) Register(mux *http.ServeMux, auth *identity.Service) {
	for route, h := range map[string]http.HandlerFunc{
		"GET /api/v1/learning-paths/{id}/practice-recommendations":               s.recommendations,
		"GET /api/v1/learning-paths/{id}/practice-history":                       s.history,
		"GET /api/v1/learning-paths/{id}/practice-status":                        s.status,
		"POST /api/v1/learning-paths/{id}/steps/{step_id}/practice/{slug}/start": s.start,
		"POST /api/v1/practice/sessions/{id}/verified-attempts":                  s.accept,
	} {
		mux.Handle(route, auth.Require(h))
	}
}
func principal(r *http.Request) identity.Principal {
	p, _ := identity.FromContext(r.Context())
	return p
}
func (s *Service) transaction(r *http.Request) (pgx.Tx, error) {
	tx, e := s.Pool.Begin(r.Context())
	if e != nil {
		return nil, e
	}
	if e = identity.LockPrincipal(r.Context(), tx, principal(r)); e != nil {
		tx.Rollback(r.Context())
		return nil, e
	}
	return tx, nil
}
func failure(w http.ResponseWriter, e error) {
	switch {
	case errors.Is(e, pgx.ErrNoRows):
		httpx.Error(w, 404, "not_found", "Private practice or source unavailable")
	case errors.Is(e, ErrInvalid):
		httpx.Error(w, 422, "invalid_practice", "Check curated topic, evidence and command fields")
	case errors.Is(e, ErrConflict):
		httpx.Error(w, 409, "conflict", "Practice command or source changed")
	case errors.Is(e, ErrUnavailable):
		httpx.Error(w, 503, "verified_labs_unavailable", "A verified lab adapter is not configured")
	default:
		httpx.Error(w, 503, "practice_unavailable", "Practice service unavailable")
	}
}
func (s *Service) path(ctx context.Context, tx pgx.Tx, p identity.Principal, key string) (paths.Path, error) {
	if s.Paths == nil {
		return paths.Path{}, ErrUnavailable
	}
	return s.Paths.ReadPath(ctx, tx, p, key)
}
func findStep(v paths.Path, key string) (paths.PublicStep, error) {
	for _, step := range v.Steps {
		if step.ID == key {
			return step, nil
		}
	}
	return paths.PublicStep{}, pgx.ErrNoRows
}
func hash(v any) string {
	raw, _ := json.Marshal(v)
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}
func freshID() string {
	raw := make([]byte, 16)
	if _, e := rand.Read(raw); e != nil {
		panic(e)
	}
	return "pa_" + hex.EncodeToString(raw)
}
func bounded(v string, n int) bool { return len(v) > 0 && len(v) <= n && strings.TrimSpace(v) == v }

type sourceSnapshot struct {
	CourseIDs []string       `json:"course_ids"`
	Sources   []paths.Source `json:"sources"`
}

func snapshot(v paths.Path, step paths.PublicStep) sourceSnapshot {
	return sourceSnapshot{v.CourseIDs, step.Sources}
}

// Subject identity excludes unrelated path goals/steps, while retaining this
// topic's source text/version. An unchanged topic keeps its verified signal after
// a roadmap refresh; changed source material cannot inherit an old lab result.
func subjectFingerprint(ctx context.Context, tx pgx.Tx, step paths.Step) (string, error) {
	parts := []any{step}
	for _, src := range step.Sources {
		var title string
		var duration float64
		if e := tx.QueryRow(ctx, `SELECT title,duration_seconds FROM lessons WHERE id=$1 AND course_id=$2 FOR SHARE`, src.LessonID, src.CourseID).Scan(&title, &duration); e != nil {
			return "", e
		}
		parts = append(parts, []any{src.LessonID, src.CourseID, title, duration})
		rows, e := tx.Query(ctx, `SELECT id,start_seconds,end_seconds,text FROM transcript_chunks WHERE lesson_id=$1 AND abs(start_seconds-$2)<=300 ORDER BY abs(start_seconds-$2),id LIMIT 10 FOR SHARE`, src.LessonID, src.Start)
		if e != nil {
			return "", e
		}
		for rows.Next() {
			var id, content string
			var start, end float64
			if e = rows.Scan(&id, &start, &end, &content); e != nil {
				rows.Close()
				return "", e
			}
			parts = append(parts, []any{id, start, end, content})
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return "", e
		}
	}
	return hash(parts), nil
}

// Historical evidence retains original text-independent citation bindings. Current
// identity is locked by the caller; all original courses/lessons/chunks are locked.
func validateScope(ctx context.Context, tx pgx.Tx, p identity.Principal, raw []byte) error {
	var v sourceSnapshot
	if json.Unmarshal(raw, &v) != nil || len(v.CourseIDs) < 1 || len(v.CourseIDs) > 8 || len(v.Sources) < 1 || len(v.Sources) > 8 {
		return ErrInvalid
	}
	courses := map[string]bool{}
	for _, course := range v.CourseIDs {
		var id string
		e := tx.QueryRow(ctx, `SELECT id FROM courses c WHERE id=$2 AND ($3='admin' OR (published AND EXISTS(SELECT 1 FROM enrollments WHERE user_id=$1 AND course_id=c.id))) FOR SHARE OF c`, p.UserID, course, p.Role).Scan(&id)
		if e != nil {
			return e
		}
		if p.Role != "admin" {
			if e = tx.QueryRow(ctx, `SELECT course_id FROM enrollments WHERE user_id=$1 AND course_id=$2 FOR SHARE`, p.UserID, course).Scan(&id); e != nil {
				return e
			}
		}
		courses[course] = true
	}
	for _, src := range v.Sources {
		if !courses[src.CourseID] {
			return ErrInvalid
		}
		var id string
		if e := tx.QueryRow(ctx, `SELECT id FROM lessons WHERE id=$1 AND course_id=$2 FOR SHARE`, src.LessonID, src.CourseID).Scan(&id); e != nil {
			return e
		}
		if src.ChunkID != "" {
			if e := tx.QueryRow(ctx, `SELECT id FROM transcript_chunks WHERE id=$1 AND lesson_id=$2 FOR SHARE`, src.ChunkID, src.LessonID).Scan(&id); e != nil {
				return e
			}
		}
	}
	return nil
}
func replay(w http.ResponseWriter, r *http.Request, tx pgx.Tx, key, digest string) (bool, error) {
	if !bounded(key, 128) {
		return false, ErrInvalid
	}
	if _, e := tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock(hashtextextended($1,691201))`, principal(r).UserID+":"+key); e != nil {
		return false, e
	}
	var old string
	var raw, scope []byte
	var status int
	e := tx.QueryRow(r.Context(), `SELECT request_hash,response,source_snapshot,status FROM practice_commands WHERE user_id=$1 AND idempotency_key=$2`, principal(r).UserID, key).Scan(&old, &raw, &scope, &status)
	if errors.Is(e, pgx.ErrNoRows) {
		return false, nil
	}
	if e != nil {
		return false, e
	}
	if old != digest {
		return false, ErrConflict
	}
	if e = validateScope(r.Context(), tx, principal(r), scope); e != nil {
		return false, e
	}
	if e = tx.Commit(r.Context()); e != nil {
		return false, e
	}
	httpx.JSON(w, status, json.RawMessage(raw))
	return true, nil
}
func finish(w http.ResponseWriter, r *http.Request, tx pgx.Tx, key, digest string, scope sourceSnapshot, status int, value any) error {
	raw, e := json.Marshal(value)
	if e != nil {
		return e
	}
	scopeRaw, _ := json.Marshal(scope)
	_, e = tx.Exec(r.Context(), `INSERT INTO practice_commands(user_id,idempotency_key,request_hash,course_ids,source_snapshot,response,status)VALUES($1,$2,$3,$4,$5,$6,$7)`, principal(r).UserID, key, digest, scope.CourseIDs, scopeRaw, raw, status)
	if e != nil {
		return e
	}
	if e = tx.Commit(r.Context()); e != nil {
		return e
	}
	httpx.JSON(w, status, value)
	return nil
}
func (s *Service) start(w http.ResponseWriter, r *http.Request) {
	var body *struct{}
	if !httpx.Decode(w, r, &body) {
		return
	}
	if body == nil {
		httpx.Error(w, 400, "invalid_json", "Use an empty JSON object")
		return
	}
	tx, e := s.transaction(r)
	if e != nil {
		failure(w, e)
		return
	}
	defer tx.Rollback(r.Context())
	key := r.Header.Get("Idempotency-Key")
	digest := hash([]any{r.URL.Path, body})
	done, e := replay(w, r, tx, key, digest)
	if done || e != nil {
		if e != nil {
			failure(w, e)
		}
		return
	}
	v, e := s.path(r.Context(), tx, principal(r), r.PathValue("id"))
	if e != nil {
		failure(w, e)
		return
	}
	if v.Outdated {
		failure(w, ErrConflict)
		return
	}
	step, e := findStep(v, r.PathValue("step_id"))
	if e != nil {
		failure(w, e)
		return
	}
	lab, ok := curated[r.PathValue("slug")]
	if !ok {
		failure(w, pgx.ErrNoRows)
		return
	}
	if topicScore(step.Step, lab.Terms) == 0 {
		failure(w, ErrConflict)
		return
	}
	if s.Labs == nil {
		failure(w, ErrUnavailable)
		return
	}
	session, e := s.Labs.Start(r.Context(), tx, principal(r), lab.Slug, key)
	if e != nil {
		failure(w, e)
		return
	}
	if session.OwnerID != principal(r).UserID || session.Slug != lab.Slug || !bounded(session.SessionID, 100) || len(session.Content) > 100000 {
		failure(w, ErrInvalid)
		return
	}
	session.PracticeContext = &Context{v.ID, step.ID}
	scope := snapshot(v, step)
	raw, _ := json.Marshal(scope)
	fingerprint, e := subjectFingerprint(r.Context(), tx, step.Step)
	if e != nil {
		failure(w, e)
		return
	}
	_, e = tx.Exec(r.Context(), `INSERT INTO practice_sessions(session_id,user_id,path_id,step_id,lab_slug,source_snapshot,source_fingerprint)VALUES($1,$2,$3,$4,$5,$6,$7)`, session.SessionID, principal(r).UserID, v.ID, step.ID, lab.Slug, raw, fingerprint)
	if e == nil {
		e = finish(w, r, tx, key, digest, scope, 201, session)
	}
	if e != nil {
		failure(w, e)
	}
}

type cursor struct {
	At time.Time `json:"at"`
	ID string    `json:"id"`
}

func page(r *http.Request) (int, cursor, error) {
	limit := 30
	if raw := r.URL.Query().Get("limit"); raw != "" {
		n, e := strconv.Atoi(raw)
		if e != nil || n < 1 || n > 100 {
			return 0, cursor{}, ErrInvalid
		}
		limit = n
	}
	mark := cursor{time.Now().Add(24 * time.Hour), strings.Repeat("z", 100)}
	if raw := r.URL.Query().Get("cursor"); raw != "" {
		if len(raw) > 512 {
			return 0, cursor{}, ErrInvalid
		}
		data, e := base64.RawURLEncoding.DecodeString(raw)
		if e != nil || json.Unmarshal(data, &mark) != nil || mark.At.IsZero() || len(mark.ID) > 100 {
			return 0, cursor{}, ErrInvalid
		}
	}
	return limit, mark, nil
}
func encodeCursor(at time.Time, id string) string {
	raw, _ := json.Marshal(cursor{at, id})
	return base64.RawURLEncoding.EncodeToString(raw)
}
