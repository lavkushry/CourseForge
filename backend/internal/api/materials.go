package api

import (
	"context"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"courseforge/backend/internal/httpx"
	"courseforge/backend/internal/identity"

	"github.com/jackc/pgx/v5"
)

// MaterialLoader may stage a provider document and return a bounded seekable
// object. URLs/account credentials never enter public Material metadata.
type MaterialSource struct{ ID, ClaimName, ClaimID string }
type ReadSeekCloser interface {
	io.Reader
	io.Seeker
	io.Closer
}
type MaterialLoader interface {
	Open(context.Context, MaterialSource) (ReadSeekCloser, time.Time, error)
}
type Material struct {
	ID          string  `json:"id"`
	CourseID    string  `json:"course_id"`
	LessonID    *string `json:"lesson_id"`
	Filename    string  `json:"filename"`
	Title       string  `json:"title"`
	Type        string  `json:"material_type"`
	Scope       string  `json:"scope"`
	Section     string  `json:"section_title"`
	Position    float64 `json:"position"`
	Version     int64   `json:"version"`
	DownloadURL string  `json:"download_url"`
}

const materialColumns = `m.id,m.course_id,m.lesson_id,m.filename,m.title,m.material_type,m.scope,m.section_title,m.position,m.version`

func scanMaterial(row pgx.Row, m *Material) error {
	err := row.Scan(&m.ID, &m.CourseID, &m.LessonID, &m.Filename, &m.Title, &m.Type, &m.Scope, &m.Section, &m.Position, &m.Version)
	m.DownloadURL = "/api/v1/materials/" + url.PathEscape(m.ID) + "/download"
	return err
}

const allowedCourse = `($2='admin' OR (c.published AND EXISTS(SELECT 1 FROM enrollments e WHERE e.user_id=$1 AND e.course_id=c.id)))`

func (s *Server) materials(w http.ResponseWriter, r *http.Request) {
	p, _ := identity.FromContext(r.Context())
	limit, cursor, ok := pageArgs(w, r)
	if !ok {
		return
	}
	rows, err := s.Pool.Query(r.Context(), "SELECT "+materialColumns+" FROM materials m JOIN courses c ON c.id=m.course_id WHERE "+allowedCourse+" AND NOT m.removed AND m.id>$3 AND ($4='' OR m.course_id=$4) ORDER BY m.id LIMIT $5", p.UserID, p.Role, cursor, r.URL.Query().Get("course"), limit+1)
	if err != nil {
		s.databaseError(w, err)
		return
	}
	defer rows.Close()
	items := make([]Material, 0, limit+1)
	for rows.Next() {
		var m Material
		if err = scanMaterial(rows, &m); err != nil {
			s.databaseError(w, err)
			return
		}
		items = append(items, m)
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
	httpx.JSON(w, 200, paginated("materials", items, next))
}
func (s *Server) materialDownload(w http.ResponseWriter, r *http.Request) {
	p, _ := identity.FromContext(r.Context())
	var path, name, claimName, claimID string
	var updated time.Time
	err := s.Pool.QueryRow(r.Context(), "SELECT m.relative_path,m.filename,m.claim_name,m.claim_id,m.updated_at FROM materials m JOIN courses c ON c.id=m.course_id WHERE "+allowedCourse+" AND m.id=$3 AND NOT m.removed", p.UserID, p.Role, r.PathValue("id")).Scan(&path, &name, &claimName, &claimID, &updated)
	if err != nil {
		s.databaseError(w, err)
		return
	}
	var file ReadSeekCloser
	if path != "" && s.ArtifactRoot != "" {
		root, err := os.OpenRoot(s.ArtifactRoot)
		if err != nil {
			httpx.Error(w, 503, "artifact_unavailable", "Material storage unavailable")
			return
		}
		defer root.Close()
		f, err := root.Open(path)
		if err != nil {
			httpx.Error(w, 404, "not_found", "Material file not found")
			return
		}
		info, err := f.Stat()
		if err != nil || !info.Mode().IsRegular() {
			f.Close()
			httpx.Error(w, 404, "not_found", "Material file not found")
			return
		}
		file = f
		updated = info.ModTime()
	} else if s.MaterialLoader != nil && claimName != "" && claimID != "" {
		var err error
		file, updated, err = s.MaterialLoader.Open(r.Context(), MaterialSource{ID: r.PathValue("id"), ClaimName: claimName, ClaimID: claimID})
		if err != nil {
			httpx.Error(w, 503, "provider_unavailable", "Material delivery unavailable")
			return
		}
	} else {
		httpx.Error(w, 503, "artifact_unavailable", "Material source is not prepared")
		return
	}
	defer file.Close()
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": name}))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeContent(w, r, name, updated, file)
}
func (s *Server) cover(w http.ResponseWriter, r *http.Request) {
	p, ok := s.optionalPrincipal(w, r)
	if !ok {
		return
	}
	var path string
	err := s.Pool.QueryRow(r.Context(), "SELECT cover_relative_path FROM courses WHERE id=$1 AND (published OR $2='admin')", r.PathValue("id"), p.Role).Scan(&path)
	if err != nil {
		s.databaseError(w, err)
		return
	}
	if path == "" || s.ArtifactRoot == "" {
		httpx.Error(w, 404, "not_found", "Cover not found")
		return
	}
	root, err := os.OpenRoot(s.ArtifactRoot)
	if err != nil {
		httpx.Error(w, 503, "artifact_unavailable", "Artwork storage unavailable")
		return
	}
	defer root.Close()
	f, err := root.Open(path)
	if err != nil {
		httpx.Error(w, 404, "not_found", "Cover not found")
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		httpx.Error(w, 404, "not_found", "Cover not found")
		return
	}
	ext := strings.ToLower(filepath.Ext(path))
	if ext != ".jpg" && ext != ".jpeg" && ext != ".png" && ext != ".webp" {
		httpx.Error(w, 404, "not_found", "Cover not found")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	http.ServeContent(w, r, info.Name(), info.ModTime(), f)
}
func (s *Server) materialUpdate(w http.ResponseWriter, r *http.Request) {
	p, ok := s.requireAdmin(w, r)
	if !ok {
		return
	}
	var b struct {
		Title           string  `json:"title"`
		Type            string  `json:"material_type"`
		LessonID        *string `json:"lesson_id"`
		Scope           string  `json:"scope"`
		Section         string  `json:"section_title"`
		Position        float64 `json:"position"`
		ExpectedVersion int64   `json:"expected_version"`
	}
	if !httpx.Decode(w, r, &b) {
		return
	}
	if strings.TrimSpace(b.Title) == "" || len([]rune(b.Title)) > 300 || len([]rune(b.Type)) > 80 || len([]rune(b.Section)) > 200 || b.Position < 0 || b.Position >= 1e9 || b.ExpectedVersion < 1 || (b.Scope != "course" && b.Scope != "section" && b.Scope != "lesson") || (b.Scope == "lesson" && b.LessonID == nil) {
		httpx.Error(w, 422, "invalid_material", "Invalid material metadata")
		return
	}
	tx, err := s.Pool.Begin(r.Context())
	if err != nil {
		s.databaseError(w, err)
		return
	}
	defer tx.Rollback(context.Background())
	if err = identity.LockPrincipal(r.Context(), tx, p); err != nil {
		s.databaseError(w, err)
		return
	}
	var courseID string
	if err = tx.QueryRow(r.Context(), "SELECT course_id FROM materials WHERE id=$1 FOR UPDATE", r.PathValue("id")).Scan(&courseID); err != nil {
		s.databaseError(w, err)
		return
	}
	if b.LessonID != nil {
		var id string
		if err = tx.QueryRow(r.Context(), "SELECT id FROM lessons WHERE id=$1 AND course_id=$2 FOR SHARE", *b.LessonID, courseID).Scan(&id); err != nil {
			s.databaseError(w, err)
			return
		}
	}
	var version int64
	err = tx.QueryRow(r.Context(), "UPDATE materials SET title=$2,material_type=$3,lesson_id=$4,scope=$5,section_title=$6,position=$7,version=version+1,updated_at=now() WHERE id=$1 AND version=$8 RETURNING version", r.PathValue("id"), strings.TrimSpace(b.Title), b.Type, b.LessonID, b.Scope, b.Section, b.Position, b.ExpectedVersion).Scan(&version)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(w, 409, "stale_material", "Material changed")
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
	s.invalidateCatalog(r)
	httpx.JSON(w, 200, map[string]any{"version": version})
}
func (s *Server) materialRemove(w http.ResponseWriter, r *http.Request) {
	p, ok := s.requireAdmin(w, r)
	if !ok {
		return
	}
	tx, err := s.Pool.Begin(r.Context())
	if err != nil {
		s.databaseError(w, err)
		return
	}
	defer tx.Rollback(context.Background())
	if err = identity.LockPrincipal(r.Context(), tx, p); err != nil {
		s.databaseError(w, err)
		return
	}
	tag, err := tx.Exec(r.Context(), "UPDATE materials SET removed=true,version=version+1,updated_at=now() WHERE id=$1 AND NOT removed", r.PathValue("id"))
	if err != nil {
		s.databaseError(w, err)
		return
	}
	if tag.RowsAffected() != 1 {
		s.databaseError(w, pgx.ErrNoRows)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		s.databaseError(w, err)
		return
	}
	s.invalidateCatalog(r)
	httpx.JSON(w, 200, map[string]bool{"ok": true})
}
