// Package playback owns durable account-wide playback leases and progress.
package playback

import (
	"math"
	"sort"
	"time"
)

type Interval [2]float64

type Pulse struct {
	Sequence       int64   `json:"sequence"`
	Kind           string  `json:"kind"`
	Position       float64 `json:"position"`
	Playing        bool    `json:"playing"`
	Visible        bool    `json:"visible"`
	ElapsedSeconds float64 `json:"elapsed_seconds"`
	PlaybackRate   float64 `json:"playback_rate"`
}

func (p Pulse) valid() bool {
	if p.Sequence < 1 || p.Sequence > 1<<53 || !finite(p.Position) || p.Position < 0 || p.Position >= 1e7 || !finite(p.ElapsedSeconds) || p.ElapsedSeconds < 0 || p.ElapsedSeconds > 20 || !finite(p.PlaybackRate) || p.PlaybackRate < .25 || p.PlaybackRate > 4 {
		return false
	}
	switch p.Kind {
	case "playing", "pause", "seek", "ended", "heartbeat", "hidden", "close", "waiting", "ratechange", "ready":
		return true
	}
	return false
}

func finite(n float64) bool { return !math.IsNaN(n) && !math.IsInf(n, 0) }

// Credit requires a prior playing baseline and plausible observed movement.
// Position changes due to seeking establish a new baseline without watch credit.
func credit(p Pulse, at time.Time, previousAt time.Time, previousPosition, previousRate, duration float64, previousPlaying, previousVisible bool) (float64, Interval) {
	gap := at.Sub(previousAt).Seconds()
	advance := p.Position - previousPosition
	if !previousPlaying || !previousVisible || p.Kind == "seek" || gap <= 0 || gap > 30 || advance <= 0 || previousRate < .25 || advance > math.Min(gap, 20)*previousRate+1 {
		return 0, Interval{}
	}
	seconds := math.Min(math.Min(p.ElapsedSeconds, gap), math.Min(advance/previousRate, 20))
	end := p.Position
	if duration > 0 {
		end = math.Min(end, duration)
	}
	return seconds, Interval{math.Max(0, end-seconds*previousRate), end}
}

// Coalesce actual intervals; drop small fragments if necessary to bound storage.
// Dropping fragments undercounts rather than creating watched content.
func merge(ranges []Interval, add Interval) []Interval {
	if add[1] > add[0] {
		ranges = append(ranges, add)
	}
	sort.Slice(ranges, func(i, j int) bool { return ranges[i][0] < ranges[j][0] })
	merged := make([]Interval, 0, len(ranges))
	for _, r := range ranges {
		if !finite(r[0]) || !finite(r[1]) || r[0] < 0 || r[1] <= r[0] {
			continue
		}
		if len(merged) > 0 && r[0] <= merged[len(merged)-1][1] {
			merged[len(merged)-1][1] = math.Max(merged[len(merged)-1][1], r[1])
		} else {
			merged = append(merged, r)
		}
	}
	if len(merged) > 2000 {
		sort.Slice(merged, func(i, j int) bool { return merged[i][1]-merged[i][0] > merged[j][1]-merged[j][0] })
		merged = merged[:2000]
		sort.Slice(merged, func(i, j int) bool { return merged[i][0] < merged[j][0] })
	}
	return merged
}

func coverage(ranges []Interval, duration float64) float64 {
	if duration <= 0 {
		return 0
	}
	n := 0.0
	for _, r := range ranges {
		n += math.Max(0, math.Min(duration, r[1])-math.Min(duration, r[0]))
	}
	return math.Min(100, 100*n/duration)
}
