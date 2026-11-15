package retention

import (
	"context"
	"testing"
)

func TestActivityAndPlaybackExpiryCloseWithoutCredit(t *testing.T) {
	svc, pool := setup(t)
	ctx := context.Background()
	for _, sql := range []string{
		`INSERT INTO playback_sessions(id,user_id,auth_session_id,lesson_id,token_hash,expires_at,watched_seconds,device_snapshot,ip_snapshot,snapshot_basis)
		 VALUES('ps_exp','alice','aliceauth','lesson','th',now()-interval '1 minute',9,'dev','127.0.0.1','session_open')`,
		`INSERT INTO playback_totals(user_id,lesson_id,watched_seconds,coverage)VALUES('alice','lesson',42,'[]')`,
		`INSERT INTO playback_leases(user_id,session_id,expires_at)VALUES('alice','ps_exp',now()+interval '30 seconds')`,
		`INSERT INTO activity_sessions(id,user_id,auth_session_id,lesson_id,player_session_id,player_bound,
			last_heartbeat,previous_visible,created_at,expires_at,device,ip,activity_seconds)
		 VALUES('act_exp','alice','aliceauth','lesson','ps_exp',true,now(),true,now()-interval '1 hour',now()-interval '1 minute','','',7)`,
		`INSERT INTO activity_leases(user_id,activity_id,expires_at)VALUES('alice','act_exp',now()+interval '20 seconds')`,
		`INSERT INTO lesson_activity_totals(user_id,lesson_id,activity_seconds,updated_at)VALUES('alice','lesson',7,now())`,
	} {
		if _, err := pool.Exec(ctx, sql); err != nil {
			t.Fatal(err)
		}
	}

	// playback_expiry defers while open linked activity remains.
	res, err := svc.Cleanup(ctx, KindPlaybackExpiry, 10)
	if err != nil {
		t.Fatal(err)
	}
	if res.Changed != 0 || res.Deferred == "" {
		t.Fatalf("expected playback deferral, got %+v", res)
	}

	act, err := svc.Cleanup(ctx, KindActivityExpiry, 10)
	if err != nil || act.Changed != 1 {
		t.Fatalf("activity_expiry %+v err=%v", act, err)
	}
	var actClosed bool
	var actLease, playLease int
	_ = pool.QueryRow(ctx, `SELECT closed FROM activity_sessions WHERE id='act_exp'`).Scan(&actClosed)
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM activity_leases WHERE user_id='alice'`).Scan(&actLease)
	if !actClosed || actLease != 0 {
		t.Fatalf("activity not closed cleanly closed=%v leases=%d", actClosed, actLease)
	}

	play, err := svc.Cleanup(ctx, KindPlaybackExpiry, 10)
	if err != nil || play.Changed != 1 {
		t.Fatalf("playback_expiry %+v err=%v", play, err)
	}
	var playClosed bool
	var watched, activity float64
	_ = pool.QueryRow(ctx, `SELECT closed_at IS NOT NULL FROM playback_sessions WHERE id='ps_exp'`).Scan(&playClosed)
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM playback_leases WHERE user_id='alice'`).Scan(&playLease)
	_ = pool.QueryRow(ctx, `SELECT watched_seconds FROM playback_totals WHERE user_id='alice' AND lesson_id='lesson'`).Scan(&watched)
	_ = pool.QueryRow(ctx, `SELECT activity_seconds FROM lesson_activity_totals WHERE user_id='alice' AND lesson_id='lesson'`).Scan(&activity)
	if !playClosed || playLease != 0 || watched != 42 || activity != 7 {
		t.Fatalf("playback close/totals playClosed=%v lease=%d watched=%v activity=%v", playClosed, playLease, watched, activity)
	}
}

func TestAuthSessionsDeferredThenDeletedAfterClose(t *testing.T) {
	svc, pool := setup(t)
	ctx := context.Background()
	for _, sql := range []string{
		`INSERT INTO playback_sessions(id,user_id,auth_session_id,lesson_id,token_hash,expires_at,device_snapshot,snapshot_basis)
		 VALUES('ps_auth','alice','aliceauth','lesson','th',now()+interval '1 hour','dev','session_open')`,
		`UPDATE auth_sessions SET expires_at=now()-interval '1 minute' WHERE id='aliceauth'`,
	} {
		if _, err := pool.Exec(ctx, sql); err != nil {
			t.Fatal(err)
		}
	}

	res, err := svc.Cleanup(ctx, KindAuthSessions, 10)
	if err != nil {
		t.Fatal(err)
	}
	if res.Changed != 0 || res.Deferred == "" {
		t.Fatalf("expected auth deferral while open native exists: %+v", res)
	}

	// Close via playback_expiry (login already expired → missing-live-login).
	play, err := svc.Cleanup(ctx, KindPlaybackExpiry, 10)
	if err != nil || play.Changed != 1 {
		t.Fatalf("playback_expiry for expired login %+v err=%v", play, err)
	}
	res, err = svc.Cleanup(ctx, KindAuthSessions, 10)
	if err != nil || res.Changed != 1 {
		t.Fatalf("auth_sessions after close %+v err=%v", res, err)
	}

	var authN, playN int
	var closed bool
	var basis, device string
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM auth_sessions WHERE id='aliceauth'`).Scan(&authN)
	_ = pool.QueryRow(ctx, `SELECT count(*), bool_or(closed_at IS NOT NULL), min(snapshot_basis), min(device_snapshot)
		FROM playback_sessions WHERE id='ps_auth'`).Scan(&playN, &closed, &basis, &device)
	if authN != 0 || playN != 1 || !closed || basis != "session_open" || device != "dev" {
		t.Fatalf("auth=%d play=%d closed=%v basis=%s device=%s", authN, playN, closed, basis, device)
	}
}

func TestAuthSessionsKeepsRevokedUnexpired(t *testing.T) {
	svc, pool := setup(t)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `UPDATE auth_sessions SET revoked_at=now(), expires_at=now()+interval '1 hour' WHERE id='aliceauth'`); err != nil {
		t.Fatal(err)
	}
	res, err := svc.Cleanup(ctx, KindAuthSessions, 10)
	if err != nil || res.Changed != 0 {
		t.Fatalf("revoked-unexpired should be retained: %+v err=%v", res, err)
	}
	var n int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM auth_sessions WHERE id='aliceauth'`).Scan(&n)
	if n != 1 {
		t.Fatalf("auth row removed: %d", n)
	}
}
