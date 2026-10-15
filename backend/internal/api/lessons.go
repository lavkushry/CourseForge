package api

import (
	"errors"
	"net/http"

	"courseforge/backend/internal/access"
	"courseforge/backend/internal/httpx"
	"courseforge/backend/internal/identity"

	"github.com/jackc/pgx/v5"
)

func (s *Server) RegisterLessonRoutes(mux *http.ServeMux) {
	mux.Handle("GET /api/v1/lessons/{id}", s.Identity.Require(http.HandlerFunc(s.lesson)))
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
