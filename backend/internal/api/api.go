package api

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"courseforge/backend/internal/access"
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
}

func New(pool *pgxpool.Pool, auth *identity.Service) *Server {
	s := &Server{Pool: pool, Identity: auth, Mux: http.NewServeMux(), ArtifactRoot: os.Getenv("CF_ARTIFACT_ROOT")}
	auth.RegisterRoutes(s.Mux)
	s.RegisterRoutes(s.Mux)
	s.RegisterCatalogRoutes(s.Mux)
	return s
}
func (s *Server) Handler() http.Handler { return s.Mux }
func (s *Server) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /health/live", func(w http.ResponseWriter, r *http.Request) { httpx.JSON(w, 200, map[string]string{"status": "ok"}) })
	mux.HandleFunc("GET /health/ready", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), time.Second)
		defer cancel()
		if err := s.Pool.Ping(ctx); err != nil {
			httpx.Error(w, 503, "database_unavailable", "Not ready")
			return
		}
		httpx.JSON(w, 200, map[string]string{"status": "ok"})
	})
	for route, h := range map[string]http.HandlerFunc{
		"GET /api/v1/courses": s.courses, "GET /api/v1/courses/{id}": s.course, "POST /api/v1/courses/{id}/enroll": s.enroll,
		"GET /api/v1/lessons/{id}": s.lesson, "GET /api/v1/progress": s.progressList, "GET /api/v1/lessons/{id}/progress": s.progressGet,
		"PUT /api/v1/lessons/{id}/progress": s.progressPut, "GET /api/v1/lessons/{id}/notes": s.notes, "POST /api/v1/lessons/{id}/notes": s.noteCreate,
		"PUT /api/v1/lessons/{id}/resume-point":       s.resumePut,
		"DELETE /api/v1/lessons/{id}/notes/{note_id}": s.noteDelete,
	} {
		mux.Handle(route, s.Identity.Require(h))
	}
}

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
	limit := 50
	if v := r.URL.Query().Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 100 {
			httpx.Error(w, 400, "invalid_page", "limit must be 1..100")
			return 0, "", false
		}
		limit = n
	}
	cursor := ""
	if c := r.URL.Query().Get("cursor"); c != "" {
		b, err := base64.RawURLEncoding.DecodeString(c)
		if err != nil || len(b) > 512 {
			httpx.Error(w, 400, "invalid_cursor", "Invalid page cursor")
			return 0, "", false
		}
		cursor = string(b)
	}
	return limit, cursor, true
}
func nextCursor(id string) string { return base64.RawURLEncoding.EncodeToString([]byte(id)) }
func (s *Server) databaseError(w http.ResponseWriter, err error) {
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(w, 404, "not_found", "Resource not found")
		return
	}
	httpx.Error(w, 503, "database_unavailable", "Please retry shortly")
}
func (s *Server) courses(w http.ResponseWriter, r *http.Request) {
	p, _ := identity.FromContext(r.Context())
	limit, cursor, ok := pageArgs(w, r)
	if !ok {
		return
	}
	search := strings.TrimSpace(r.URL.Query().Get("q"))
	if len(search) > 100 {
		httpx.Error(w, 400, "invalid_search", "Search is too long")
		return
	}
	enrolledOnly := r.URL.Query().Get("enrolled") == "true"
	rows, err := s.Pool.Query(r.Context(), `SELECT c.id,c.title,c.description,c.published,EXISTS(SELECT 1 FROM enrollments e WHERE e.user_id=$1 AND e.course_id=c.id),c.version,c.instructor,c.category,c.tags,c.slug FROM courses c WHERE ($2='admin' OR (c.published AND (NOT $6 OR EXISTS(SELECT 1 FROM enrollments e WHERE e.user_id=$1 AND e.course_id=c.id)))) AND c.id>$3 AND ($4='' OR c.title ILIKE '%' || $4 || '%' ESCAPE '') ORDER BY c.id LIMIT $5`, p.UserID, p.Role, cursor, search, limit+1, enrolledOnly)
	if err != nil {
		s.databaseError(w, err)
		return
	}
	defer rows.Close()
	items := make([]Course, 0, limit+1)
	for rows.Next() {
		var c Course
		if err = rows.Scan(&c.ID, &c.Title, &c.Description, &c.Published, &c.Enrolled, &c.Version, &c.Instructor, &c.Category, &c.Tags, &c.Slug); err != nil {
			s.databaseError(w, err)
			return
		}
		items = append(items, c)
	}
	if err = rows.Err(); err != nil {
		s.databaseError(w, err)
		return
	}
	next := ""
	if len(items) > limit {
		items = items[:limit]
		next = nextCursor(items[len(items)-1].ID)
	}
	httpx.JSON(w, 200, paginated("courses", items, next))
}
func (s *Server) course(w http.ResponseWriter, r *http.Request) {
	p, _ := identity.FromContext(r.Context())
	var c Course
	err := s.Pool.QueryRow(r.Context(), `SELECT c.id,c.title,c.description,c.published,EXISTS(SELECT 1 FROM enrollments e WHERE e.user_id=$1 AND e.course_id=c.id),c.version,c.instructor,c.category,c.tags,c.slug FROM courses c WHERE (c.id=$2 OR c.slug=$2) AND ($3='admin' OR c.published)`, p.UserID, r.PathValue("id"), p.Role).Scan(&c.ID, &c.Title, &c.Description, &c.Published, &c.Enrolled, &c.Version, &c.Instructor, &c.Category, &c.Tags, &c.Slug)
	if err != nil {
		s.databaseError(w, err)
		return
	}
	lessons := make([]Lesson, 0)
	if c.Enrolled || p.Role == "admin" {
		limit, cursor, ok := pageArgs(w, r)
		if !ok {
			return
		}
		mark := lessonCursor{Flow: -1, Order: math.MinInt32}
		if cursor != "" {
			if err := json.Unmarshal([]byte(cursor), &mark); err != nil || len(mark.ID) > 512 {
				httpx.Error(w, 400, "invalid_cursor", "Invalid lesson cursor")
				return
			}
		}
		rows, err := s.Pool.Query(r.Context(), "SELECT id,course_id,title,sort_order,duration_seconds,section_title,flow_order FROM lessons WHERE course_id=$1 AND (flow_order,sort_order,id)>($2,$3,$4) ORDER BY flow_order,sort_order,id LIMIT $5", c.ID, mark.Flow, mark.Order, mark.ID, limit+1)
		if err != nil {
			s.databaseError(w, err)
			return
		}
		defer rows.Close()
		for rows.Next() {
			var l Lesson
			if err = rows.Scan(&l.ID, &l.CourseID, &l.Title, &l.SortOrder, &l.Duration, &l.SectionTitle, &l.FlowOrder); err != nil {
				s.databaseError(w, err)
				return
			}
			lessons = append(lessons, l)
		}
		if err = rows.Err(); err != nil {
			s.databaseError(w, err)
			return
		}
		next := ""
		if len(lessons) > limit {
			lessons = lessons[:limit]
			last := lessons[len(lessons)-1]
			mark, _ := json.Marshal(lessonCursor{Flow: last.FlowOrder, Order: last.SortOrder, ID: last.ID})
			next = nextCursor(string(mark))
		}
		httpx.JSON(w, 200, map[string]any{"course": c, "lessons": lessons, "next_cursor": next})
		return
	}
	httpx.JSON(w, 200, map[string]any{"course": c, "lessons": lessons, "next_cursor": ""})
}

type lessonCursor struct {
	Flow  float64 `json:"flow"`
	Order int     `json:"order"`
	ID    string  `json:"id"`
}

func (s *Server) enroll(w http.ResponseWriter, r *http.Request) {
	p, _ := identity.FromContext(r.Context())
	tx, err := s.Pool.Begin(r.Context())
	if err != nil {
		s.databaseError(w, err)
		return
	}
	defer tx.Rollback(context.Background())
	if err = identity.LockPrincipal(r.Context(), tx, p); err != nil {
		httpx.Error(w, 401, "unauthenticated", "Session unavailable")
		return
	}
	var id string
	err = tx.QueryRow(r.Context(), "SELECT id FROM courses WHERE id=$1 AND published FOR SHARE", r.PathValue("id")).Scan(&id)
	if err != nil {
		s.databaseError(w, err)
		return
	}
	if _, err = tx.Exec(r.Context(), "INSERT INTO enrollments(user_id,course_id) VALUES($1,$2) ON CONFLICT DO NOTHING", p.UserID, id); err != nil {
		s.databaseError(w, err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		s.databaseError(w, err)
		return
	}
	httpx.JSON(w, 201, map[string]bool{"enrolled": true})
}
func (s *Server) checkLesson(w http.ResponseWriter, r *http.Request) bool {
	p, _ := identity.FromContext(r.Context())
	ok, err := access.CanLesson(r.Context(), s.Pool, p.UserID, p.Role, r.PathValue("id"))
	if err != nil {
		s.databaseError(w, err)
		return false
	}
	if !ok {
		httpx.Error(w, 404, "not_found", "Lesson not found")
		return false
	}
	return true
}
func (s *Server) lesson(w http.ResponseWriter, r *http.Request) {
	if !s.checkLesson(w, r) {
		return
	}
	var l Lesson
	err := s.Pool.QueryRow(r.Context(), "SELECT id,course_id,title,sort_order,duration_seconds,section_title,flow_order FROM lessons WHERE id=$1", r.PathValue("id")).Scan(&l.ID, &l.CourseID, &l.Title, &l.SortOrder, &l.Duration, &l.SectionTitle, &l.FlowOrder)
	if err != nil {
		s.databaseError(w, err)
		return
	}
	p, _ := identity.FromContext(r.Context())
	v := Progress{LessonID: l.ID}
	err = s.Pool.QueryRow(r.Context(), "SELECT percent,position,completed,explicit_completed,revision,updated_at FROM progress WHERE user_id=$1 AND lesson_id=$2", p.UserID, l.ID).Scan(&v.Percent, &v.Position, &v.Completed, &v.ExplicitCompleted, &v.Revision, &v.UpdatedAt)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		s.databaseError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"lesson": l, "progress": v})
}
func (s *Server) progressGet(w http.ResponseWriter, r *http.Request) {
	if !s.checkLesson(w, r) {
		return
	}
	p, _ := identity.FromContext(r.Context())
	v := Progress{LessonID: r.PathValue("id")}
	err := s.Pool.QueryRow(r.Context(), "SELECT percent,position,completed,explicit_completed,revision,updated_at FROM progress WHERE user_id=$1 AND lesson_id=$2", p.UserID, v.LessonID).Scan(&v.Percent, &v.Position, &v.Completed, &v.ExplicitCompleted, &v.Revision, &v.UpdatedAt)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		s.databaseError(w, err)
		return
	}
	httpx.JSON(w, 200, v)
}
func (s *Server) progressList(w http.ResponseWriter, r *http.Request) {
	p, _ := identity.FromContext(r.Context())
	limit, cursor, ok := pageArgs(w, r)
	if !ok {
		return
	}
	rows, err := s.Pool.Query(r.Context(), `SELECT l.id,COALESCE(p.percent,0),COALESCE(p.position,0),COALESCE(p.completed,false),COALESCE(p.explicit_completed,false),COALESCE(p.revision,0),p.updated_at FROM lessons l JOIN courses c ON c.id=l.course_id LEFT JOIN progress p ON p.lesson_id=l.id AND p.user_id=$1 WHERE l.id>$2 AND ($3='admin' OR (c.published AND EXISTS(SELECT 1 FROM enrollments e WHERE e.user_id=$1 AND e.course_id=c.id))) ORDER BY l.id LIMIT $4`, p.UserID, cursor, p.Role, limit+1)
	if err != nil {
		s.databaseError(w, err)
		return
	}
	defer rows.Close()
	items := make([]Progress, 0, limit+1)
	for rows.Next() {
		var v Progress
		if err = rows.Scan(&v.LessonID, &v.Percent, &v.Position, &v.Completed, &v.ExplicitCompleted, &v.Revision, &v.UpdatedAt); err != nil {
			s.databaseError(w, err)
			return
		}
		items = append(items, v)
	}
	if err = rows.Err(); err != nil {
		s.databaseError(w, err)
		return
	}
	next := ""
	if len(items) > limit {
		items = items[:limit]
		next = nextCursor(items[len(items)-1].LessonID)
	}
	httpx.JSON(w, 200, paginated("progress", items, next))
}

type progressCommand struct {
	Percent          *int     `json:"percent"`
	Position         *float64 `json:"position"`
	ExpectedRevision *int64   `json:"expected_revision"`
}

func (s *Server) resumePut(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Position *float64 `json:"position"`
	}
	if !httpx.Decode(w, r, &body) {
		return
	}
	s.saveProgress(w, r, progressCommand{Position: body.Position})
}

func (s *Server) progressPut(w http.ResponseWriter, r *http.Request) {
	var b progressCommand
	if !httpx.Decode(w, r, &b) {
		return
	}
	s.saveProgress(w, r, b)
}

func (s *Server) saveProgress(w http.ResponseWriter, r *http.Request, b progressCommand) {
	p, _ := identity.FromContext(r.Context())
	if (b.Percent != nil && (*b.Percent < 0 || *b.Percent > 100)) || b.Position == nil || math.IsNaN(*b.Position) || math.IsInf(*b.Position, 0) || *b.Position < 0 || *b.Position >= 1e9 {
		httpx.Error(w, 422, "invalid_progress", "Invalid progress")
		return
	}
	tx, err := s.Pool.Begin(r.Context())
	if err != nil {
		s.databaseError(w, err)
		return
	}
	defer tx.Rollback(context.Background())
	if err = access.LessonWrite(r.Context(), tx, p, r.PathValue("id")); err != nil {
		s.databaseError(w, err)
		return
	}
	var duration float64
	if err = tx.QueryRow(r.Context(), "SELECT duration_seconds FROM lessons WHERE id=$1", r.PathValue("id")).Scan(&duration); err != nil {
		s.databaseError(w, err)
		return
	}
	if duration > 0 && *b.Position > duration {
		httpx.Error(w, 422, "invalid_progress", "Position exceeds the known lesson duration")
		return
	}
	v := Progress{LessonID: r.PathValue("id")}
	expected := int64(-1)
	if b.ExpectedRevision != nil {
		expected = *b.ExpectedRevision
		if expected < 0 {
			httpx.Error(w, 422, "invalid_revision", "Invalid revision")
			return
		}
	}
	query := `INSERT INTO progress(user_id,lesson_id,percent,position,completed,explicit_completed) VALUES($1,$2,COALESCE($3::integer,0),$4,COALESCE($3=100,false),COALESCE($3=100,false)) ON CONFLICT(user_id,lesson_id) DO UPDATE SET percent=COALESCE($3,progress.percent),position=excluded.position,completed=CASE WHEN $3 IS NULL THEN progress.completed ELSE excluded.completed END,explicit_completed=CASE WHEN $3 IS NULL THEN progress.explicit_completed ELSE excluded.explicit_completed END,revision=progress.revision+1,updated_at=now() WHERE $5=-1 RETURNING percent,position,completed,explicit_completed,revision,updated_at`
	if expected > 0 {
		query = `UPDATE progress SET percent=COALESCE($3::integer,percent),position=$4,completed=CASE WHEN $3 IS NULL THEN completed ELSE $3=100 END,explicit_completed=CASE WHEN $3 IS NULL THEN explicit_completed ELSE $3=100 END,revision=revision+1,updated_at=now() WHERE user_id=$1 AND lesson_id=$2 AND revision=$5 RETURNING percent,position,completed,explicit_completed,revision,updated_at`
	}
	err = tx.QueryRow(r.Context(), query, p.UserID, v.LessonID, b.Percent, b.Position, expected).Scan(&v.Percent, &v.Position, &v.Completed, &v.ExplicitCompleted, &v.Revision, &v.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(w, 409, "stale_progress", "Progress changed; read before retrying")
		return
	}
	if err != nil {
		s.databaseError(w, err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		s.databaseError(w, err)
		return
	}
	httpx.JSON(w, 200, v)
}
func (s *Server) notes(w http.ResponseWriter, r *http.Request) {
	if !s.checkLesson(w, r) {
		return
	}
	p, _ := identity.FromContext(r.Context())
	limit, cursor, ok := pageArgs(w, r)
	if !ok {
		return
	}
	rows, err := s.Pool.Query(r.Context(), "SELECT id,lesson_id,position,content,created_at FROM notes WHERE user_id=$1 AND lesson_id=$2 AND id>$3 ORDER BY id LIMIT $4", p.UserID, r.PathValue("id"), cursor, limit+1)
	if err != nil {
		s.databaseError(w, err)
		return
	}
	defer rows.Close()
	items := make([]Note, 0, limit+1)
	for rows.Next() {
		var n Note
		if err = rows.Scan(&n.ID, &n.LessonID, &n.Position, &n.Content, &n.CreatedAt); err != nil {
			s.databaseError(w, err)
			return
		}
		items = append(items, n)
	}
	if err = rows.Err(); err != nil {
		s.databaseError(w, err)
		return
	}
	next := ""
	if len(items) > limit {
		items = items[:limit]
		next = nextCursor(items[len(items)-1].ID)
	}
	httpx.JSON(w, 200, paginated("notes", items, next))
}
func (s *Server) noteCreate(w http.ResponseWriter, r *http.Request) {
	p, _ := identity.FromContext(r.Context())
	var b struct {
		Position float64 `json:"position"`
		Content  string  `json:"content"`
	}
	if !httpx.Decode(w, r, &b) {
		return
	}
	b.Content = strings.TrimSpace(b.Content)
	key := r.Header.Get("Idempotency-Key")
	if len(key) < 1 || len(key) > 128 || len([]rune(b.Content)) < 1 || len([]rune(b.Content)) > 3000 || b.Position < 0 || b.Position >= 1e9 || math.IsNaN(b.Position) || math.IsInf(b.Position, 0) {
		httpx.Error(w, 422, "invalid_note", "Provide valid content, position and Idempotency-Key")
		return
	}
	tx, err := s.Pool.Begin(r.Context())
	if err != nil {
		s.databaseError(w, err)
		return
	}
	defer tx.Rollback(context.Background())
	if err = access.LessonWrite(r.Context(), tx, p, r.PathValue("id")); err != nil {
		s.databaseError(w, err)
		return
	}
	n := Note{ID: "note_" + identity.RandomToken(), LessonID: r.PathValue("id"), Position: b.Position, Content: b.Content}
	err = tx.QueryRow(r.Context(), `INSERT INTO notes(id,user_id,lesson_id,position,content,idempotency_key) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(user_id,idempotency_key) DO UPDATE SET id=notes.id WHERE notes.lesson_id=excluded.lesson_id AND notes.position=excluded.position AND notes.content=excluded.content RETURNING id,lesson_id,position,content,created_at`, n.ID, p.UserID, n.LessonID, n.Position, n.Content, key).Scan(&n.ID, &n.LessonID, &n.Position, &n.Content, &n.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(w, 409, "idempotency_conflict", "Idempotency-Key already used for different content")
		return
	}
	if err != nil {
		s.databaseError(w, err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		s.databaseError(w, err)
		return
	}
	httpx.JSON(w, 201, n)
}
func (s *Server) noteDelete(w http.ResponseWriter, r *http.Request) {
	p, _ := identity.FromContext(r.Context())
	tx, err := s.Pool.Begin(r.Context())
	if err != nil {
		s.databaseError(w, err)
		return
	}
	defer tx.Rollback(context.Background())
	if err = access.LessonWrite(r.Context(), tx, p, r.PathValue("id")); err != nil {
		s.databaseError(w, err)
		return
	}
	tag, err := tx.Exec(r.Context(), "DELETE FROM notes WHERE id=$1 AND user_id=$2 AND lesson_id=$3", r.PathValue("note_id"), p.UserID, r.PathValue("id"))
	if err != nil {
		s.databaseError(w, err)
		return
	}
	if tag.RowsAffected() == 0 {
		s.databaseError(w, pgx.ErrNoRows)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		s.databaseError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]bool{"ok": true})
}

// String is safe for logging: no database URLs, hashes, cookies or provider URLs.
func (s *Server) String() string {
	return fmt.Sprintf("CourseForge API (pool max=%d)", s.Pool.Config().MaxConns)
}
