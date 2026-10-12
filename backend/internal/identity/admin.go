package identity

import (
	"context"
	"encoding/base64"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"courseforge/backend/internal/httpx"
	"github.com/jackc/pgx/v5"
)

func encodeCursor(id string) string { return base64.RawURLEncoding.EncodeToString([]byte(id)) }
func identityPage(w http.ResponseWriter, r *http.Request) (int, string, bool) {
	limit := 50
	if raw := r.URL.Query().Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > 100 {
			httpx.Error(w, 400, "invalid_page", "limit must be 1..100")
			return 0, "", false
		}
		limit = n
	}
	cursor := ""
	if raw := r.URL.Query().Get("cursor"); raw != "" {
		b, err := base64.RawURLEncoding.DecodeString(raw)
		if err != nil || len(b) > 512 {
			httpx.Error(w, 400, "invalid_cursor", "Invalid page cursor")
			return 0, "", false
		}
		cursor = string(b)
	}
	return limit, cursor, true
}
func (s *Service) admin(next http.HandlerFunc) http.Handler {
	return s.Require(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, _ := FromContext(r.Context())
		if p.Role != "admin" {
			httpx.Error(w, 403, "admin_required", "Administrator access required")
			return
		}
		next(w, r)
	}))
}
func (s *Service) registerMoreAdminRoutes(mux *http.ServeMux) {
	mux.Handle("GET /api/v1/admin/users", s.admin(s.adminUsers))
	mux.Handle("GET /api/v1/admin/users/{id}", s.admin(s.adminUser))
	mux.Handle("POST /api/v1/admin/invitations", s.admin(s.invite))
	mux.Handle("POST /api/v1/admin/users/{id}/account-link", s.admin(s.accountLink))
	mux.Handle("DELETE /api/v1/admin/users/{id}/sessions", s.admin(s.adminRevokeSessions))
	mux.Handle("PUT /api/v1/admin/users/{id}/enrollments", s.admin(s.adminEnrollment))
	mux.Handle("PUT /api/v1/admin/users/{id}/role", s.admin(s.adminRole))
}
func (s *Service) adminUsers(w http.ResponseWriter, r *http.Request) {
	limit, cursor, ok := identityPage(w, r)
	if !ok {
		return
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if len(q) > 100 {
		httpx.Error(w, 400, "invalid_search", "Search is too long")
		return
	}
	rows, err := s.Pool.Query(r.Context(), "SELECT id,email,name,role,verified,suspended,created_at FROM users WHERE id>$1 AND ($2='' OR email ILIKE '%'||$2||'%' ESCAPE '' OR name ILIKE '%'||$2||'%' ESCAPE '') ORDER BY id LIMIT $3", cursor, q, limit+1)
	if err != nil {
		s.lifecycleError(w, err)
		return
	}
	defer rows.Close()
	items := make([]map[string]any, 0, limit+1)
	for rows.Next() {
		var p Principal
		var suspended bool
		if err = rows.Scan(&p.UserID, &p.Email, &p.Name, &p.Role, &p.Verified, &suspended, &p.CreatedAt); err != nil {
			s.lifecycleError(w, err)
			return
		}
		u := public(p)
		u["suspended"] = suspended
		items = append(items, u)
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
	httpx.JSON(w, 200, map[string]any{"users": items, "next_cursor": next})
}
func (s *Service) adminUser(w http.ResponseWriter, r *http.Request) {
	var p Principal
	var suspended bool
	err := s.Pool.QueryRow(r.Context(), "SELECT id,email,name,role,verified,suspended,created_at FROM users WHERE id=$1", r.PathValue("id")).Scan(&p.UserID, &p.Email, &p.Name, &p.Role, &p.Verified, &suspended, &p.CreatedAt)
	if err != nil {
		s.lifecycleError(w, err)
		return
	}
	u := public(p)
	u["suspended"] = suspended
	rows, err := s.Pool.Query(r.Context(), "SELECT course_id FROM enrollments WHERE user_id=$1 ORDER BY course_id LIMIT 100", p.UserID)
	if err != nil {
		s.lifecycleError(w, err)
		return
	}
	defer rows.Close()
	courses := make([]string, 0)
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			s.lifecycleError(w, err)
			return
		}
		courses = append(courses, id)
	}
	if err = rows.Err(); err != nil {
		s.lifecycleError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"user": u, "enrollments": courses})
}
func (s *Service) invite(w http.ResponseWriter, r *http.Request) {
	p, _ := FromContext(r.Context())
	var b struct {
		Email  string `json:"email"`
		Name   string `json:"name"`
		Course string `json:"course"`
	}
	if !httpx.Decode(w, r, &b) {
		return
	}
	email, ok := validEmail(b.Email)
	b.Name = strings.TrimSpace(b.Name)
	if !ok || len([]rune(b.Name)) < 1 || len([]rune(b.Name)) > 120 || len(b.Course) > 512 {
		httpx.Error(w, 422, "invalid_invitation", "Invalid invitation details")
		return
	}
	if s.Config.PublicOrigin == "" {
		httpx.Error(w, 503, "account_url_unavailable", "Account URL is not configured")
		return
	}
	// Invited accounts receive an unknown random password until activation.
	if !s.acquireHash(w) {
		return
	}
	hash, err := HashPassword(RandomToken())
	<-s.hashSlots
	if err != nil {
		s.lifecycleError(w, err)
		return
	}
	tx, err := s.Pool.Begin(r.Context())
	if err != nil {
		s.lifecycleError(w, err)
		return
	}
	defer tx.Rollback(context.Background())
	if err = LockPrincipal(r.Context(), tx, p); err != nil {
		s.lifecycleError(w, err)
		return
	}
	uid := "usr_" + RandomToken()
	var id string
	err = tx.QueryRow(r.Context(), "INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id", uid, email, b.Name, hash).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(w, 409, "account_exists", "Email is already registered")
		return
	}
	if err != nil {
		s.lifecycleError(w, err)
		return
	}
	if b.Course != "" {
		var courseID string
		if err = tx.QueryRow(r.Context(), "SELECT id FROM courses WHERE id=$1 FOR SHARE", b.Course).Scan(&courseID); err != nil {
			s.lifecycleError(w, err)
			return
		}
		if _, err = tx.Exec(r.Context(), "INSERT INTO enrollments(user_id,course_id) VALUES($1,$2)", uid, b.Course); err != nil {
			s.lifecycleError(w, err)
			return
		}
	}
	token, err := issueTokenTx(r.Context(), tx, uid, "invite")
	if err != nil {
		s.lifecycleError(w, err)
		return
	}
	if _, err = tx.Exec(r.Context(), "INSERT INTO admin_audit(actor_id,action,resource) VALUES($1,'Student invited',$2)", p.UserID, uid); err != nil {
		s.lifecycleError(w, err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		s.lifecycleError(w, err)
		return
	}
	httpx.JSON(w, 201, map[string]any{"user_id": uid, "activation_url": s.accountURL("activate", token), "expires_at": time.Now().Add(24 * time.Hour)})
}
func (s *Service) accountLink(w http.ResponseWriter, r *http.Request) {
	p, _ := FromContext(r.Context())
	tx, err := s.Pool.Begin(r.Context())
	if err != nil {
		s.lifecycleError(w, err)
		return
	}
	defer tx.Rollback(context.Background())
	if err = LockPrincipal(r.Context(), tx, p); err != nil {
		s.lifecycleError(w, err)
		return
	}
	var verified, suspended bool
	if err = tx.QueryRow(r.Context(), "SELECT verified,suspended FROM users WHERE id=$1 FOR UPDATE", r.PathValue("id")).Scan(&verified, &suspended); err != nil {
		s.lifecycleError(w, err)
		return
	}
	if suspended {
		httpx.Error(w, 409, "account_suspended", "Suspended accounts cannot receive account links")
		return
	}
	kind, action := "invite", "activate"
	duration := 24 * time.Hour
	if verified {
		kind, action = "reset", "reset"
		duration = time.Hour
	}
	token, err := issueTokenTx(r.Context(), tx, r.PathValue("id"), kind)
	if err != nil {
		s.lifecycleError(w, err)
		return
	}
	if _, err = tx.Exec(r.Context(), "INSERT INTO admin_audit(actor_id,action,resource) VALUES($1,'Account link issued',$2)", p.UserID, r.PathValue("id")); err != nil {
		s.lifecycleError(w, err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		s.lifecycleError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"account_url": s.accountURL(action, token), "expires_at": time.Now().Add(duration), "kind": kind})
}
func (s *Service) adminRevokeSessions(w http.ResponseWriter, r *http.Request) {
	p, _ := FromContext(r.Context())
	tx, err := s.Pool.Begin(r.Context())
	if err != nil {
		s.lifecycleError(w, err)
		return
	}
	defer tx.Rollback(context.Background())
	if err = LockPrincipal(r.Context(), tx, p); err != nil {
		s.lifecycleError(w, err)
		return
	}
	var id string
	if err = tx.QueryRow(r.Context(), "SELECT id FROM users WHERE id=$1 FOR UPDATE", r.PathValue("id")).Scan(&id); err != nil {
		s.lifecycleError(w, err)
		return
	}
	if _, err = tx.Exec(r.Context(), "UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", id); err != nil {
		s.lifecycleError(w, err)
		return
	}
	if _, err = tx.Exec(r.Context(), "INSERT INTO admin_audit(actor_id,action,resource) VALUES($1,'Sessions revoked',$2)", p.UserID, id); err != nil {
		s.lifecycleError(w, err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		s.lifecycleError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]bool{"ok": true})
}
func (s *Service) adminEnrollment(w http.ResponseWriter, r *http.Request) {
	p, _ := FromContext(r.Context())
	var b struct {
		Course   string `json:"course"`
		Enrolled bool   `json:"enrolled"`
	}
	if !httpx.Decode(w, r, &b) {
		return
	}
	if b.Course == "" || len(b.Course) > 512 {
		httpx.Error(w, 422, "invalid_course", "Invalid course")
		return
	}
	tx, err := s.Pool.Begin(r.Context())
	if err != nil {
		s.lifecycleError(w, err)
		return
	}
	defer tx.Rollback(context.Background())
	if err = LockPrincipal(r.Context(), tx, p); err != nil {
		s.lifecycleError(w, err)
		return
	}
	var id string
	if err = tx.QueryRow(r.Context(), "SELECT id FROM users WHERE id=$1 FOR SHARE", r.PathValue("id")).Scan(&id); err != nil {
		s.lifecycleError(w, err)
		return
	}
	if err = tx.QueryRow(r.Context(), "SELECT id FROM courses WHERE id=$1 FOR SHARE", b.Course).Scan(&id); err != nil {
		s.lifecycleError(w, err)
		return
	}
	if b.Enrolled {
		_, err = tx.Exec(r.Context(), "INSERT INTO enrollments(user_id,course_id) VALUES($1,$2) ON CONFLICT DO NOTHING", r.PathValue("id"), b.Course)
	} else {
		_, err = tx.Exec(r.Context(), "DELETE FROM enrollments WHERE user_id=$1 AND course_id=$2", r.PathValue("id"), b.Course)
	}
	if err != nil {
		s.lifecycleError(w, err)
		return
	}
	if _, err = tx.Exec(r.Context(), "INSERT INTO admin_audit(actor_id,action,resource) VALUES($1,'Enrollment changed',$2)", p.UserID, r.PathValue("id")+":"+b.Course); err != nil {
		s.lifecycleError(w, err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		s.lifecycleError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]bool{"ok": true})
}
func (s *Service) adminRole(w http.ResponseWriter, r *http.Request) {
	p, _ := FromContext(r.Context())
	var b struct {
		Role            string `json:"role"`
		CurrentPassword string `json:"current_password"`
	}
	if !httpx.Decode(w, r, &b) {
		return
	}
	if b.Role != "student" && b.Role != "admin" {
		httpx.Error(w, 422, "invalid_role", "Invalid role")
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
	valid := VerifyPassword(hash, b.CurrentPassword)
	<-s.hashSlots
	if !valid {
		httpx.Error(w, 403, "incorrect_password", "Current password is incorrect")
		return
	}
	err := s.changeAccount(r.Context(), p, r.PathValue("id"), &b.Role, nil, hash)
	if errors.Is(err, ErrLastAdmin) {
		httpx.Error(w, 409, "last_admin", err.Error())
		return
	}
	if errors.Is(err, ErrAccountNotActive) {
		httpx.Error(w, 409, "account_inactive", err.Error())
		return
	}
	if err != nil {
		s.lifecycleError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]bool{"ok": true})
}
