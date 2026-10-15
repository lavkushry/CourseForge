// Package learning owns private bookmarks, review scheduling and immutable quiz
// grading. It performs no AI or provider calls inside learning transactions.
package learning

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"courseforge/backend/internal/access"
	"courseforge/backend/internal/httpx"
	"courseforge/backend/internal/identity"
	"courseforge/backend/internal/jobs"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrInvalid  = errors.New("invalid learning record")
	ErrConflict = errors.New("learning record changed or command key reused")
)

type Service struct {
	Pool  *pgxpool.Pool
	Queue *jobs.Queue
}

func New(pool *pgxpool.Pool, queue *jobs.Queue) *Service { return &Service{Pool: pool, Queue: queue} }
func (s *Service) Register(mux *http.ServeMux, auth *identity.Service) {
	routes := map[string]http.HandlerFunc{
		"GET /api/v1/lessons/{id}/bookmarks":              s.bookmarks,
		"POST /api/v1/lessons/{id}/bookmarks":             s.bookmarkCreate,
		"DELETE /api/v1/bookmarks/{id}":                   s.bookmarkDelete,
		"GET /api/v1/reviews/cards":                       s.cards,
		"POST /api/v1/reviews/cards":                      s.cardCreate,
		"GET /api/v1/reviews/due":                         s.due,
		"POST /api/v1/reviews/{id}/grade":                 s.grade,
		"GET /api/v1/reviews/history":                     s.reviewHistory,
		"POST /api/v1/reviews/complete":                   s.reviewComplete,
		"POST /api/v1/reviews/generate":                   s.reviewGenerate,
		"GET /api/v1/lessons/{id}/quiz":                   s.quiz,
		"POST /api/v1/lessons/{id}/quiz/attempts":         s.quizSubmit,
		"GET /api/v1/lessons/{id}/quiz/attempts":          s.quizHistory,
		"GET /api/v1/courses/{id}/quizzes/status":         s.quizStatus,
		"GET /api/v1/admin/courses/{id}/quizzes":          s.adminQuizzes,
		"GET /api/v1/admin/quizzes/{id}":                  s.adminQuiz,
		"POST /api/v1/admin/lessons/{id}/quiz":            s.adminQuizCreate,
		"PUT /api/v1/admin/quizzes/{id}":                  s.adminQuizUpdate,
		"POST /api/v1/admin/lessons/{id}/quiz/regenerate": s.quizGenerate,
		"GET /api/v1/me/learning-preferences":             s.preferences,
		"PUT /api/v1/me/learning-preferences":             s.preferencesPut,
		"GET /api/v1/me/learning-credits":                 s.credits,
	}
	for route, h := range routes {
		mux.Handle(route, auth.Require(h))
	}
}
func principal(r *http.Request) identity.Principal {
	p, _ := identity.FromContext(r.Context())
	return p
}
func identifier(prefix string) (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return prefix + hex.EncodeToString(b), nil
}
func validText(v string, min, max int) bool {
	n := utf8.RuneCountInString(v)
	return n >= min && n <= max
}
func validPosition(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) && v >= 0 && v < 1e9 }
func failure(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, pgx.ErrNoRows), errors.Is(err, jobs.ErrDenied):
		httpx.Error(w, 404, "not_found", "Learning record not found")
	case errors.Is(err, ErrInvalid), errors.Is(err, jobs.ErrInvalid):
		httpx.Error(w, 422, "invalid_record", "Check the learning record and source citation")
	case errors.Is(err, ErrConflict), errors.Is(err, jobs.ErrConflict):
		httpx.Error(w, 409, "conflict", "The record changed or the command key was reused")
	case errors.Is(err, jobs.ErrBusy):
		w.Header().Set("Retry-After", "1")
		httpx.Error(w, 503, "queue_busy", "Generation queue is at capacity")
	default:
		httpx.Error(w, 503, "unavailable", "Learning records are temporarily unavailable")
	}
}
func admin(w http.ResponseWriter, r *http.Request) bool {
	if principal(r).Role != "admin" {
		httpx.Error(w, 403, "admin_required", "Administrator access required")
		return false
	}
	return true
}

const visibleCourse = `($2='admin' OR (c.published AND EXISTS(SELECT 1 FROM enrollments e WHERE e.user_id=$1 AND e.course_id=c.id)))`

func (s *Service) lessonRead(w http.ResponseWriter, r *http.Request, id string) bool {
	p := principal(r)
	ok, err := access.CanLesson(r.Context(), s.Pool, p.UserID, p.Role, id)
	if err != nil {
		failure(w, err)
		return false
	}
	if !ok {
		failure(w, pgx.ErrNoRows)
		return false
	}
	return true
}
func courseWrite(ctx context.Context, tx pgx.Tx, p identity.Principal, id string) error {
	var published bool
	if err := tx.QueryRow(ctx, "SELECT published FROM courses WHERE id=$1 FOR SHARE", id).Scan(&published); err != nil {
		return err
	}
	if p.Role == "admin" {
		return nil
	}
	if !published {
		return pgx.ErrNoRows
	}
	var own string
	return tx.QueryRow(ctx, "SELECT user_id FROM enrollments WHERE user_id=$1 AND course_id=$2 FOR SHARE", p.UserID, id).Scan(&own)
}

type guard func(context.Context, pgx.Tx, identity.Principal) error
type command func(context.Context, pgx.Tx, identity.Principal) (any, error)

func lessonGuard(id string) guard {
	return func(ctx context.Context, tx pgx.Tx, p identity.Principal) error {
		return access.LessonWrite(ctx, tx, p, id)
	}
}
func courseGuard(id string) guard {
	return func(ctx context.Context, tx pgx.Tx, p identity.Principal) error { return courseWrite(ctx, tx, p, id) }
}

// mutate serializes a single owner's command key. Its durable response snapshot
// survives a retry after a later edit and is checked only after current access.
func (s *Service) mutate(w http.ResponseWriter, r *http.Request, status int, kind string, request any, check guard, run command) {
	key := r.Header.Get("Idempotency-Key")
	if len(key) < 1 || len(key) > 128 || strings.TrimSpace(key) != key {
		httpx.Error(w, 400, "idempotency_required", "Supply an Idempotency-Key of 1..128 characters")
		return
	}
	raw, err := json.Marshal(request)
	if err != nil {
		failure(w, ErrInvalid)
		return
	}
	ctx := r.Context()
	p := principal(r)
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		failure(w, err)
		return
	}
	defer tx.Rollback(ctx)
	if err = identity.LockPrincipal(ctx, tx, p); err == nil && check != nil {
		err = check(ctx, tx, p)
	}
	if err != nil {
		failure(w, err)
		return
	}
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,74921))`, p.UserID+":"+key); err != nil {
		failure(w, err)
		return
	}
	var response json.RawMessage
	var same bool
	err = tx.QueryRow(ctx, `SELECT response,kind=$3 AND request=$4::jsonb FROM learning_commands WHERE user_id=$1 AND idempotency_key=$2`, p.UserID, key, kind, raw).Scan(&response, &same)
	if err == nil {
		if !same {
			failure(w, ErrConflict)
			return
		}
		if err = tx.Commit(ctx); err != nil {
			failure(w, err)
			return
		}
		httpx.JSON(w, status, response)
		return
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		failure(w, err)
		return
	}
	value, err := run(ctx, tx, p)
	if err != nil {
		failure(w, err)
		return
	}
	response, err = json.Marshal(value)
	if err != nil {
		failure(w, err)
		return
	}
	if _, err = tx.Exec(ctx, `INSERT INTO learning_commands(user_id,idempotency_key,kind,request,response)VALUES($1,$2,$3,$4,$5)`, p.UserID, key, kind, raw, response); err != nil {
		failure(w, err)
		return
	}
	if err = tx.Commit(ctx); err != nil {
		failure(w, err)
		return
	}
	httpx.JSON(w, status, response)
}

type cursor struct {
	At       time.Time `json:"at"`
	ID       string    `json:"id"`
	Position float64   `json:"position"`
}

func page(w http.ResponseWriter, r *http.Request) (int, cursor, bool) {
	limit := 50
	if n := r.URL.Query().Get("limit"); n != "" {
		v, err := strconv.Atoi(n)
		if err != nil || v < 1 || v > 100 {
			httpx.Error(w, 400, "invalid_page", "limit must be 1..100")
			return 0, cursor{}, false
		}
		limit = v
	}
	mark := cursor{At: time.Date(1, 1, 1, 0, 0, 0, 0, time.UTC)}
	if v := r.URL.Query().Get("cursor"); v != "" {
		b, err := base64.RawURLEncoding.DecodeString(v)
		if err != nil || len(b) > 512 || json.Unmarshal(b, &mark) != nil || len(mark.ID) > 500 || !validPosition(mark.Position) {
			httpx.Error(w, 400, "invalid_page", "Invalid cursor")
			return 0, cursor{}, false
		}
	}
	return limit, mark, true
}
func next(mark cursor) string {
	b, _ := json.Marshal(mark)
	return base64.RawURLEncoding.EncodeToString(b)
}
func list(w http.ResponseWriter, key string, items any, next string) {
	httpx.JSON(w, 200, map[string]any{key: items, "next_cursor": next})
}
func sourceBounds(ctx context.Context, tx pgx.Tx, lesson string, position float64, chunk *string) error {
	if !validPosition(position) {
		return ErrInvalid
	}
	if lesson == "" {
		if chunk != nil || position != 0 {
			return ErrInvalid
		}
		return nil
	}
	var duration float64
	if err := tx.QueryRow(ctx, "SELECT duration_seconds FROM lessons WHERE id=$1", lesson).Scan(&duration); err != nil {
		return err
	}
	if duration > 0 && position > duration {
		return ErrInvalid
	}
	if chunk != nil {
		var ok bool
		err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM transcript_chunks WHERE id=$1 AND lesson_id=$2 AND start_seconds<=$3 AND end_seconds>=$3)`, *chunk, lesson, position).Scan(&ok)
		if err != nil {
			return err
		}
		if !ok {
			return ErrInvalid
		}
	}
	return nil
}
