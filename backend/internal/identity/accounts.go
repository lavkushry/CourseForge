package identity

import (
	"context"
	"errors"
	"net/http"

	"courseforge/backend/internal/httpx"

	"github.com/jackc/pgx/v5"
)

var ErrLastAdmin = errors.New("at least one verified, unsuspended administrator must remain")
var ErrAdminSuspension = errors.New("administrator accounts cannot be suspended here")
var ErrAccountNotActive = errors.New("activate and restore the account before promoting it")

// ChangeAccount serializes role/suspension changes across replicas and revokes
// the target's sessions in the same commit. No process-local admin count exists.
func (s *Service) ChangeAccount(ctx context.Context, actor Principal, targetID, role string, suspended bool) error {
	return s.changeAccount(ctx, actor, targetID, &role, &suspended, "")
}
func (s *Service) changeAccount(ctx context.Context, actor Principal, targetID string, roleChange *string, suspensionChange *bool, expectedActorHash string) error {
	if roleChange != nil && *roleChange != "student" && *roleChange != "admin" {
		return errors.New("invalid role")
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(673583405)"); err != nil {
		return err
	}
	if err = LockPrincipal(ctx, tx, actor); err != nil {
		return err
	}
	if actor.Role != "admin" {
		return pgx.ErrNoRows
	}
	if expectedActorHash != "" {
		var liveHash string
		if err = tx.QueryRow(ctx, "SELECT password_hash FROM users WHERE id=$1", actor.UserID).Scan(&liveHash); err != nil {
			return err
		}
		if liveHash != expectedActorHash {
			return pgx.ErrNoRows
		}
	}
	var oldRole string
	var oldSuspended, verified bool
	if err = tx.QueryRow(ctx, "SELECT role,suspended,verified FROM users WHERE id=$1 FOR UPDATE", targetID).Scan(&oldRole, &oldSuspended, &verified); err != nil {
		return err
	}
	role, suspended := oldRole, oldSuspended
	if roleChange != nil {
		role = *roleChange
	}
	if suspensionChange != nil {
		suspended = *suspensionChange
	}
	if suspensionChange != nil && *suspensionChange && (oldRole == "admin" || actor.UserID == targetID) {
		return ErrAdminSuspension
	}
	if role == "admin" && oldRole != "admin" && (!verified || suspended) {
		return ErrAccountNotActive
	}
	if role == oldRole && suspended == oldSuspended {
		return tx.Commit(ctx)
	}
	if oldRole == "admin" && !oldSuspended && verified && (role != "admin" || suspended) {
		var count int
		if err = tx.QueryRow(ctx, "SELECT count(*) FROM users WHERE role='admin' AND verified AND NOT suspended").Scan(&count); err != nil {
			return err
		}
		if count <= 1 {
			return ErrLastAdmin
		}
	}
	if _, err = tx.Exec(ctx, "UPDATE users SET role=$2,suspended=$3 WHERE id=$1", targetID, role, suspended); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, "UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", targetID); err != nil {
		return err
	}
	if role != oldRole {
		if _, err = tx.Exec(ctx, "DELETE FROM account_tokens WHERE user_id=$1", targetID); err != nil {
			return err
		}
	}
	if _, err = tx.Exec(ctx, "INSERT INTO admin_audit(actor_id,action,resource) VALUES($1,'account_state_changed',$2)", actor.UserID, targetID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func (s *Service) RegisterAdminRoutes(mux *http.ServeMux) {
	s.registerMoreAdminRoutes(mux)
	mux.Handle("PATCH /api/v1/admin/users/{id}", s.Require(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, _ := FromContext(r.Context())
		if p.Role != "admin" {
			httpx.Error(w, 403, "admin_required", "Administrator access required")
			return
		}
		var b struct {
			Role            *string `json:"role"`
			Suspended       *bool   `json:"suspended"`
			CurrentPassword string  `json:"current_password"`
		}
		if !httpx.Decode(w, r, &b) {
			return
		}
		if b.Role != nil && *b.Role != "admin" && *b.Role != "student" {
			httpx.Error(w, 422, "invalid_role", "Invalid role")
			return
		}
		var oldRole string
		if err := s.Pool.QueryRow(r.Context(), "SELECT role FROM users WHERE id=$1", r.PathValue("id")).Scan(&oldRole); err != nil {
			s.lifecycleError(w, err)
			return
		}
		if b.Suspended != nil && *b.Suspended && (oldRole == "admin" || r.PathValue("id") == p.UserID) {
			httpx.Error(w, 409, "admin_account", "Administrator accounts cannot be suspended here")
			return
		}
		hash := ""
		if b.Role != nil {
			if err := s.Pool.QueryRow(r.Context(), "SELECT password_hash FROM users WHERE id=$1", p.UserID).Scan(&hash); err != nil {
				s.lifecycleError(w, err)
				return
			}
			if !s.acquireHash(w) {
				return
			}
			valid := VerifyPassword(hash, b.CurrentPassword)
			<-s.hashSlots
			if !valid {
				httpx.Error(w, 403, "incorrect_password", "Current password is incorrect")
				return
			}
		}
		err := s.changeAccount(r.Context(), p, r.PathValue("id"), b.Role, b.Suspended, hash)
		if errors.Is(err, ErrAdminSuspension) {
			httpx.Error(w, 409, "admin_account", err.Error())
			return
		}
		if errors.Is(err, ErrAccountNotActive) {
			httpx.Error(w, 409, "account_inactive", err.Error())
			return
		}
		if errors.Is(err, ErrLastAdmin) {
			httpx.Error(w, 409, "last_admin", err.Error())
			return
		}
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.Error(w, 404, "not_found", "Account not found")
			return
		}
		if err != nil {
			httpx.Error(w, 503, "database_unavailable", "Please retry shortly")
			return
		}
		httpx.JSON(w, 200, map[string]bool{"ok": true})
	})))
}
