package api

import (
	"context"
	"errors"
	"math"
	"net/http"
	"strings"

	"courseforge/backend/internal/access"
	"courseforge/backend/internal/httpx"
	"courseforge/backend/internal/identity"

	"github.com/jackc/pgx/v5"
)

func (s *Server) RegisterNotesRoutes(mux *http.ServeMux) {
	for route, h := range map[string]http.HandlerFunc{
		"GET /api/v1/lessons/{id}/notes":              s.notes,
		"POST /api/v1/lessons/{id}/notes":             s.noteCreate,
		"DELETE /api/v1/lessons/{id}/notes/{note_id}": s.noteDelete,
	} {
		mux.Handle(route, s.Identity.Require(h))
	}
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
