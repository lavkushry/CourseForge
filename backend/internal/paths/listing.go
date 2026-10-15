package paths

import (
	"errors"
	"net/http"
	"time"

	"courseforge/backend/internal/httpx"

	"github.com/jackc/pgx/v5"
)

func (s *Service) get(w http.ResponseWriter, r *http.Request) {
	tx, e := s.transaction(r)
	if e != nil {
		failure(w, e)
		return
	}
	defer tx.Rollback(r.Context())
	v, e := s.load(r.Context(), tx, principal(r), r.PathValue("id"), false)
	if e != nil {
		failure(w, e)
		return
	}
	httpx.JSON(w, 200, v)
}
func (s *Service) list(w http.ResponseWriter, r *http.Request) {
	limit, cursor, ok := page(w, r)
	if !ok {
		return
	}
	mark, e := cursorValue(cursor)
	if e != nil {
		failure(w, e)
		return
	}
	tx, e := s.transaction(r)
	if e != nil {
		failure(w, e)
		return
	}
	defer tx.Rollback(r.Context())
	rows, e := tx.Query(r.Context(), `SELECT id,updated_at FROM learning_paths WHERE user_id=$1 AND (updated_at,id)<($2,$3) ORDER BY updated_at DESC,id DESC LIMIT $4`, principal(r).UserID, mark.At, mark.ID, limit+1)
	if e != nil {
		failure(w, e)
		return
	}
	ids := []string{}
	times := []time.Time{}
	for rows.Next() {
		var v string
		var at time.Time
		e = rows.Scan(&v, &at)
		if e != nil {
			rows.Close()
			failure(w, e)
			return
		}
		ids = append(ids, v)
		times = append(times, at)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		failure(w, e)
		return
	}
	next := ""
	if len(ids) > limit {
		ids = ids[:limit]
		next = encodeCursor(times[limit-1], ids[len(ids)-1])
	}
	items := []Path{}
	for _, pathID := range ids {
		v, e := s.load(r.Context(), tx, principal(r), pathID, false)
		if errors.Is(e, pgx.ErrNoRows) {
			continue
		}
		if e != nil {
			failure(w, e)
			return
		}
		items = append(items, v)
	}
	httpx.JSON(w, 200, map[string]any{"paths": items, "next_cursor": next})
}
