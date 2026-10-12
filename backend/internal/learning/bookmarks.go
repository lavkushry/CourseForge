package learning

import (
	"context"
	"courseforge/backend/internal/httpx"
	"courseforge/backend/internal/identity"
	"github.com/jackc/pgx/v5"
	"net/http"
	"strings"
	"time"
)

type Bookmark struct {
	ID        string    `json:"id"`
	LessonID  string    `json:"lesson_id"`
	Position  float64   `json:"position"`
	Label     string    `json:"label"`
	CreatedAt time.Time `json:"created_at"`
}

func (s *Service) bookmarks(w http.ResponseWriter, r *http.Request) {
	lesson := r.PathValue("id")
	if !s.lessonRead(w, r, lesson) {
		return
	}
	limit, mark, ok := page(w, r)
	if !ok {
		return
	}
	rows, err := s.Pool.Query(r.Context(), `SELECT id,lesson_id,position,label,created_at FROM bookmarks WHERE user_id=$1 AND lesson_id=$2 AND (position,id)>($3,$4) ORDER BY position,id LIMIT $5`, principal(r).UserID, lesson, mark.Position, mark.ID, limit+1)
	if err != nil {
		failure(w, err)
		return
	}
	defer rows.Close()
	items := []Bookmark{}
	for rows.Next() {
		var b Bookmark
		if err = rows.Scan(&b.ID, &b.LessonID, &b.Position, &b.Label, &b.CreatedAt); err != nil {
			failure(w, err)
			return
		}
		items = append(items, b)
	}
	if err = rows.Err(); err != nil {
		failure(w, err)
		return
	}
	c := ""
	if len(items) > limit {
		items = items[:limit]
		last := items[limit-1]
		c = next(cursor{Position: last.Position, ID: last.ID})
	}
	list(w, "bookmarks", items, c)
}
func (s *Service) bookmarkCreate(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Position float64 `json:"position"`
		Label    string  `json:"label"`
	}
	if !httpx.Decode(w, r, &body) {
		return
	}
	body.Label = strings.TrimSpace(body.Label)
	if !validText(body.Label, 1, 160) || !validPosition(body.Position) {
		failure(w, ErrInvalid)
		return
	}
	lesson := r.PathValue("id")
	s.mutate(w, r, 201, "bookmark:"+lesson, body, lessonGuard(lesson), func(ctx context.Context, tx pgx.Tx, p identity.Principal) (any, error) {
		if err := sourceBounds(ctx, tx, lesson, body.Position, nil); err != nil {
			return nil, err
		}
		id, err := identifier("bm_")
		if err != nil {
			return nil, err
		}
		b := Bookmark{ID: id, LessonID: lesson, Position: body.Position, Label: body.Label}
		err = tx.QueryRow(ctx, `INSERT INTO bookmarks(id,user_id,lesson_id,position,label)VALUES($1,$2,$3,$4,$5)RETURNING created_at`, id, p.UserID, lesson, b.Position, b.Label).Scan(&b.CreatedAt)
		return b, err
	})
}
func (s *Service) bookmarkDelete(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := principal(r)
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		failure(w, err)
		return
	}
	defer tx.Rollback(ctx)
	if err = identity.LockPrincipal(ctx, tx, p); err != nil {
		failure(w, err)
		return
	}
	var lesson string
	err = tx.QueryRow(ctx, "SELECT lesson_id FROM bookmarks WHERE id=$1 AND user_id=$2", r.PathValue("id"), p.UserID).Scan(&lesson)
	if err == nil {
		err = lessonGuard(lesson)(ctx, tx, p)
	}
	if err != nil {
		failure(w, err)
		return
	}
	tag, err := tx.Exec(ctx, "DELETE FROM bookmarks WHERE id=$1 AND user_id=$2", r.PathValue("id"), p.UserID)
	if err == nil && tag.RowsAffected() != 1 {
		err = pgx.ErrNoRows
	}
	if err == nil {
		err = tx.Commit(ctx)
	}
	if err != nil {
		failure(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]bool{"ok": true})
}
