package playback

import (
	"context"
	"testing"
	"time"
)

func TestPruneTelemetryRemovesExpiredOnly(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	id, _ := f.open(t, "alice", false)

	_, err := f.pool.Exec(ctx, `
		INSERT INTO player_telemetry(user_id,session_id,lesson_id,startup_ms,rebuffer_ms,play_ms,errors,bitrate_switches,created_at)
		VALUES
		('alice',$1,'lesson',100,0,1000,0,0,now()-interval '10 days'),
		('alice',$1,'lesson',200,0,1000,0,0,now()-interval '1 hour')`, id)
	if err != nil {
		t.Fatal(err)
	}

	n, err := f.svc.PruneTelemetry(ctx, TelemetryRetention, 100)
	if err != nil || n != 1 {
		t.Fatalf("prune n=%d err=%v", n, err)
	}

	var oldN, freshN, watched float64
	var count int
	if e := f.pool.QueryRow(ctx, `SELECT count(*) FROM player_telemetry WHERE session_id=$1 AND startup_ms=100`, id).Scan(&oldN); e != nil {
		t.Fatal(e)
	}
	if e := f.pool.QueryRow(ctx, `SELECT count(*) FROM player_telemetry WHERE session_id=$1 AND startup_ms=200`, id).Scan(&freshN); e != nil {
		t.Fatal(e)
	}
	if e := f.pool.QueryRow(ctx, `SELECT watched_seconds FROM playback_totals WHERE user_id='alice' AND lesson_id='lesson'`).Scan(&watched); e != nil {
		t.Fatal(e)
	}
	if e := f.pool.QueryRow(ctx, `SELECT count(*) FROM playback_sessions WHERE id=$1`, id).Scan(&count); e != nil {
		t.Fatal(e)
	}
	if oldN != 0 || freshN != 1 {
		t.Fatalf("old=%v fresh=%v", oldN, freshN)
	}
	if count != 1 {
		t.Fatalf("session deleted by telemetry prune: %d", count)
	}
	_ = watched // lifetime totals must remain queryable
}

func TestPruneTelemetryRejectsInvalidLimitDefaults(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	n, err := f.svc.PruneTelemetry(ctx, time.Hour, 0)
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("empty prune n=%d", n)
	}
}
