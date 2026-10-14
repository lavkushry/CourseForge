package playback

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"courseforge/backend/internal/identity"

	"github.com/jackc/pgx/v5"
)

func write(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func fail(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrConflict):
		write(w, 409, map[string]any{"detail": "Playback is open in another window.", "code": "playback_conflict"})
	case errors.Is(err, ErrDenied), errors.Is(err, pgx.ErrNoRows):
		write(w, 403, map[string]string{"detail": "Playback access ended. Reopen the lesson.", "code": "playback_denied"})
	default:
		write(w, 503, map[string]string{"detail": "Playback could not be saved. Retry shortly.", "code": "playback_unavailable"})
	}
}
func read(w http.ResponseWriter, r *http.Request, v any) bool {
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10))
	d.DisallowUnknownFields()
	if d.Decode(v) != nil {
		write(w, 422, map[string]string{"detail": "Invalid playback request."})
		return false
	}
	if d.Decode(new(any)) != io.EOF {
		write(w, 422, map[string]string{"detail": "One JSON object is required."})
		return false
	}
	return true
}
func (s *Service) principal(w http.ResponseWriter, r *http.Request) (identity.Principal, bool) {
	p, ok := identity.FromContext(r.Context())
	if !ok {
		write(w, 401, map[string]string{"detail": "Sign in required."})
		return p, false
	}
	if r.Method != "GET" && !s.Identity.CheckMutation(w, r, p) {
		return p, false
	}
	return p, true
}
func token() (string, error) {
	b := make([]byte, 32)
	if _, e := rand.Read(b); e != nil {
		return "", e
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}
func digest(t string) string { h := sha256.Sum256([]byte(t)); return hex.EncodeToString(h[:]) }
func lockUser(ctx context.Context, tx pgx.Tx, p identity.Principal) error {
	var id string
	return tx.QueryRow(ctx, `SELECT u.id FROM users u JOIN auth_sessions a ON a.user_id=u.id WHERE u.id=$1 AND a.id=$2 AND u.role=$3 AND u.verified AND NOT u.suspended AND a.revoked_at IS NULL AND a.expires_at>now() FOR UPDATE OF u FOR SHARE OF a`, p.UserID, p.SessionID, p.Role).Scan(&id)
}
func allowed(ctx context.Context, tx pgx.Tx, p identity.Principal, lessonID string) error {
	var found bool
	err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM lessons l JOIN courses c ON c.id=l.course_id WHERE l.id=$2 AND ($3='admin' OR (c.published AND EXISTS(SELECT 1 FROM enrollments e WHERE e.user_id=$1 AND e.course_id=c.id))))`, p.UserID, lessonID, p.Role).Scan(&found)
	if err != nil {
		return err
	}
	if !found {
		return ErrDenied
	}
	return nil
}
