package identity

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

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
