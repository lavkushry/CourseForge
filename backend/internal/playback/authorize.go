package playback

import (
	"context"
	"errors"

	"courseforge/backend/internal/identity"

	"github.com/jackc/pgx/v5"
)

// Media authorization is re-evaluated on every new request and during a stream.
// Queries release their database connection before any upstream byte delivery.
func (s *Service) AuthorizeMedia(ctx context.Context, p identity.Principal, id, mediaToken string) (Source, error) {
	var source Source
	if len(mediaToken) > 100 {
		return source, ErrDenied
	}
	err := s.Pool.QueryRow(ctx, `SELECT ps.lesson_id,COALESCE(lp.claim_name,''),COALESCE(lp.claim_id,''),l.course_id,l.title FROM playback_sessions ps JOIN users u ON u.id=ps.user_id JOIN auth_sessions a ON a.id=ps.auth_session_id JOIN playback_leases pl ON pl.session_id=ps.id AND pl.user_id=u.id JOIN lessons l ON l.id=ps.lesson_id JOIN courses c ON c.id=l.course_id LEFT JOIN lesson_providers lp ON lp.lesson_id=l.id WHERE ps.id=$1 AND ps.token_hash=$2 AND ps.user_id=$3 AND ps.auth_session_id=$4 AND ps.closed_at IS NULL AND ps.expires_at>now() AND pl.expires_at>now() AND a.revoked_at IS NULL AND a.expires_at>now() AND u.verified AND NOT u.suspended AND (u.role='admin' OR (c.published AND EXISTS(SELECT 1 FROM enrollments e WHERE e.user_id=u.id AND e.course_id=c.id)))`, id, digest(mediaToken), p.UserID, p.SessionID).Scan(&source.LessonID, &source.ClaimName, &source.ClaimID, &source.CourseID, &source.Title)
	if errors.Is(err, pgx.ErrNoRows) {
		err = ErrDenied
	}
	return source, err
}
func (s *Service) Active(ctx context.Context, id string) (bool, error) {
	var active bool
	err := s.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM playback_sessions ps JOIN users u ON u.id=ps.user_id JOIN auth_sessions a ON a.id=ps.auth_session_id JOIN playback_leases pl ON pl.session_id=ps.id AND pl.user_id=u.id JOIN lessons l ON l.id=ps.lesson_id JOIN courses c ON c.id=l.course_id WHERE ps.id=$1 AND ps.closed_at IS NULL AND ps.expires_at>now() AND pl.expires_at>now() AND a.revoked_at IS NULL AND a.expires_at>now() AND u.verified AND NOT u.suspended AND (u.role='admin' OR (c.published AND EXISTS(SELECT 1 FROM enrollments e WHERE e.user_id=u.id AND e.course_id=c.id))))`, id).Scan(&active)
	return active, err
}
