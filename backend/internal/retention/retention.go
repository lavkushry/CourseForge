// Package retention provides the SQL-only bounded cleanup seam from
// docs/rewrite/RETENTION_CONTRACT.md. Callers invoke Cleanup with a known kind
// and limit. The job worker may run IdleSweep while its claim loop is empty;
// there is still no HTTP cleanup route and no API-process startup cleanup.
package retention

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Kind identifies one bounded cleanup batch.
type Kind string

const (
	KindActivityExpiry     Kind = "activity_expiry"
	KindPlaybackExpiry     Kind = "playback_expiry"
	KindActivityLeases     Kind = "activity_leases"
	KindPlaybackLeases     Kind = "playback_leases"
	KindActivityDetail     Kind = "activity_detail"
	KindPlaybackDetail     Kind = "playback_detail"
	KindAuthSessions       Kind = "auth_sessions"
	KindAccessEvents       Kind = "access_events"
	KindAdminAudit         Kind = "admin_audit"
	KindAccountTokens      Kind = "account_tokens"
	KindLoginLimits        Kind = "login_limits"
	KindActivityOpenLimits Kind = "activity_open_limits"
	KindPlayerTelemetry    Kind = "player_telemetry"
)

// Result is returned without private IDs, snapshots, tokens, or audit resources.
type Result struct {
	Kind      string    `json:"kind"`
	Changed   int64     `json:"changed"`
	ServerNow time.Time `json:"server_now"`
	Cutoff    time.Time `json:"cutoff,omitempty"`
	Deferred  string    `json:"deferred,omitempty"`
}

// Service owns the cleanup seam. Now is injectable for tests.
type Service struct {
	Pool *pgxpool.Pool
	Now  func() time.Time
}

// New builds a retention service. Pool must already have migrations applied.
func New(pool *pgxpool.Pool) *Service {
	return &Service{Pool: pool, Now: time.Now}
}

func (s *Service) now() time.Time {
	if s.Now == nil {
		return time.Now().UTC()
	}
	return s.Now().UTC()
}

// Cleanup runs one bounded batch for kind. Limit must be 1..1000. Invalid kinds
// and limits fail before writes. One transaction and a five-second bound apply.
func (s *Service) Cleanup(ctx context.Context, kind Kind, limit int) (Result, error) {
	res := Result{Kind: string(kind), ServerNow: s.now()}
	if limit < 1 || limit > 1000 {
		return res, errors.New("retention cleanup limit must be 1..1000")
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return res, err
	}
	defer tx.Rollback(ctx)

	switch kind {
	case KindActivityExpiry:
		// Close open page sessions whose detail window, login, or bound player
		// is expired/revoked/missing; clear matching leases only.
		err = tx.QueryRow(ctx, `
			WITH candidates AS (
				SELECT a.id, a.user_id
				FROM activity_sessions a
				WHERE NOT a.closed
				  AND (
					a.expires_at <= $1
					OR NOT EXISTS (
						SELECT 1 FROM auth_sessions s
						WHERE s.id=a.auth_session_id AND s.user_id=a.user_id
						  AND s.revoked_at IS NULL AND s.expires_at > $1
					)
					OR (
						a.player_bound AND (
							a.player_session_id IS NULL
							OR NOT EXISTS (
								SELECT 1 FROM playback_sessions ps
								WHERE ps.id=a.player_session_id AND ps.user_id=a.user_id
								  AND ps.closed_at IS NULL AND ps.expires_at > $1
							)
						)
					)
				  )
				ORDER BY a.expires_at ASC, a.id ASC
				LIMIT $2
				FOR UPDATE OF a
			),
			leases AS (
				DELETE FROM activity_leases al USING candidates c
				WHERE al.activity_id=c.id AND al.user_id=c.user_id
				RETURNING al.user_id
			),
			closed AS (
				UPDATE activity_sessions a
				SET closed=true, previous_visible=false
				FROM candidates c WHERE a.id=c.id
				RETURNING a.id
			)
			SELECT count(*) FROM closed`, res.ServerNow, limit).Scan(&res.Changed)
	case KindPlaybackExpiry:
		// Close expired/revoked/missing-login native sessions only after bound
		// open activity is closed; clear matching native leases.
		var deferred int64
		err = tx.QueryRow(ctx, `
			WITH candidates AS (
				SELECT ps.id, ps.user_id
				FROM playback_sessions ps
				WHERE ps.closed_at IS NULL
				  AND (
					ps.expires_at <= $1
					OR NOT EXISTS (
						SELECT 1 FROM auth_sessions s
						WHERE s.id=ps.auth_session_id AND s.user_id=ps.user_id
						  AND s.revoked_at IS NULL AND s.expires_at > $1
					)
				  )
				ORDER BY ps.expires_at ASC, ps.id ASC
				LIMIT $2
				FOR UPDATE OF ps
			),
			blocked AS (
				SELECT c.id FROM candidates c
				WHERE EXISTS (
					SELECT 1 FROM activity_sessions a
					WHERE a.player_session_id=c.id AND a.user_id=c.user_id
					  AND NOT a.closed
				)
			),
			doomed AS (
				SELECT c.id, c.user_id FROM candidates c
				WHERE NOT EXISTS (SELECT 1 FROM blocked b WHERE b.id=c.id)
			),
			leases AS (
				DELETE FROM playback_leases pl USING doomed d
				WHERE pl.session_id=d.id AND pl.user_id=d.user_id
				RETURNING pl.user_id
			),
			closed AS (
				UPDATE playback_sessions ps
				SET closed_at=$1, baseline_playing=false, baseline_visible=false
				FROM doomed d WHERE ps.id=d.id AND ps.closed_at IS NULL
				RETURNING ps.id
			)
			SELECT
				(SELECT count(*) FROM closed),
				(SELECT count(*) FROM blocked)`,
			res.ServerNow, limit).Scan(&res.Changed, &deferred)
		if err == nil && deferred > 0 {
			res.Deferred = fmt.Sprintf("%d native session(s) deferred until open linked activity is closed", deferred)
		}
	case KindAuthSessions:
		// Delete expired logins only when matching open native/activity and
		// leases are already closed/removed. Revoked-but-unexpired stay.
		var deferred int64
		err = tx.QueryRow(ctx, `
			WITH candidates AS (
				SELECT s.id, s.user_id
				FROM auth_sessions s
				WHERE s.expires_at <= $1
				ORDER BY s.expires_at ASC, s.id ASC
				LIMIT $2
				FOR UPDATE OF s
			),
			blocked AS (
				SELECT c.id FROM candidates c
				WHERE EXISTS (
					SELECT 1 FROM playback_sessions ps
					WHERE ps.auth_session_id=c.id AND ps.user_id=c.user_id
					  AND ps.closed_at IS NULL
				) OR EXISTS (
					SELECT 1 FROM activity_sessions a
					WHERE a.auth_session_id=c.id AND a.user_id=c.user_id
					  AND NOT a.closed
				) OR EXISTS (
					SELECT 1 FROM playback_leases pl
					JOIN playback_sessions ps ON ps.id=pl.session_id
					WHERE ps.auth_session_id=c.id AND ps.user_id=c.user_id
				) OR EXISTS (
					SELECT 1 FROM activity_leases al
					JOIN activity_sessions a ON a.id=al.activity_id AND a.user_id=al.user_id
					WHERE a.auth_session_id=c.id AND a.user_id=c.user_id
				)
			),
			doomed AS (
				SELECT c.id FROM candidates c
				WHERE NOT EXISTS (SELECT 1 FROM blocked b WHERE b.id=c.id)
			),
			deleted AS (
				DELETE FROM auth_sessions s USING doomed d WHERE s.id=d.id
				RETURNING s.id
			)
			SELECT
				(SELECT count(*) FROM deleted),
				(SELECT count(*) FROM blocked)`,
			res.ServerNow, limit).Scan(&res.Changed, &deferred)
		if err == nil && deferred > 0 {
			res.Deferred = fmt.Sprintf("%d login(s) deferred until open native/activity/leases are closed", deferred)
		}
	case KindAccessEvents:
		res.Cutoff = res.ServerNow.Add(-30 * 24 * time.Hour)
		err = tx.QueryRow(ctx, `
			WITH doomed AS (
				SELECT id FROM access_events
				WHERE created_at < $1
				ORDER BY created_at ASC, id ASC
				LIMIT $2
			),
			deleted AS (
				DELETE FROM access_events a USING doomed d WHERE a.id=d.id RETURNING a.id
			)
			SELECT count(*) FROM deleted`, res.Cutoff, limit).Scan(&res.Changed)
	case KindAdminAudit:
		res.Cutoff = res.ServerNow.Add(-90 * 24 * time.Hour)
		err = tx.QueryRow(ctx, `
			WITH doomed AS (
				SELECT id FROM admin_audit
				WHERE created_at < $1
				ORDER BY created_at ASC, id ASC
				LIMIT $2
			),
			deleted AS (
				DELETE FROM admin_audit a USING doomed d WHERE a.id=d.id RETURNING a.id
			)
			SELECT count(*) FROM deleted`, res.Cutoff, limit).Scan(&res.Changed)
	case KindAccountTokens:
		err = tx.QueryRow(ctx, `
			WITH doomed AS (
				SELECT token_hash FROM account_tokens
				WHERE expires_at <= $1
				ORDER BY expires_at ASC, token_hash ASC
				LIMIT $2
			),
			deleted AS (
				DELETE FROM account_tokens t USING doomed d WHERE t.token_hash=d.token_hash
				RETURNING t.token_hash
			)
			SELECT count(*) FROM deleted`, res.ServerNow, limit).Scan(&res.Changed)
	case KindLoginLimits:
		err = tx.QueryRow(ctx, `
			WITH doomed AS (
				SELECT key FROM login_limits
				WHERE reset_at <= $1
				ORDER BY reset_at ASC, key ASC
				LIMIT $2
			),
			deleted AS (
				DELETE FROM login_limits l USING doomed d WHERE l.key=d.key RETURNING l.key
			)
			SELECT count(*) FROM deleted`, res.ServerNow, limit).Scan(&res.Changed)
	case KindActivityOpenLimits:
		res.Cutoff = res.ServerNow.Add(-2 * time.Minute)
		err = tx.QueryRow(ctx, `
			WITH doomed AS (
				SELECT user_id FROM activity_open_limits
				WHERE window_start < $1
				ORDER BY window_start ASC, user_id ASC
				LIMIT $2
			),
			deleted AS (
				DELETE FROM activity_open_limits a USING doomed d WHERE a.user_id=d.user_id
				RETURNING a.user_id
			)
			SELECT count(*) FROM deleted`, res.Cutoff, limit).Scan(&res.Changed)
	case KindActivityLeases:
		err = tx.QueryRow(ctx, `
			WITH doomed AS (
				SELECT a.user_id, a.activity_id
				FROM activity_leases a
				JOIN activity_sessions s ON s.id=a.activity_id AND s.user_id=a.user_id
				WHERE a.expires_at <= $1 OR s.closed OR s.expires_at <= $1
				ORDER BY a.expires_at ASC, a.user_id ASC
				LIMIT $2
			),
			baselines AS (
				UPDATE activity_sessions s SET previous_visible=false
				FROM doomed d WHERE s.id=d.activity_id AND s.user_id=d.user_id
				RETURNING s.id
			),
			deleted AS (
				DELETE FROM activity_leases a USING doomed d WHERE a.user_id=d.user_id
				RETURNING a.user_id
			)
			SELECT count(*) FROM deleted`, res.ServerNow, limit).Scan(&res.Changed)
	case KindPlaybackLeases:
		var deferred int64
		err = tx.QueryRow(ctx, `
			WITH candidates AS (
				SELECT pl.user_id, pl.session_id
				FROM playback_leases pl
				JOIN playback_sessions ps ON ps.id=pl.session_id
				WHERE pl.expires_at <= $1 OR ps.closed_at IS NOT NULL OR ps.expires_at <= $1
				ORDER BY pl.expires_at ASC, pl.user_id ASC
				LIMIT $2
			),
			blocked AS (
				SELECT c.user_id FROM candidates c
				WHERE EXISTS (
					SELECT 1 FROM activity_sessions a
					WHERE a.player_session_id=c.session_id AND a.user_id=c.user_id
					  AND NOT a.closed
				)
			),
			doomed AS (
				SELECT c.user_id, c.session_id FROM candidates c
				WHERE NOT EXISTS (SELECT 1 FROM blocked b WHERE b.user_id=c.user_id)
			),
			baselines AS (
				UPDATE playback_sessions ps
				SET baseline_at=$1, baseline_playing=false, baseline_visible=false
				FROM doomed d WHERE ps.id=d.session_id
				RETURNING ps.id
			),
			deleted AS (
				DELETE FROM playback_leases pl USING doomed d WHERE pl.user_id=d.user_id
				RETURNING pl.user_id
			)
			SELECT
				(SELECT count(*) FROM deleted),
				(SELECT count(*) FROM blocked)`,
			res.ServerNow, limit).Scan(&res.Changed, &deferred)
		if err == nil && deferred > 0 {
			res.Deferred = fmt.Sprintf("%d lease(s) deferred until open linked activity is closed", deferred)
		}
	case KindActivityDetail:
		res.Cutoff = res.ServerNow.Add(-90 * 24 * time.Hour)
		err = tx.QueryRow(ctx, `
			WITH doomed AS (
				SELECT id FROM activity_sessions
				WHERE created_at < $1 AND (closed OR expires_at < $1)
				ORDER BY created_at ASC, id ASC
				LIMIT $2
			),
			deleted AS (
				DELETE FROM activity_sessions a USING doomed d WHERE a.id=d.id RETURNING a.id
			)
			SELECT count(*) FROM deleted`, res.Cutoff, limit).Scan(&res.Changed)
	case KindPlaybackDetail:
		res.Cutoff = res.ServerNow.Add(-90 * 24 * time.Hour)
		err = tx.QueryRow(ctx, `
			WITH doomed AS (
				SELECT ps.id FROM playback_sessions ps
				WHERE ps.created_at < $1
				  AND (ps.closed_at IS NOT NULL OR ps.expires_at < $1)
				  AND NOT EXISTS (SELECT 1 FROM playback_leases pl WHERE pl.session_id=ps.id)
				  AND NOT EXISTS (SELECT 1 FROM activity_sessions a WHERE a.player_session_id=ps.id)
				ORDER BY ps.created_at ASC, ps.id ASC
				LIMIT $2
			),
			deleted AS (
				DELETE FROM playback_sessions ps USING doomed d WHERE ps.id=d.id RETURNING ps.id
			)
			SELECT count(*) FROM deleted`, res.Cutoff, limit).Scan(&res.Changed)
	case KindPlayerTelemetry:
		res.Cutoff = res.ServerNow.Add(-7 * 24 * time.Hour)
		err = tx.QueryRow(ctx, `
			WITH doomed AS (
				SELECT id FROM player_telemetry
				WHERE created_at < $1
				ORDER BY created_at ASC, id ASC
				LIMIT $2
			),
			deleted AS (
				DELETE FROM player_telemetry t USING doomed d WHERE t.id=d.id RETURNING t.id
			)
			SELECT count(*) FROM deleted`, res.Cutoff, limit).Scan(&res.Changed)
	default:
		return res, fmt.Errorf("unknown retention kind %q", kind)
	}

	if err != nil {
		return res, err
	}
	if err = tx.Commit(ctx); err != nil {
		return res, err
	}
	return res, nil
}
