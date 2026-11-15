package playback

import "time"

// LeaseHoldTTL is how long a playback_leases row stays valid without a visible
// pulse/claim refresh. Long Ranges and k6 holds must heartbeat within this
// window or the gateway returns lease conflict (HTTP 409), not media busy.
// Documented in research §5 ("Lease TTL vs long Range"); keep SQL/Go sites in sync.
const LeaseHoldTTL = 40 * time.Second

// leaseHoldExpiry returns now+LeaseHoldTTL for parameterized INSERT/UPDATE.
func leaseHoldExpiry(now time.Time) time.Time {
	return now.UTC().Add(LeaseHoldTTL)
}
