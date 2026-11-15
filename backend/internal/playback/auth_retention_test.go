package playback

import (
	"context"
	"testing"
	"time"
)

func TestDeletingAuthSessionPreservesNativeDetailAndTotals(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	id, _ := f.open(t, "alice", false)
	f.baseline(t, id, f.now.Add(-10*time.Second), 0, true)
	f.pulse(t, "alice", id, Pulse{
		Sequence: 1, Kind: "playing", Position: 5, ElapsedSeconds: 5,
		Playing: true, Visible: true, PlaybackRate: 1,
	})

	var watchedBefore float64
	if err := f.pool.QueryRow(ctx, `SELECT watched_seconds FROM playback_totals WHERE user_id='alice' AND lesson_id='lesson'`).Scan(&watchedBefore); err != nil {
		t.Fatal(err)
	}
	if watchedBefore <= 0 {
		t.Fatalf("expected watch credit before auth delete, got %v", watchedBefore)
	}

	if _, err := f.pool.Exec(ctx, `DELETE FROM auth_sessions WHERE id='aliceauth'`); err != nil {
		t.Fatal(err)
	}

	var sessions, leases int
	var closed bool
	var basis, device string
	var watchedAfter float64
	if err := f.pool.QueryRow(ctx, `SELECT count(*) FROM playback_sessions WHERE id=$1`, id).Scan(&sessions); err != nil {
		t.Fatal(err)
	}
	if err := f.pool.QueryRow(ctx, `SELECT closed_at IS NOT NULL, snapshot_basis, device_snapshot FROM playback_sessions WHERE id=$1`, id).Scan(&closed, &basis, &device); err != nil {
		t.Fatal(err)
	}
	if err := f.pool.QueryRow(ctx, `SELECT count(*) FROM playback_leases WHERE user_id='alice'`).Scan(&leases); err != nil {
		t.Fatal(err)
	}
	if err := f.pool.QueryRow(ctx, `SELECT watched_seconds FROM playback_totals WHERE user_id='alice' AND lesson_id='lesson'`).Scan(&watchedAfter); err != nil {
		t.Fatal(err)
	}
	if sessions != 1 || !closed || leases != 0 || watchedAfter != watchedBefore {
		t.Fatalf("auth delete wiped ownership incorrectly sessions=%d closed=%v leases=%d watched %v→%v",
			sessions, closed, leases, watchedBefore, watchedAfter)
	}
	if basis != "session_open" {
		t.Fatalf("snapshot_basis=%s", basis)
	}
	// Live media auth must fail after login deletion (binding closed; login gone).
	code, body := f.call(t, "alice", "POST", "/api/v1/playback/sessions/"+id+"/pulse", Pulse{
		Sequence: 2, Kind: "playing", Position: 6, ElapsedSeconds: 1,
		Playing: true, Visible: true, PlaybackRate: 1,
	})
	if code == 200 {
		t.Fatalf("pulse after auth delete must not succeed: %s", body)
	}
}

func TestRevokingAuthSessionClosesBindingsWithoutWipingDetail(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	id, _ := f.open(t, "alice", false)
	f.baseline(t, id, f.now.Add(-10*time.Second), 0, true)
	f.pulse(t, "alice", id, Pulse{
		Sequence: 1, Kind: "playing", Position: 5, ElapsedSeconds: 5,
		Playing: true, Visible: true, PlaybackRate: 1,
	})

	var watchedBefore float64
	if err := f.pool.QueryRow(ctx, `SELECT watched_seconds FROM playback_totals WHERE user_id='alice' AND lesson_id='lesson'`).Scan(&watchedBefore); err != nil {
		t.Fatal(err)
	}
	if watchedBefore <= 0 {
		t.Fatalf("expected watch credit before revoke, got %v", watchedBefore)
	}

	if _, err := f.pool.Exec(ctx, `UPDATE auth_sessions SET revoked_at=now() WHERE id='aliceauth' AND revoked_at IS NULL`); err != nil {
		t.Fatal(err)
	}

	var sessions, leases, authN int
	var closed bool
	var basis, device string
	var watchedAfter float64
	if err := f.pool.QueryRow(ctx, `SELECT count(*) FROM playback_sessions WHERE id=$1`, id).Scan(&sessions); err != nil {
		t.Fatal(err)
	}
	if err := f.pool.QueryRow(ctx, `SELECT closed_at IS NOT NULL, snapshot_basis, device_snapshot FROM playback_sessions WHERE id=$1`, id).Scan(&closed, &basis, &device); err != nil {
		t.Fatal(err)
	}
	if err := f.pool.QueryRow(ctx, `SELECT count(*) FROM playback_leases WHERE user_id='alice'`).Scan(&leases); err != nil {
		t.Fatal(err)
	}
	if err := f.pool.QueryRow(ctx, `SELECT watched_seconds FROM playback_totals WHERE user_id='alice' AND lesson_id='lesson'`).Scan(&watchedAfter); err != nil {
		t.Fatal(err)
	}
	if err := f.pool.QueryRow(ctx, `SELECT count(*) FROM auth_sessions WHERE id='aliceauth' AND revoked_at IS NOT NULL`).Scan(&authN); err != nil {
		t.Fatal(err)
	}
	if sessions != 1 || !closed || leases != 0 || watchedAfter != watchedBefore || authN != 1 {
		t.Fatalf("revoke wiped ownership incorrectly sessions=%d closed=%v leases=%d watched %v→%v auth=%d",
			sessions, closed, leases, watchedBefore, watchedAfter, authN)
	}
	if basis != "session_open" {
		t.Fatalf("snapshot_basis=%s", basis)
	}

	// Second revoke is a no-op (already revoked); detail stays.
	if _, err := f.pool.Exec(ctx, `UPDATE auth_sessions SET revoked_at=now() WHERE id='aliceauth'`); err != nil {
		t.Fatal(err)
	}
	if err := f.pool.QueryRow(ctx, `SELECT count(*) FROM playback_sessions WHERE id=$1`, id).Scan(&sessions); err != nil || sessions != 1 {
		t.Fatalf("repeat revoke affected detail: %d %v", sessions, err)
	}

	code, body := f.call(t, "alice", "POST", "/api/v1/playback/sessions/"+id+"/pulse", Pulse{
		Sequence: 2, Kind: "playing", Position: 6, ElapsedSeconds: 1,
		Playing: true, Visible: true, PlaybackRate: 1,
	})
	if code == 200 {
		t.Fatalf("pulse after auth revoke must not succeed: %s", body)
	}
}

func TestPlaybackSnapshotImmutable(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	id, _ := f.open(t, "alice", false)
	_, err := f.pool.Exec(ctx, `UPDATE playback_sessions SET device_snapshot='mutated' WHERE id=$1`, id)
	if err == nil {
		t.Fatal("expected immutability error")
	}
}

func TestClipSnapshot(t *testing.T) {
	got, cut := clipSnapshot("abc", 10)
	if got != "abc" || cut {
		t.Fatalf("short clip %q %v", got, cut)
	}
	runes := make([]rune, 230)
	for i := range runes {
		runes[i] = 'x'
	}
	got, cut = clipSnapshot(string(runes), 220)
	if !cut || len([]rune(got)) != 220 {
		t.Fatalf("long clip len=%d cut=%v", len([]rune(got)), cut)
	}
}
