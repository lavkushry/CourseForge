package identity

import (
	"context"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"courseforge/backend/internal/httpx"

	"github.com/jackc/pgx/v5"
)

func (s *Service) sessions(w http.ResponseWriter, r *http.Request) {
	p, _ := FromContext(r.Context())
	limit, cursor, ok := identityPage(w, r)
	if !ok {
		return
	}
	rows, err := s.Pool.Query(r.Context(), "SELECT id,device,created_at,last_seen_at,expires_at FROM auth_sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>now() AND id>$2 ORDER BY id LIMIT $3", p.UserID, cursor, limit+1)
	if err != nil {
		s.lifecycleError(w, err)
		return
	}
	defer rows.Close()
	items := make([]map[string]any, 0, limit+1)
	for rows.Next() {
		var id, device string
		var created, seen, expires time.Time
		if err = rows.Scan(&id, &device, &created, &seen, &expires); err != nil {
			s.lifecycleError(w, err)
			return
		}
		items = append(items, map[string]any{"id": id, "device": device, "created_at": created, "last_seen": seen, "expires_at": expires, "current": id == p.SessionID})
	}
	if err = rows.Err(); err != nil {
		s.lifecycleError(w, err)
		return
	}
	next := ""
	if len(items) > limit {
		items = items[:limit]
		next = encodeCursor(items[len(items)-1]["id"].(string))
	}
	httpx.JSON(w, 200, map[string]any{"sessions": items, "next_cursor": next})
}
func (s *Service) revokeSession(w http.ResponseWriter, r *http.Request) {
	p, _ := FromContext(r.Context())
	tag, err := s.Pool.Exec(r.Context(), "UPDATE auth_sessions SET revoked_at=now() WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL", r.PathValue("sid"), p.UserID)
	if err != nil {
		s.lifecycleError(w, err)
		return
	}
	if tag.RowsAffected() == 0 {
		s.lifecycleError(w, pgx.ErrNoRows)
		return
	}
	httpx.JSON(w, 200, map[string]bool{"ok": true})
}
func (s *Service) updateProfile(w http.ResponseWriter, r *http.Request) {
	p, _ := FromContext(r.Context())
	var b struct {
		Name            string `json:"name"`
		CurrentPassword string `json:"current_password"`
		Password        string `json:"password"`
	}
	if !httpx.Decode(w, r, &b) {
		return
	}
	b.Name = strings.TrimSpace(b.Name)
	if len([]rune(b.Name)) < 1 || len([]rune(b.Name)) > 120 || utf8.RuneCountInString(b.CurrentPassword) > 128 || (b.Password != "" && (utf8.RuneCountInString(b.Password) < 4 || utf8.RuneCountInString(b.Password) > 128)) {
		httpx.Error(w, 422, "invalid_profile", "Invalid profile details")
		return
	}
	var oldHash, newHash string
	if b.Password != "" {
		if err := s.Pool.QueryRow(r.Context(), "SELECT password_hash FROM users WHERE id=$1", p.UserID).Scan(&oldHash); err != nil {
			s.lifecycleError(w, err)
			return
		}
		if !s.acquireHash(w) {
			return
		}
		valid := VerifyPassword(oldHash, b.CurrentPassword)
		var err error
		if valid {
			newHash, err = HashPassword(b.Password)
		}
		<-s.hashSlots
		if !valid {
			httpx.Error(w, 403, "incorrect_password", "Current password is incorrect")
			return
		}
		if err != nil {
			s.lifecycleError(w, err)
			return
		}
	}
	tx, err := s.Pool.Begin(r.Context())
	if err != nil {
		s.lifecycleError(w, err)
		return
	}
	defer tx.Rollback(context.Background())
	if err = lockSelf(r.Context(), tx, p); err != nil {
		s.lifecycleError(w, err)
		return
	}
	if b.Password != "" {
		tag, err := tx.Exec(r.Context(), "UPDATE users SET name=$2,password_hash=$3 WHERE id=$1 AND password_hash=$4", p.UserID, b.Name, newHash, oldHash)
		if err != nil {
			s.lifecycleError(w, err)
			return
		}
		if tag.RowsAffected() != 1 {
			httpx.Error(w, 409, "account_changed", "Account changed; sign in again")
			return
		}
		if _, err = tx.Exec(r.Context(), "UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1 AND id<>$2 AND revoked_at IS NULL", p.UserID, p.SessionID); err != nil {
			s.lifecycleError(w, err)
			return
		}
		if _, err = tx.Exec(r.Context(), "DELETE FROM account_tokens WHERE user_id=$1", p.UserID); err != nil {
			s.lifecycleError(w, err)
			return
		}
	} else {
		if _, err = tx.Exec(r.Context(), "UPDATE users SET name=$2 WHERE id=$1", p.UserID, b.Name); err != nil {
			s.lifecycleError(w, err)
			return
		}
	}
	if err = tx.Commit(r.Context()); err != nil {
		s.lifecycleError(w, err)
		return
	}
	p.Name = b.Name
	httpx.JSON(w, 200, map[string]any{"user": public(p)})
}
func (s *Service) deleteAccount(w http.ResponseWriter, r *http.Request) {
	p, _ := FromContext(r.Context())
	if p.Role == "admin" {
		httpx.Error(w, 409, "admin_account", "Transfer administration before deletion")
		return
	}
	var b struct {
		Password string `json:"password"`
	}
	if !httpx.Decode(w, r, &b) {
		return
	}
	var hash string
	if err := s.Pool.QueryRow(r.Context(), "SELECT password_hash FROM users WHERE id=$1", p.UserID).Scan(&hash); err != nil {
		s.lifecycleError(w, err)
		return
	}
	if !s.acquireHash(w) {
		return
	}
	valid := VerifyPassword(hash, b.Password)
	<-s.hashSlots
	if !valid {
		httpx.Error(w, 403, "incorrect_password", "Password is incorrect")
		return
	}
	tx, err := s.Pool.Begin(r.Context())
	if err != nil {
		s.lifecycleError(w, err)
		return
	}
	defer tx.Rollback(context.Background())
	if err = lockSelf(r.Context(), tx, p); err != nil {
		s.lifecycleError(w, err)
		return
	}
	tag, err := tx.Exec(r.Context(), "DELETE FROM users WHERE id=$1 AND role='student' AND password_hash=$2", p.UserID, hash)
	if err != nil {
		s.lifecycleError(w, err)
		return
	}
	if tag.RowsAffected() != 1 {
		httpx.Error(w, 409, "account_changed", "Account changed; sign in again")
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		s.lifecycleError(w, err)
		return
	}
	http.SetCookie(w, &http.Cookie{Name: CookieName, Value: "", Path: "/", HttpOnly: true, Secure: s.Config.CookieSecure, SameSite: http.SameSiteLaxMode, MaxAge: -1})
	httpx.JSON(w, 200, map[string]bool{"ok": true})
}
