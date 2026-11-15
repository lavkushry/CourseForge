package playback

import (
	"testing"
	"time"
)

func TestLeaseHoldTTLMatchesLongRangeDoc(t *testing.T) {
	if LeaseHoldTTL != 40*time.Second {
		t.Fatalf("LeaseHoldTTL=%v want 40s (pulse keepalive contract)", LeaseHoldTTL)
	}
	now := time.Date(2026, 11, 15, 12, 0, 0, 0, time.UTC)
	got := leaseHoldExpiry(now)
	want := now.Add(40 * time.Second)
	if !got.Equal(want) {
		t.Fatalf("leaseHoldExpiry=%v want %v", got, want)
	}
}
