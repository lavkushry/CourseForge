package access

import (
	"context"
	"errors"

	"courseforge/backend/internal/identity"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// CanLesson never relies on a process-local enrollment cache.
func CanLesson(ctx context.Context, pool *pgxpool.Pool, userID, role, lessonID string) (bool, error) {
	var allowed bool
	err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM lessons l JOIN courses c ON c.id=l.course_id WHERE l.id=$1 AND ($3='admin' OR (c.published AND EXISTS(SELECT 1 FROM enrollments e WHERE e.user_id=$2 AND e.course_id=c.id))))`, lessonID, userID, role).Scan(&allowed)
	return allowed, err
}

// LessonWrite locks authoritative access rows for the short write transaction.
// Revocation, enrollment removal and unpublication cannot race an acknowledgement.
func LessonWrite(ctx context.Context, tx pgx.Tx, p identity.Principal, lessonID string) error {
	if err := identity.LockPrincipal(ctx, tx, p); err != nil {
		return err
	}
	var courseID string
	var published bool
	if err := tx.QueryRow(ctx, `SELECT c.id,c.published FROM lessons l JOIN courses c ON c.id=l.course_id WHERE l.id=$1 FOR SHARE OF l,c`, lessonID).Scan(&courseID, &published); err != nil {
		return err
	}
	if p.Role == "admin" {
		return nil
	}
	if !published {
		return pgx.ErrNoRows
	}
	var id string
	return tx.QueryRow(ctx, "SELECT user_id FROM enrollments WHERE user_id=$1 AND course_id=$2 FOR SHARE", p.UserID, courseID).Scan(&id)
}
func IsDenied(err error) bool { return errors.Is(err, pgx.ErrNoRows) }
