package identity

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"unicode/utf8"

	"courseforge/backend/internal/httpx"

	"github.com/jackc/pgx/v5"
)

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
