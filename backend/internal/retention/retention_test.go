package retention

import (
	"context"
	"testing"

	"courseforge/backend/internal/identity"
	"courseforge/backend/internal/testutil"

	"github.com/jackc/pgx/v5/pgxpool"
)

func setup(t *testing.T) (*Service, *pgxpool.Pool) {
	t.Helper()
	pool := testutil.Postgres(t)
	ctx := context.Background()
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users(id,email,name,password_hash,verified)VALUES
			('alice','alice@test.example','Alice','disabled',true),
			('admin','admin@test.example','Admin','disabled',true)`, nil},
		{`UPDATE users SET role='admin' WHERE id='admin'`, nil},
		{`INSERT INTO auth_sessions(id,user_id,token_hash,csrf_token,expires_at)VALUES
			('aliceauth','alice',$1,'csrf',now()+interval '1 hour')`, []any{identity.Digest("alice-token")}},
		{`INSERT INTO courses(id,title,published)VALUES('course','Course',true)`, nil},
		{`INSERT INTO lessons(id,course_id,title,duration_seconds)VALUES('lesson','course','Lesson',100)`, nil},
		{`INSERT INTO enrollments(user_id,course_id)VALUES('alice','course')`, nil},
	} {
		if _, err := pool.Exec(ctx, q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	return New(pool), pool
}

func TestCleanupRejectsInvalidLimitAndKind(t *testing.T) {
	svc, _ := setup(t)
	ctx := context.Background()
	if _, err := svc.Cleanup(ctx, KindAccessEvents, 0); err == nil {
		t.Fatal("expected limit error")
	}
	if _, err := svc.Cleanup(ctx, Kind("not_a_kind"), 10); err == nil {
		t.Fatal("expected kind error")
	}
}

func TestCleanupAccessEventsAndPlayerTelemetry(t *testing.T) {
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

	access, err := svc.Cleanup(ctx, KindAccessEvents, 100)
	if err != nil || access.Changed != 1 {
		t.Fatalf("access %+v err=%v", access, err)
	}
	tel, err := svc.Cleanup(ctx, KindPlayerTelemetry, 100)
	if err != nil || tel.Changed != 1 {
		t.Fatalf("telemetry %+v err=%v", tel, err)
	}

	var accessN, telOld, telNew int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM access_events`).Scan(&accessN)
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM player_telemetry WHERE session_id='ps_old'`).Scan(&telOld)
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM player_telemetry WHERE session_id='ps_new'`).Scan(&telNew)
	if accessN != 1 || telOld != 0 || telNew != 1 {
		t.Fatalf("accessN=%d telOld=%d telNew=%d", accessN, telOld, telNew)
	}
}

func TestCleanupPlaybackLeasesExpiredAndDeferred(t *testing.T) {
	svc, pool := setup(t)
	ctx := context.Background()
	for _, sql := range []string{
		`INSERT INTO playback_sessions(id,user_id,auth_session_id,lesson_id,token_hash,expires_at,closed_at)
		VALUES
			('ps_expired','alice','aliceauth','lesson','th1',now()-interval '1 hour',NULL),
			('ps_live','alice','aliceauth','lesson','th2',now()+interval '1 hour',NULL)`,
		`INSERT INTO playback_leases(user_id,session_id,expires_at)VALUES('alice','ps_expired',now()-interval '1 minute')`,
		`INSERT INTO activity_sessions(id,user_id,auth_session_id,lesson_id,player_session_id,player_bound,
			last_heartbeat,previous_visible,created_at,expires_at,device,ip)
		VALUES('act1','alice','aliceauth','lesson','ps_expired',true,now(),true,now()-interval '1 hour',now()+interval '5 hours','','')`,
		`INSERT INTO activity_leases(user_id,activity_id,expires_at)VALUES('alice','act1',now()+interval '20 seconds')`,
	} {
		if _, err := pool.Exec(ctx, sql); err != nil {
			t.Fatal(err)
		}
	}

	// Open linked activity should defer lease removal.
	res, err := svc.Cleanup(ctx, KindPlaybackLeases, 10)
	if err != nil {
		t.Fatal(err)
	}
	if res.Changed != 0 || res.Deferred == "" {
		t.Fatalf("expected deferral, got %+v", res)
	}
	var leaseN int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM playback_leases WHERE user_id='alice'`).Scan(&leaseN)
	if leaseN != 1 {
		t.Fatalf("lease removed despite open activity: %d", leaseN)
	}

	// Close activity, then lease cleanup proceeds.
	if _, err := pool.Exec(ctx, `UPDATE activity_sessions SET closed=true WHERE id='act1'`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM activity_leases WHERE user_id='alice'`); err != nil {
		t.Fatal(err)
	}
	res, err = svc.Cleanup(ctx, KindPlaybackLeases, 10)
	if err != nil || res.Changed != 1 {
		t.Fatalf("after close %+v err=%v", res, err)
	}
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM playback_leases WHERE user_id='alice'`).Scan(&leaseN)
	if leaseN != 0 {
		t.Fatalf("expired lease remained: %d", leaseN)
	}
}

func TestCleanupPlaybackDetailPreservesTotals(t *testing.T) {
	svc, pool := setup(t)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `
		INSERT INTO playback_sessions(id,user_id,auth_session_id,lesson_id,token_hash,expires_at,created_at,closed_at,watched_seconds)
		VALUES('ps_old','alice','aliceauth','lesson','th',now()-interval '1 day',now()-interval '100 days',now()-interval '100 days',12)`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO playback_totals(user_id,lesson_id,watched_seconds,coverage)
		VALUES('alice','lesson',42,'[]')`); err != nil {
		t.Fatal(err)
	}
	res, err := svc.Cleanup(ctx, KindPlaybackDetail, 10)
	if err != nil || res.Changed != 1 {
		t.Fatalf("detail %+v err=%v", res, err)
	}
	var sessions int
	var watched float64
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM playback_sessions WHERE id='ps_old'`).Scan(&sessions)
	_ = pool.QueryRow(ctx, `SELECT watched_seconds FROM playback_totals WHERE user_id='alice' AND lesson_id='lesson'`).Scan(&watched)
	if sessions != 0 || watched != 42 {
		t.Fatalf("sessions=%d watched=%v", sessions, watched)
	}
}

func TestCleanupIdempotentEmptyBatch(t *testing.T) {
	svc, _ := setup(t)
	ctx := context.Background()
	res, err := svc.Cleanup(ctx, KindAccessEvents, 10)
	if err != nil || res.Changed != 0 {
		t.Fatalf("empty %+v err=%v", res, err)
	}
}
