package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"time"

	"courseforge/backend/internal/cache"
	"courseforge/backend/internal/httpx"
	"courseforge/backend/internal/identity"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Server struct {
	Pool           *pgxpool.Pool
	Identity       *identity.Service
	Mux            *http.ServeMux
	ArtifactRoot   string
	MaterialLoader MaterialLoader
	Cache          cache.Cache
	CacheTTL       time.Duration
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

func (s *Server) cacheGet(r *http.Request, key string) ([]byte, bool) {
	if s.Cache == nil || s.CacheTTL <= 0 || key == "" {
		return nil, false
	}
	b, ok, err := s.Cache.Get(r.Context(), key)
	if err != nil || !ok {
		return nil, false
	}
	return b, true
}

func (s *Server) cacheSet(r *http.Request, key string, payload any) {
	if s.Cache == nil || s.CacheTTL <= 0 || key == "" {
		return
	}
	b, err := json.Marshal(payload)
	if err != nil {
		return
	}
	_ = s.Cache.Set(r.Context(), key, b, s.CacheTTL)
}

func (s *Server) invalidateCatalog(r *http.Request) {
	if s.Cache == nil {
		return
	}
	_ = s.Cache.DeletePrefix(r.Context(), "catalog")
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
