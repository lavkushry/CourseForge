package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"sync"
	"time"

	"courseforge/backend/internal/cache"
	"courseforge/backend/internal/httpx"
	"courseforge/backend/internal/identity"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/sync/singleflight"
)

const publicCacheControl = "public, max-age=30, stale-while-revalidate=60"

type Server struct {
	Pool           *pgxpool.Pool
	Identity       *identity.Service
	Mux            *http.ServeMux
	ArtifactRoot   string
	MaterialLoader MaterialLoader
	Cache          cache.Cache
	CacheTTL       time.Duration

	flights  singleflight.Group
	readyMu  sync.Mutex
	readyAt  time.Time
	readyErr error
}

func New(pool *pgxpool.Pool, auth *identity.Service) *Server {
	s := &Server{Pool: pool, Identity: auth, Mux: http.NewServeMux(), ArtifactRoot: os.Getenv("CF_ARTIFACT_ROOT")}
	auth.RegisterRoutes(s.Mux)
	s.RegisterHealthRoutes(s.Mux)
	s.RegisterCourseRoutes(s.Mux)
	s.RegisterLessonRoutes(s.Mux)
	s.RegisterProgressRoutes(s.Mux)
	s.RegisterNotesRoutes(s.Mux)
	s.RegisterCatalogRoutes(s.Mux)
	return s
}
func (s *Server) Handler() http.Handler { return s.Mux }

type Course struct {
	ID          string   `json:"id"`
	Title       string   `json:"title"`
	Description string   `json:"description"`
	Published   bool     `json:"published"`
	Enrolled    bool     `json:"enrolled"`
	Version     int64    `json:"version"`
	Instructor  string   `json:"instructor"`
	Category    string   `json:"category"`
	Tags        []string `json:"tags"`
	Slug        *string  `json:"slug"`
}
type Lesson struct {
	ID           string  `json:"id"`
	CourseID     string  `json:"course_id"`
	Title        string  `json:"title"`
	SortOrder    int     `json:"sort_order"`
	Duration     float64 `json:"duration_seconds"`
	SectionTitle string  `json:"section_title"`
	FlowOrder    float64 `json:"flow_order"`
	Completed    bool    `json:"completed,omitempty"`
}
type Progress struct {
	LessonID          string     `json:"lesson_id"`
	Percent           int        `json:"percent"`
	Position          float64    `json:"position"`
	Completed         bool       `json:"completed"`
	ExplicitCompleted bool       `json:"explicit_completed"`
	Revision          int64      `json:"revision"`
	UpdatedAt         *time.Time `json:"updated_at"`
}
type Note struct {
	ID        string    `json:"id"`
	LessonID  string    `json:"lesson_id"`
	Position  float64   `json:"position"`
	Content   string    `json:"content"`
	CreatedAt time.Time `json:"created_at"`
}

func paginated[T any](key string, items []T, next string) map[string]any {
	return map[string]any{key: items, "items": items, "next_cursor": next}
}
func pageArgs(w http.ResponseWriter, r *http.Request) (int, string, bool) {
	page, ok := httpx.ParsePage(w, r)
	return page.Limit, page.Cursor, ok
}
func nextCursor(id string) string { return httpx.EncodeCursor(id) }

func (s *Server) cacheGet(ctx context.Context, key string) ([]byte, bool) {
	if s.Cache == nil || s.CacheTTL <= 0 || key == "" {
		return nil, false
	}
	b, ok, err := s.Cache.Get(ctx, key)
	if err != nil || !ok {
		return nil, false
	}
	return b, true
}

func etagOf(body []byte) string {
	sum := sha256.Sum256(body)
	return `"` + hex.EncodeToString(sum[:]) + `"`
}

func cacheQueryKey(r *http.Request) string {
	if r == nil || r.URL == nil {
		return ""
	}
	return r.URL.Query().Encode()
}

// writeJSONBytes serves pre-encoded JSON. Anonymous public catalog/feed responses
// get ETag + Cache-Control; personalized responses stay no-store.
func (s *Server) writeJSONBytes(w http.ResponseWriter, r *http.Request, status int, body []byte, public bool, xCache string) {
	if public {
		etag := etagOf(body)
		w.Header().Set("ETag", etag)
		w.Header().Set("Cache-Control", publicCacheControl)
		// Auth is cookie-based: the anonymous variant must never be reused for a signed-in user.
		w.Header().Add("Vary", "Cookie")
		if xCache != "" {
			w.Header().Set("X-Cache", xCache)
		}
		if status == http.StatusOK {
			if inm := r.Header.Get("If-None-Match"); inm != "" && inm == etag {
				w.WriteHeader(http.StatusNotModified)
				return
			}
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write(body)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	if xCache != "" {
		w.Header().Set("X-Cache", xCache)
	}
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

// cachedJSON returns pre-encoded JSON for key, collapsing concurrent misses with singleflight.
func (s *Server) cachedJSON(ctx context.Context, key string, build func(context.Context) (any, error)) (body []byte, hit bool, err error) {
	if b, ok := s.cacheGet(ctx, key); ok {
		return b, true, nil
	}
	if s.Cache == nil || s.CacheTTL <= 0 || key == "" {
		payload, err := build(ctx)
		if err != nil {
			return nil, false, err
		}
		b, err := json.Marshal(payload)
		return b, false, err
	}
	v, err, _ := s.flights.Do(key, func() (any, error) {
		if b, ok := s.cacheGet(ctx, key); ok {
			return b, nil
		}
		buildCtx := context.WithoutCancel(ctx)
		payload, err := build(buildCtx)
		if err != nil {
			return nil, err
		}
		b, err := json.Marshal(payload)
		if err != nil {
			return nil, err
		}
		_ = s.Cache.Set(buildCtx, key, b, s.CacheTTL)
		return b, nil
	})
	if err != nil {
		return nil, false, err
	}
	return v.([]byte), false, nil
}

func (s *Server) serveCachedJSON(w http.ResponseWriter, r *http.Request, key string, public bool, build func(context.Context) (any, error)) {
	body, hit, err := s.cachedJSON(r.Context(), key, build)
	if err != nil {
		s.databaseError(w, err)
		return
	}
	xCache := "MISS"
	if hit {
		xCache = "HIT"
	}
	s.writeJSONBytes(w, r, http.StatusOK, body, public, xCache)
}

func (s *Server) invalidateCatalog(r *http.Request) {
	if s.Cache == nil {
		return
	}
	_ = s.Cache.DeletePrefix(r.Context(), "catalog")
}

func (s *Server) dbReady(ctx context.Context) error {
	s.readyMu.Lock()
	fresh := !s.readyAt.IsZero() && time.Since(s.readyAt) < time.Second
	cached := s.readyErr
	s.readyMu.Unlock()
	if fresh {
		return cached
	}
	// Collapse concurrent pings instead of serialising callers behind a held lock.
	_, err, _ := s.flights.Do("health/ready", func() (any, error) {
		err := s.Pool.Ping(ctx)
		s.readyMu.Lock()
		s.readyAt, s.readyErr = time.Now(), err
		s.readyMu.Unlock()
		return nil, err
	})
	return err
}

func (s *Server) databaseError(w http.ResponseWriter, err error) {
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(w, 404, "not_found", "Resource not found")
		return
	}
	httpx.Error(w, 503, "database_unavailable", "Please retry shortly")
}

// String is safe for logging: no database URLs, hashes, cookies or provider URLs.
func (s *Server) String() string {
	return fmt.Sprintf("CourseForge API (pool max=%d)", s.Pool.Config().MaxConns)
}
