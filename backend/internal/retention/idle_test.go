package retention

import (
	"context"
	"testing"
)

func TestIdleSweepDrainsOrderedKindsAndPrunesTelemetry(t *testing.T) {
	svc, pool := setup(t)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `
		INSERT INTO access_events(user_id,event_type,created_at)VALUES
			('alice','sign_in',now()-interval '40 days'),
			('alice','sign_in',now()-interval '1 day')`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO player_telemetry(user_id,session_id,startup_ms,rebuffer_ms,play_ms,errors,bitrate_switches,created_at)VALUES
			('alice','ps_old',100,0,1000,0,0,now()-interval '10 days'),
			('alice','ps_new',200,0,1000,0,0,now()-interval '1 hour')`); err != nil {
		t.Fatal(err)
	}

	stats, err := svc.IdleSweep(ctx, IdleBatchLimit)
	if err != nil {
		t.Fatal(err)
	}
	if stats.KindsRun != len(DrainOrder) {
		t.Fatalf("kinds_run=%d want %d", stats.KindsRun, len(DrainOrder))
	}
	if stats.ByKind[string(KindAccessEvents)] < 1 || stats.ByKind[string(KindPlayerTelemetry)] < 1 {
		t.Fatalf("expected access+telemetry prune, got %+v", stats.ByKind)
	}
	if stats.Changed < 2 {
		t.Fatalf("changed=%d", stats.Changed)
	}

	var accessN, telOld, telNew int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM access_events`).Scan(&accessN)
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM player_telemetry WHERE session_id='ps_old'`).Scan(&telOld)
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM player_telemetry WHERE session_id='ps_new'`).Scan(&telNew)
	if accessN != 1 || telOld != 0 || telNew != 1 {
		t.Fatalf("accessN=%d telOld=%d telNew=%d", accessN, telOld, telNew)
	}

	// Idempotent second pass returns zero changes for those kinds.
	again, err := svc.IdleSweep(ctx, IdleBatchLimit)
	if err != nil {
		t.Fatal(err)
	}
	if again.ByKind[string(KindAccessEvents)] != 0 || again.ByKind[string(KindPlayerTelemetry)] != 0 {
		t.Fatalf("second pass should be empty for pruned kinds: %+v", again.ByKind)
	}
}

func TestIdleSweepLimitDefaultsAndCaps(t *testing.T) {
	svc, _ := setup(t)
	ctx := context.Background()
	if _, err := svc.IdleSweep(ctx, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.IdleSweep(ctx, 5000); err != nil {
		t.Fatal(err)
	}
}
