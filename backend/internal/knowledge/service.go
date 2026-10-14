package knowledge

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strings"
	"time"

	"courseforge/backend/internal/httpx"
	"courseforge/backend/internal/identity"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrInvalid  = errors.New("invalid knowledge command")
	ErrDenied   = errors.New("knowledge access denied")
	ErrBusy     = errors.New("knowledge queue busy")
	ErrStale    = errors.New("knowledge job lease is no longer current")
	ErrConflict = errors.New("knowledge idempotency conflict")
)

type Service struct {
	Pool        *pgxpool.Pool
	WorkerToken string
	Lease       time.Duration
	Generator   Generator
	Embedder    TextEmbedder
	Qdrant      *qdrantClient
	FSRS        *FSRSScheduler
	Freshness   *FreshnessScanner
}

func New(pool *pgxpool.Pool) *Service {
	token := strings.TrimSpace(os.Getenv("CF_KNOWLEDGE_WORKER_TOKEN"))
	svc := &Service{
		Pool:        pool,
		WorkerToken: token,
		Lease:       2 * time.Minute,
		Qdrant:      newQdrantFromEnv(),
		FSRS:        NewFSRSScheduler(),
		Freshness:   NewFreshnessScanner(),
	}
	if EmbedderModeFromEnv() == "hash" {
		svc.Embedder = HashEmbedder{Dim: 384}
	}
	return svc
}

func (s *Service) Register(mux *http.ServeMux, auth *identity.Service) {
	mux.Handle("POST /api/v1/knowledge/jobs", auth.Require(http.HandlerFunc(s.enqueueHTTP)))
	mux.Handle("GET /api/v1/knowledge/jobs/{id}", auth.Require(http.HandlerFunc(s.getJobHTTP)))
	mux.Handle("GET /api/v1/knowledge/lessons/{id}", auth.Require(http.HandlerFunc(s.getLessonHTTP)))
	mux.Handle("GET /api/v1/knowledge/lessons/{id}/chapters", auth.Require(http.HandlerFunc(s.getChaptersHTTP)))
	mux.Handle("POST /api/v1/knowledge/lessons/{id}/ask", auth.Require(http.HandlerFunc(s.askHTTP)))
	mux.Handle("GET /api/v1/knowledge/lessons/{id}/concepts", auth.Require(http.HandlerFunc(s.getConceptsHTTP)))
	mux.Handle("GET /api/v1/knowledge/lessons/{id}/recall", auth.Require(http.HandlerFunc(s.getRecallHTTP)))
	mux.Handle("GET /api/v1/knowledge/lessons/{id}/summaries", auth.Require(http.HandlerFunc(s.getSummariesHTTP)))
	mux.Handle("GET /api/v1/knowledge/lessons/{id}/flashcards", auth.Require(http.HandlerFunc(s.getFlashcardsHTTP)))
	mux.Handle("GET /api/v1/knowledge/lessons/{id}/freshness", auth.Require(http.HandlerFunc(s.getFreshnessHTTP)))
	mux.Handle("POST /api/v1/knowledge/lessons/{id}/feedback", auth.Require(http.HandlerFunc(s.postFeedbackHTTP)))
	mux.Handle("GET /api/v1/knowledge/lessons/{id}/hotspots", auth.Require(http.HandlerFunc(s.getHotspotsHTTP)))
	mux.Handle("POST /api/v1/knowledge/lessons/{id}/hotspots/{hid}/annotations", auth.Require(http.HandlerFunc(s.postHotspotAnnotationHTTP)))
	mux.Handle("GET /api/v1/knowledge/review-queue", auth.Require(http.HandlerFunc(s.getReviewQueueHTTP)))
	mux.Handle("POST /api/v1/knowledge/review/{cardID}", auth.Require(http.HandlerFunc(s.postReviewHTTP)))

	mux.Handle("POST /api/v1/knowledge/worker/claim", s.requireWorker(s.claimHTTP))
	mux.Handle("POST /api/v1/knowledge/worker/jobs/{id}/heartbeat", s.requireWorker(s.heartbeatHTTP))
	mux.Handle("POST /api/v1/knowledge/worker/jobs/{id}/complete", s.requireWorker(s.completeHTTP))
	mux.Handle("POST /api/v1/knowledge/worker/jobs/{id}/fail", s.requireWorker(s.failHTTP))
	mux.Handle("PUT /api/v1/knowledge/worker/jobs/{id}/ingest", s.requireWorker(s.ingestHTTP))
	mux.Handle("PUT /api/v1/knowledge/worker/jobs/{id}/index", s.requireWorker(s.indexHTTP))
}

func (s *Service) requireWorker(next http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.WorkerToken == "" {
			httpx.Error(w, 503, "worker_token_unset", "Knowledge worker token is not configured")
			return
		}
		authz := r.Header.Get("Authorization")
		const prefix = "Bearer "
		if !strings.HasPrefix(authz, prefix) {
			httpx.Error(w, 401, "unauthenticated", "Worker bearer token required")
			return
		}
		got := strings.TrimSpace(strings.TrimPrefix(authz, prefix))
		if subtle.ConstantTimeCompare([]byte(got), []byte(s.WorkerToken)) != 1 {
			httpx.Error(w, 401, "unauthenticated", "Worker bearer token required")
			return
		}
		next(w, r)
	})
}

func newID(prefix string) (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return prefix + hex.EncodeToString(b), nil
}

func validObject(raw json.RawMessage, max int) bool {
	if len(raw) == 0 {
		raw = json.RawMessage(`{}`)
	}
	if len(raw) > max {
		return false
	}
	var v map[string]any
	return json.Unmarshal(raw, &v) == nil && v != nil
}

func failure(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrInvalid):
		httpx.Error(w, 422, "invalid_knowledge", "Invalid knowledge command")
	case errors.Is(err, ErrDenied):
		httpx.Error(w, 404, "knowledge_unavailable", "Knowledge or lesson unavailable")
	case errors.Is(err, ErrConflict):
		httpx.Error(w, 409, "idempotency_conflict", "Idempotency key belongs to another command")
	case errors.Is(err, ErrBusy):
		w.Header().Set("Retry-After", "5")
		httpx.Error(w, 503, "queue_busy", "No knowledge jobs available")
	case errors.Is(err, ErrStale):
		httpx.Error(w, 409, "stale_lease", "Knowledge job lease is no longer current")
	case errors.Is(err, pgx.ErrNoRows):
		httpx.Error(w, 404, "not_found", "Knowledge resource not found")
	default:
		httpx.Error(w, 503, "knowledge_unavailable", "Knowledge service unavailable")
	}
}

func lessonAccess(ctx context.Context, tx pgx.Tx, userID, lessonID, role string) error {
	var course string
	err := tx.QueryRow(ctx, `
		SELECT c.id FROM users u
		JOIN lessons l ON l.id=$2
		JOIN courses c ON c.id=l.course_id
		WHERE u.id=$1 AND u.verified AND NOT u.suspended
		  AND (u.role='admin' OR (c.published AND EXISTS(
		    SELECT 1 FROM enrollments e WHERE e.user_id=u.id AND e.course_id=c.id
		  )))
		FOR SHARE OF c,l`, userID, lessonID).Scan(&course)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrDenied
	}
	_ = role
	return err
}

func lessonExists(ctx context.Context, tx pgx.Tx, lessonID string) error {
	var id string
	err := tx.QueryRow(ctx, `SELECT id FROM lessons WHERE id=$1`, lessonID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrDenied
	}
	return err
}
