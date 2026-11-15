package playback

import (
	"context"
	"encoding/json"
	"sync"
	"sync/atomic"
	"testing"
)

// Multi-tab lease edges aligned with rewrite ownership: no silent reclaim,
// concurrent open without takeover yields exactly one owner, release frees the
// account-wide lease so another deliberate open can proceed.
func TestConcurrentOpenWithoutTakeoverSingleOwner(t *testing.T) {
	f := setup(t)
	const n = 16
	var wg sync.WaitGroup
	var wins atomic.Int64
	var conflicts atomic.Int64
	ids := make(chan string, n)
	wg.Add(n)
	for range n {
		go func() {
			defer wg.Done()
			code, body := f.call(t, "alice", "POST", "/api/v1/playback/sessions", map[string]any{"lesson_id": "lesson", "take_over": false})
			switch code {
			case 201:
				wins.Add(1)
				var v struct {
					ID string `json:"id"`
				}
				_ = json.Unmarshal(body, &v)
				ids <- v.ID
			case 409:
				conflicts.Add(1)
			default:
				t.Errorf("unexpected open %d %s", code, body)
			}
		}()
	}
	wg.Wait()
	close(ids)
	if wins.Load() != 1 {
		t.Fatalf("concurrent open winners=%d want 1", wins.Load())
	}
	if conflicts.Load() != int64(n-1) {
		t.Fatalf("conflicts=%d want %d", conflicts.Load(), n-1)
	}
	var owner string
	var count int
	if err := f.pool.QueryRow(context.Background(), `SELECT session_id, count(*) OVER() FROM playback_leases WHERE user_id='alice' AND expires_at>now()`).Scan(&owner, &count); err != nil || count != 1 || owner == "" {
		t.Fatalf("lease owner=%q count=%d err=%v", owner, count, err)
	}
	seen := 0
	for id := range ids {
		seen++
		if id != owner {
			t.Fatalf("winning response id %s != lease %s", id, owner)
		}
	}
	if seen != 1 {
		t.Fatalf("collected %d winning ids", seen)
	}
}

func TestReleaseFreesLeaseForDeliberateOpenWithoutTakeover(t *testing.T) {
	f := setup(t)
	id, _ := f.open(t, "alice", false)
	code, body := f.call(t, "alice", "POST", "/api/v1/playback/sessions/"+id+"/release", nil)
	if code != 200 {
		t.Fatalf("release %d %s", code, body)
	}
	var still bool
	_ = f.pool.QueryRow(context.Background(), `SELECT EXISTS(SELECT 1 FROM playback_leases WHERE user_id='alice' AND expires_at>now())`).Scan(&still)
	if still {
		t.Fatal("lease remained after release")
	}
	// Another tab may open without take_over once the account lease is free.
	next, _ := f.open(t, "alice", false)
	if next == id {
		t.Fatal("expected a fresh session id after release+open")
	}
	var owner string
	if err := f.pool.QueryRow(context.Background(), `SELECT session_id FROM playback_leases WHERE user_id='alice' AND expires_at>now()`).Scan(&owner); err != nil || owner != next {
		t.Fatalf("lease owner=%q want %s err=%v", owner, next, err)
	}
}

func TestClaimWithoutTakeoverConflictsWhenOtherTabOwns(t *testing.T) {
	f := setup(t)
	first, _ := f.open(t, "alice", false)
	// Simulate a second tab that opened earlier then released ownership via hidden
	// but kept the session row; reclaiming first while second holds the lease conflicts.
	second, _ := f.open(t, "alice", true)
	code, body := f.call(t, "alice", "POST", "/api/v1/playback/sessions/"+first+"/claim", map[string]bool{"take_over": false})
	if code != 409 {
		t.Fatalf("claim without takeover should conflict, got %d %s", code, body)
	}
	code, body = f.call(t, "alice", "POST", "/api/v1/playback/sessions/"+first+"/claim", map[string]bool{"take_over": true})
	if code != 409 {
		// Displaced/closed first session must not revive even with take_over.
		t.Fatalf("claim displaced session: want 409, got %d %s", code, body)
	}
	var owner string
	if err := f.pool.QueryRow(context.Background(), `SELECT session_id FROM playback_leases WHERE user_id='alice'`).Scan(&owner); err != nil || owner != second {
		t.Fatalf("owner=%q want %s err=%v", owner, second, err)
	}
}

func TestClaimSameSessionAfterReleaseWithoutTakeover(t *testing.T) {
	f := setup(t)
	id, _ := f.open(t, "alice", false)
	if code, body := f.call(t, "alice", "POST", "/api/v1/playback/sessions/"+id+"/release", nil); code != 200 {
		t.Fatalf("release %d %s", code, body)
	}
	code, body := f.call(t, "alice", "POST", "/api/v1/playback/sessions/"+id+"/claim", map[string]bool{"take_over": false})
	if code != 200 {
		t.Fatalf("reclaim own session after release %d %s", code, body)
	}
	var owner string
	if err := f.pool.QueryRow(context.Background(), `SELECT session_id FROM playback_leases WHERE user_id='alice' AND expires_at>now()`).Scan(&owner); err != nil || owner != id {
		t.Fatalf("owner=%q want %s err=%v", owner, id, err)
	}
}
