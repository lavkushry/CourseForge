package learning

import (
	"context"
	"courseforge/backend/internal/httpx"
	"courseforge/backend/internal/identity"
	"github.com/jackc/pgx/v5"
	"net/http"
	"time"
	_ "time/tzdata"
)

// Credit anchors the learner's chosen/imported timezone on first accepted action.
// Never derive it from the browser or server timezone. Importers must restore
// learning_preferences before replaying legacy actions.
func credit(ctx context.Context, tx pgx.Tx, user, kind, resource string, at time.Time) (bool, error) {
	if _, err := tx.Exec(ctx, `INSERT INTO learning_preferences(user_id,timezone)VALUES($1,'UTC')ON CONFLICT(user_id)DO NOTHING`, user); err != nil {
		return false, err
	}
	var zone string
	if err := tx.QueryRow(ctx, "SELECT timezone FROM learning_preferences WHERE user_id=$1", user).Scan(&zone); err != nil {
		return false, err
	}
	location, err := time.LoadLocation(zone)
	if err != nil {
		return false, ErrInvalid
	}
	tag, err := tx.Exec(ctx, `INSERT INTO learning_credits(user_id,kind,resource,day,credited_at)VALUES($1,$2,$3,$4,$5)ON CONFLICT DO NOTHING`, user, kind, resource, at.In(location).Format("2006-01-02"), at)
	return tag.RowsAffected() == 1, err
}
func (s *Service) preferences(w http.ResponseWriter, r *http.Request) {
	zone := "UTC"
	err := s.Pool.QueryRow(r.Context(), "SELECT timezone FROM learning_preferences WHERE user_id=$1", principal(r).UserID).Scan(&zone)
	if err != nil && err != pgx.ErrNoRows {
		failure(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"timezone": zone, "initialized": err == nil})
}
func (s *Service) preferencesPut(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Timezone string `json:"timezone"`
	}
	if !httpx.Decode(w, r, &body) {
		return
	}
	if len(body.Timezone) < 1 || len(body.Timezone) > 100 || body.Timezone == "Local" {
		failure(w, ErrInvalid)
		return
	}
	if _, err := time.LoadLocation(body.Timezone); err != nil {
		failure(w, ErrInvalid)
		return
	}
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
	if _, err = tx.Exec(ctx, `INSERT INTO learning_preferences(user_id,timezone)VALUES($1,$2)ON CONFLICT(user_id)DO NOTHING`, p.UserID, body.Timezone); err != nil {
		failure(w, err)
		return
	}
	var zone string
	if err = tx.QueryRow(ctx, "SELECT timezone FROM learning_preferences WHERE user_id=$1", p.UserID).Scan(&zone); err == nil {
		err = tx.Commit(ctx)
	}
	if err != nil {
		failure(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"timezone": zone, "initialized": true})
}
func (s *Service) credits(w http.ResponseWriter, r *http.Request) {
	limit, mark, ok := page(w, r)
	if !ok {
		return
	}
	if mark.ID == "" {
		mark.At = time.Date(9999, 12, 31, 0, 0, 0, 0, time.UTC)
		mark.ID = "~"
	}
	rows, err := s.Pool.Query(r.Context(), `SELECT kind,resource,day::text,credited_at FROM learning_credits WHERE user_id=$1 AND (credited_at,kind||':'||resource)<($2,$3) ORDER BY credited_at DESC,kind||':'||resource DESC LIMIT $4`, principal(r).UserID, mark.At, mark.ID, limit+1)
	if err != nil {
		failure(w, err)
		return
	}
	defer rows.Close()
	type Credit struct {
		Kind       string    `json:"kind"`
		Resource   string    `json:"resource"`
		Day        string    `json:"day"`
		CreditedAt time.Time `json:"credited_at"`
	}
	items := []Credit{}
	for rows.Next() {
		var c Credit
		if err = rows.Scan(&c.Kind, &c.Resource, &c.Day, &c.CreditedAt); err != nil {
			failure(w, err)
			return
		}
		items = append(items, c)
	}
	if err = rows.Err(); err != nil {
		failure(w, err)
		return
	}
	c := ""
	if len(items) > limit {
		items = items[:limit]
		last := items[limit-1]
		c = next(cursor{At: last.CreditedAt, ID: last.Kind + ":" + last.Resource})
	}
	list(w, "credits", items, c)
}
