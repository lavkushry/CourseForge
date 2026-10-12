package identity

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"courseforge/backend/internal/httpx"
	"github.com/jackc/pgx/v5"
)

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}
func (s *Service) CheckPublicMutation(w http.ResponseWriter, r *http.Request) bool {
	if !s.CheckOrigin(w, r) {
		return false
	}
	p, err := s.Principal(r.Context(), r)
	if errors.Is(err, pgx.ErrNoRows) {
		return true
	}
	if err != nil {
		s.lifecycleError(w, err)
		return false
	}
	return s.CheckMutation(w, r, p)
}
func (s *Service) requireMail(w http.ResponseWriter) bool {
	if s.Config.Mailer == nil {
		httpx.Error(w, 503, "mail_unavailable", "Account email is not configured")
		return false
	}
	return true
}
func (s *Service) lifecycleError(w http.ResponseWriter, err error) {
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(w, 404, "not_found", "Resource not found")
		return
	}
	httpx.Error(w, 503, "database_unavailable", "Please retry shortly")
}
func (s *Service) accountURL(action, token string) string {
	primary := strings.TrimSpace(strings.Split(s.Config.PublicOrigin, ",")[0])
	return primary + "/#" + action + "?token=" + url.QueryEscape(token)
}
func lockSelf(ctx context.Context, tx pgx.Tx, p Principal) error {
	var id string
	return tx.QueryRow(ctx, `SELECT u.id FROM users u JOIN auth_sessions s ON s.user_id=u.id WHERE u.id=$1 AND s.id=$2 AND u.role=$3 AND NOT u.suspended AND s.revoked_at IS NULL AND s.expires_at>now() FOR UPDATE OF u FOR SHARE OF s`, p.UserID, p.SessionID, p.Role).Scan(&id)
}
func issueTokenTx(ctx context.Context, tx pgx.Tx, userID, kind string) (string, error) {
	token := RandomToken()
	duration := 24 * time.Hour
	if kind == "reset" {
		duration = time.Hour
	}
	_, err := tx.Exec(ctx, `INSERT INTO account_tokens(token_hash,user_id,kind,expires_at) VALUES($1,$2,$3,now()+$4::interval) ON CONFLICT(user_id,kind) DO UPDATE SET token_hash=excluded.token_hash,expires_at=excluded.expires_at`, Digest(token), userID, kind, duration.String())
	return token, err
}
func (s *Service) issueToken(ctx context.Context, userID, kind string) (string, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(context.Background())
	var id string
	if err = tx.QueryRow(ctx, "SELECT id FROM users WHERE id=$1 AND NOT suspended FOR UPDATE", userID).Scan(&id); err != nil {
		return "", err
	}
	token, err := issueTokenTx(ctx, tx, userID, kind)
	if err != nil {
		return "", err
	}
	return token, tx.Commit(ctx)
}

func (s *Service) RegisterLifecycleRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/public/account-options", s.accountOptions)
	mux.HandleFunc("POST /api/v1/auth/verify", s.verify)
	mux.HandleFunc("POST /api/v1/auth/forgot", s.requestEmail)
	mux.HandleFunc("POST /api/v1/auth/resend", s.requestEmail)
	mux.HandleFunc("POST /api/v1/auth/reset", s.reset)
	mux.HandleFunc("POST /api/v1/auth/activate", s.activate)
	mux.Handle("GET /api/v1/auth/sessions", s.Require(http.HandlerFunc(s.sessions)))
	mux.Handle("DELETE /api/v1/auth/sessions/{sid}", s.Require(http.HandlerFunc(s.revokeSession)))
	mux.Handle("PATCH /api/v1/auth/me", s.Require(http.HandlerFunc(s.updateProfile)))
	mux.Handle("DELETE /api/v1/auth/me", s.Require(http.HandlerFunc(s.deleteAccount)))
	mux.Handle("GET /api/v1/me", s.Require(http.HandlerFunc(s.me)))
	mux.Handle("PATCH /api/v1/me", s.Require(http.HandlerFunc(s.updateProfile)))
	mux.Handle("DELETE /api/v1/me", s.Require(http.HandlerFunc(s.deleteAccount)))
}
func (s *Service) accountOptions(w http.ResponseWriter, r *http.Request) {
	ready := s.Config.Mailer != nil
	httpx.JSON(w, 200, map[string]any{"registration_enabled": s.Config.RegistrationMode == "open" || (s.Config.RegistrationMode == "email" && ready), "registration_mode": s.Config.RegistrationMode, "email_registration": s.Config.RegistrationMode == "email" && ready, "email_delivery": ready, "admin_invitations": true})
}

type tokenBody struct {
	Token string `json:"token"`
}

func validToken(token string) bool { return len(token) >= 20 && len(token) <= 100 }
func (s *Service) verify(w http.ResponseWriter, r *http.Request) {
	if !s.CheckOrigin(w, r) {
		return
	}
	var b tokenBody
	if !httpx.Decode(w, r, &b) {
		return
	}
	if !validToken(b.Token) {
		httpx.Error(w, 400, "invalid_token", "Invalid or expired account link")
		return
	}
	tx, err := s.Pool.Begin(r.Context())
	if err != nil {
		s.lifecycleError(w, err)
		return
	}
	defer tx.Rollback(context.Background())
	userID, err := consumeToken(r.Context(), tx, b.Token, "verify")
	if err != nil {
		s.tokenError(w, err)
		return
	}
	if _, err = tx.Exec(r.Context(), "UPDATE users SET verified=true WHERE id=$1", userID); err != nil {
		s.lifecycleError(w, err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		s.lifecycleError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]string{"message": "Email verified. Sign in to start learning."})
}

// consumeToken locks the account before its token, matching token issuance and
// password updates. PostgreSQL rechecks expiry and one-use consumption atomically.
func consumeToken(ctx context.Context, tx pgx.Tx, token, kind string) (string, error) {
	var userID string
	if err := tx.QueryRow(ctx, "SELECT user_id FROM account_tokens WHERE token_hash=$1 AND kind=$2", Digest(token), kind).Scan(&userID); err != nil {
		return "", err
	}
	var id string
	if err := tx.QueryRow(ctx, "SELECT id FROM users WHERE id=$1 AND NOT suspended FOR UPDATE", userID).Scan(&id); err != nil {
		return "", err
	}
	if err := tx.QueryRow(ctx, "DELETE FROM account_tokens WHERE token_hash=$1 AND kind=$2 AND expires_at>now() RETURNING user_id", Digest(token), kind).Scan(&id); err != nil {
		return "", err
	}
	return id, nil
}
func (s *Service) tokenError(w http.ResponseWriter, err error) {
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(w, 400, "invalid_token", "Invalid or expired account link")
		return
	}
	s.lifecycleError(w, err)
}
func (s *Service) requestEmail(w http.ResponseWriter, r *http.Request) {
	if !s.CheckPublicMutation(w, r) || !s.requireMail(w) {
		return
	}
	var b struct {
		Email string `json:"email"`
	}
	if !httpx.Decode(w, r, &b) {
		return
	}
	email, ok := validEmail(b.Email)
	if !ok {
		httpx.Error(w, 422, "invalid_email", "Invalid email address")
		return
	}
	allowed, err := s.rateLimit(r.Context(), "mail:"+Digest(email), 3)
	if err != nil {
		s.lifecycleError(w, err)
		return
	}
	if !allowed {
		w.Header().Set("Retry-After", "900")
		httpx.Error(w, 429, "mail_limited", "Too many account email requests")
		return
	}
	kind := "verify"
	if strings.HasSuffix(r.URL.Path, "/forgot") {
		kind = "reset"
	}
	var id string
	err = s.Pool.QueryRow(r.Context(), "SELECT id FROM users WHERE lower(email)=$1 AND NOT suspended AND ($2='reset' OR NOT verified)", email, kind).Scan(&id)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		s.lifecycleError(w, err)
		return
	}
	if err == nil {
		token, err := s.issueToken(r.Context(), id, kind)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			s.lifecycleError(w, err)
			return
		}
		if err == nil {
			if err = s.Config.Mailer.Send(r.Context(), email, kind, s.accountURL(map[string]string{"verify": "verify", "reset": "reset"}[kind], token)); err != nil {
				httpx.Error(w, 503, "mail_unavailable", "Unable to send account email")
				return
			}
		}
	}
	httpx.JSON(w, 200, map[string]string{"message": "If this account needs the requested email, it has been sent."})
}
func (s *Service) reset(w http.ResponseWriter, r *http.Request)    { s.replacePassword(w, r, "reset") }
func (s *Service) activate(w http.ResponseWriter, r *http.Request) { s.replacePassword(w, r, "invite") }
func (s *Service) replacePassword(w http.ResponseWriter, r *http.Request, kind string) {
	if !s.CheckOrigin(w, r) {
		return
	}
	var b struct {
		Token    string `json:"token"`
		Password string `json:"password"`
	}
	if !httpx.Decode(w, r, &b) {
		return
	}
	if !validToken(b.Token) || utf8.RuneCountInString(b.Password) < 4 || utf8.RuneCountInString(b.Password) > 128 {
		httpx.Error(w, 400, "invalid_token", "Invalid account link or password")
		return
	}
	if !s.acquireHash(w) {
		return
	}
	hash, err := HashPassword(b.Password)
	<-s.hashSlots
	if err != nil {
		httpx.Error(w, 422, "invalid_password", "Invalid password")
		return
	}
	tx, err := s.Pool.Begin(r.Context())
	if err != nil {
		s.lifecycleError(w, err)
		return
	}
	defer tx.Rollback(context.Background())
	id, err := consumeToken(r.Context(), tx, b.Token, kind)
	if err != nil {
		s.tokenError(w, err)
		return
	}
	var verified bool
	if err = tx.QueryRow(r.Context(), "SELECT verified FROM users WHERE id=$1", id).Scan(&verified); err != nil {
		s.lifecycleError(w, err)
		return
	}
	if kind == "invite" && verified {
		httpx.Error(w, 400, "invalid_token", "Account is already active")
		return
	}
	if _, err = tx.Exec(r.Context(), "UPDATE users SET password_hash=$2,verified=verified OR $3 WHERE id=$1", id, hash, kind == "invite"); err != nil {
		s.lifecycleError(w, err)
		return
	}
	if _, err = tx.Exec(r.Context(), "DELETE FROM account_tokens WHERE user_id=$1", id); err != nil {
		s.lifecycleError(w, err)
		return
	}
	if _, err = tx.Exec(r.Context(), "UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", id); err != nil {
		s.lifecycleError(w, err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		s.lifecycleError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]string{"message": "Account updated. Sign in with your password."})
}
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
