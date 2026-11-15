package migrate

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// InvalidateUserSessions revokes active auth sessions for the given user IDs.
// Used after cutover so legacy cookies cannot continue (rewrite plan cutover policy).
func InvalidateUserSessions(ctx context.Context, pool *pgxpool.Pool, userIDs []string) (int64, error) {
	if pool == nil {
		return 0, errors.New("nil pool")
	}
	if len(userIDs) == 0 {
		return 0, nil
	}
	tag, err := pool.Exec(ctx, `
		UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at, now())
		WHERE user_id = ANY($1) AND revoked_at IS NULL`, userIDs)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// InvalidateAllSessions revokes every non-revoked auth session (full cutover rehearsal).
func InvalidateAllSessions(ctx context.Context, pool *pgxpool.Pool) (int64, error) {
	if pool == nil {
		return 0, errors.New("nil pool")
	}
	tag, err := pool.Exec(ctx, `
		UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at, $1)
		WHERE revoked_at IS NULL`, time.Now().UTC())
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}
