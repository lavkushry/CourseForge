package playback

import (
	"context"
	"errors"
	"net/url"
	"testing"

	"courseforge/backend/internal/identity"
)

// A lost lease with intact access is reclaimable (ErrConflict); lost access is
// still a hard denial. The lease never silently revives without a claim.
func TestMediaLeaseLossIsConflictAndReclaimRestoresAccess(t *testing.T) {
	ctx := context.Background()
	p := identity.Principal{UserID: "alice", SessionID: "aliceauth", Role: "student"}
	for _, how := range []string{"expired", "hidden"} {
		t.Run(how, func(t *testing.T) {
			f := setup(t)
			id, path := f.open(t, "alice", false)
			u, _ := url.Parse(path)
			token := u.Query().Get("t")
			if _, err := f.svc.AuthorizeMedia(ctx, p, id, token); err != nil {
				t.Fatalf("fresh session denied: %v", err)
			}
			if how == "expired" {
				if _, err := f.pool.Exec(ctx, `UPDATE playback_leases SET expires_at=now()-interval '1 second' WHERE user_id='alice'`); err != nil {
					t.Fatal(err)
				}
			} else {
				f.pulse(t, "alice", id, Pulse{Sequence: 1, Kind: "hidden", PlaybackRate: 1, Visible: false})
			}
			if _, err := f.svc.AuthorizeMedia(ctx, p, id, token); !errors.Is(err, ErrConflict) {
				t.Fatalf("lost lease: err=%v, want ErrConflict", err)
			}
			if code, body := f.call(t, "alice", "POST", "/api/v1/playback/sessions/"+id+"/claim", map[string]bool{"take_over": false}); code != 200 {
				t.Fatalf("reclaim %d %s", code, body)
			}
			if _, err := f.svc.AuthorizeMedia(ctx, p, id, token); err != nil {
				t.Fatalf("reclaimed session denied: %v", err)
			}
		})
	}
}

func TestMediaWithoutEnrollmentOrWrongTokenStaysDenied(t *testing.T) {
	ctx := context.Background()
	f := setup(t)
	p := identity.Principal{UserID: "alice", SessionID: "aliceauth", Role: "student"}
	id, path := f.open(t, "alice", false)
	u, _ := url.Parse(path)
	token := u.Query().Get("t")
	if _, err := f.svc.AuthorizeMedia(ctx, p, id, "wrong"); !errors.Is(err, ErrDenied) {
		t.Fatalf("wrong token: %v", err)
	}
	if _, err := f.pool.Exec(ctx, `DELETE FROM enrollments WHERE user_id='alice'`); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.AuthorizeMedia(ctx, p, id, token); !errors.Is(err, ErrDenied) {
		t.Fatalf("not enrolled: err=%v, want ErrDenied", err)
	}
	// Even with the lease expired, missing enrollment is a denial, not a conflict.
	if _, err := f.pool.Exec(ctx, `UPDATE playback_leases SET expires_at=now()-interval '1 second' WHERE user_id='alice'`); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.AuthorizeMedia(ctx, p, id, token); !errors.Is(err, ErrDenied) {
		t.Fatalf("not enrolled, lease expired: err=%v, want ErrDenied", err)
	}
}
