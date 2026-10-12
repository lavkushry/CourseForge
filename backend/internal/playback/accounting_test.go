package playback

import (
	"math"
	"testing"
	"time"
)

func TestCreditDiscontinuities(t *testing.T) {
	at := time.Unix(100, 0)
	base := Pulse{Sequence: 2, Kind: "heartbeat", Position: 20, ElapsedSeconds: 10, PlaybackRate: 1, Playing: true, Visible: true}
	for _, tc := range []struct {
		name             string
		change           func(*Pulse)
		playing, visible bool
		gap              time.Duration
		want             float64
	}{
		{"ordinary", func(*Pulse) {}, true, true, 10 * time.Second, 10},
		{"seek_event", func(p *Pulse) { p.Kind = "seek" }, true, true, 10 * time.Second, 0},
		{"unannounced_jump", func(p *Pulse) { p.Position = 80 }, true, true, 10 * time.Second, 0},
		{"paused_baseline", func(*Pulse) {}, false, true, 10 * time.Second, 0},
		{"hidden_baseline", func(*Pulse) {}, true, false, 10 * time.Second, 0},
		{"offline_gap", func(*Pulse) {}, true, true, 40 * time.Second, 0},
		{"client_inflated_elapsed", func(*Pulse) {}, true, true, 2 * time.Second, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := base
			tc.change(&p)
			n, _ := credit(p, at, at.Add(-tc.gap), 10, 1, 100, tc.playing, tc.visible)
			if math.Abs(n-tc.want) > .001 {
				t.Fatalf("credit %v want %v", n, tc.want)
			}
		})
	}
}
func TestOverlapDoesNotDoubleCoverage(t *testing.T) {
	r := merge([]Interval{{0, 20}, {10, 30}}, Interval{25, 40})
	if len(r) != 1 || coverage(r, 100) != 40 {
		t.Fatalf("ranges %#v coverage %v", r, coverage(r, 100))
	}
}
func TestGapsAreNotInvented(t *testing.T) {
	r := merge([]Interval{{0, 10}}, Interval{10.1, 20})
	if len(r) != 2 || math.Abs(coverage(r, 100)-19.9) > .001 {
		t.Fatalf("invented gap: %#v", r)
	}
}
func TestFragmentStorageIsBounded(t *testing.T) {
	r := make([]Interval, 2100)
	for i := range r {
		r[i] = Interval{float64(i * 2), float64(i*2 + 1)}
	}
	r = merge(r, Interval{})
	if len(r) != 2000 || coverage(r, 10000) > 20 {
		t.Fatalf("fragments %d coverage %v", len(r), coverage(r, 10000))
	}
}
