package playback

import (
	"context"
	"encoding/json"
	"net/url"
	"testing"

	"courseforge/backend/internal/identity"
)

func TestDisplacedSessionConflictsWithoutRevivingMediaOrCredit(t *testing.T) {
	f := setup(t)
	old, mediaPath := f.open(t, "alice", false)
	current, _ := f.open(t, "alice", true)
	pulse := Pulse{Sequence: 1, Kind: "playing", Position: 10, ElapsedSeconds: 10, PlaybackRate: 1, Playing: true, Visible: true}
	for _, op := range []struct {
		path string
		body any
	}{{"pulse", pulse}, {"claim", map[string]bool{"take_over": false}}, {"claim", map[string]bool{"take_over": true}}} {
		code, body := f.call(t, "alice", "POST", "/api/v1/playback/sessions/"+old+"/"+op.path, op.body)
		var failure struct{ Code string }
		_ = json.Unmarshal(body, &failure)
		if code != 409 || failure.Code != "playback_conflict" {
			t.Fatalf("displaced %s: status=%d body=%s", op.path, code, body)
		}
	}
	var owner string
	var sequence int64
	var watched float64
	if err := f.pool.QueryRow(context.Background(), `SELECT pl.session_id,ps.last_sequence,pt.watched_seconds FROM playback_leases pl JOIN playback_sessions ps ON ps.id=$1 JOIN playback_totals pt ON pt.user_id=ps.user_id AND pt.lesson_id=ps.lesson_id WHERE pl.user_id='alice'`, old).Scan(&owner, &sequence, &watched); err != nil {
		t.Fatal(err)
	}
	if owner != current || sequence != 0 || watched != 0 {
		t.Fatalf("displaced command changed state: owner=%s sequence=%d watched=%v", owner, sequence, watched)
	}
	u, _ := url.Parse(mediaPath)
	p := identity.Principal{UserID: "alice", SessionID: "aliceauth", Role: "student"}
	if _, err := f.svc.AuthorizeMedia(context.Background(), p, old, u.Query().Get("t")); err == nil {
		t.Fatal("displaced media token revived")
	}
	if code, _ := f.call(t, "bob", "POST", "/api/v1/playback/sessions/"+old+"/pulse", pulse); code != 403 {
		t.Fatalf("other learner saw displacement: %d", code)
	}
	if _, err := f.pool.Exec(context.Background(), `DELETE FROM enrollments WHERE user_id='alice'`); err != nil {
		t.Fatal(err)
	}
	if code, _ := f.call(t, "alice", "POST", "/api/v1/playback/sessions/"+old+"/pulse", pulse); code != 403 {
		t.Fatalf("revoked enrollment not denied: %d", code)
	}
}

func TestOrdinaryClosedAndExpiredSessionsRemainDenied(t *testing.T) {
	for _, state := range []string{"closed", "expired"} {
		t.Run(state, func(t *testing.T) {
			f := setup(t)
			id, _ := f.open(t, "alice", false)
			statement := `UPDATE playback_sessions SET closed_at=now() WHERE id=$1`
			if state == "expired" {
				statement = `UPDATE playback_sessions SET expires_at=now()-interval '1 second' WHERE id=$1`
			}
			if _, err := f.pool.Exec(context.Background(), statement, id); err != nil {
				t.Fatal(err)
			}
			if code, _ := f.call(t, "alice", "POST", "/api/v1/playback/sessions/"+id+"/claim", map[string]bool{"take_over": true}); code != 403 {
				t.Fatalf("%s session revived: %d", state, code)
			}
		})
	}
}
