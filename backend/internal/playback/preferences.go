package playback

import (
	"context"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"
)

type preferenceReader interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func preferences(ctx context.Context, db preferenceReader, user string) (Preferences, error) {
	p := Preferences{Autoplay: true, Speed: 1}
	err := db.QueryRow(ctx, `SELECT autoplay,speed,theater FROM player_preferences WHERE user_id=$1`, user).Scan(&p.Autoplay, &p.Speed, &p.Theater)
	if errors.Is(err, pgx.ErrNoRows) {
		err = nil
	}
	return p, err
}
func (s *Service) getPreferences(w http.ResponseWriter, r *http.Request) {
	p, ok := s.principal(w, r)
	if !ok {
		return
	}
	prefs, err := preferences(r.Context(), s.Pool, p.UserID)
	if err != nil {
		fail(w, err)
		return
	}
	write(w, 200, prefs)
}
func (s *Service) putPreferences(w http.ResponseWriter, r *http.Request) {
	p, ok := s.principal(w, r)
	if !ok {
		return
	}
	var prefs Preferences
	if !read(w, r, &prefs) {
		return
	}
	if !finite(prefs.Speed) || prefs.Speed < .5 || prefs.Speed > 3 {
		write(w, 422, map[string]string{"detail": "Speed must be between 0.5 and 3."})
		return
	}
	ctx := r.Context()
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		fail(w, err)
		return
	}
	defer tx.Rollback(ctx)
	if err = lockUser(ctx, tx, p); err == nil {
		_, err = tx.Exec(ctx, `INSERT INTO player_preferences(user_id,autoplay,speed,theater)VALUES($1,$2,$3,$4) ON CONFLICT(user_id)DO UPDATE SET autoplay=excluded.autoplay,speed=excluded.speed,theater=excluded.theater,updated_at=now()`, p.UserID, prefs.Autoplay, prefs.Speed, prefs.Theater)
	}
	if err == nil {
		err = tx.Commit(ctx)
	}
	if err != nil {
		fail(w, err)
		return
	}
	write(w, 200, prefs)
}
