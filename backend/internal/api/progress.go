package api

import (
	"context"
	"errors"
	"math"
	"net/http"

	"courseforge/backend/internal/access"
	"courseforge/backend/internal/httpx"
	"courseforge/backend/internal/identity"

	"github.com/jackc/pgx/v5"
)

func (s *Server) RegisterProgressRoutes(mux *http.ServeMux) {
	for route, h := range map[string]http.HandlerFunc{
		"GET /api/v1/progress":                  s.progressList,
		"GET /api/v1/lessons/{id}/progress":     s.progressGet,
		"PUT /api/v1/lessons/{id}/progress":     s.progressPut,
		"PUT /api/v1/lessons/{id}/resume-point": s.resumePut,
		"POST /api/v1/learning/tutor":           s.tutorAsk,
	} {
		mux.Handle(route, s.Identity.Require(h))
	}
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
