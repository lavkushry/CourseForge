package career

import "math"

const (
	wilsonZ95      = 1.959963984540054 // ~95% two-sided normal quantile
	minReliableN   = 100
	unreliableNote = "n<100: result is not statistically reliable"
)

// WilsonInterval returns the 95% Wilson score confidence interval for a binomial proportion.
// When n==0, ok is false and bounds are 0.
func WilsonInterval(successes, n int) (low, high float64, ok bool) {
	if n <= 0 {
		return 0, 0, false
	}
	if successes < 0 {
		successes = 0
	}
	if successes > n {
		successes = n
	}
	phat := float64(successes) / float64(n)
	z := wilsonZ95
	z2 := z * z
	den := 1 + z2/float64(n)
	center := phat + z2/(2*float64(n))
	margin := z * math.Sqrt(phat*(1-phat)/float64(n)+z2/(4*float64(n)*float64(n)))
	low = (center - margin) / den
	high = (center + margin) / den
	if low < 0 {
		low = 0
	}
	if high > 1 {
		high = 1
	}
	return low, high, true
}

func rateStats(label string, successes, n int) RateStats {
	low, high, ok := WilsonInterval(successes, n)
	rate := 0.0
	if n > 0 {
		rate = float64(successes) / float64(n)
	}
	stats := RateStats{
		Label:      label,
		N:          n,
		Successes:  successes,
		Rate:       rate,
		WilsonLow:  low,
		WilsonHigh: high,
		WilsonOK:   ok,
		Unreliable: n < minReliableN,
	}
	if stats.Unreliable {
		stats.UnreliableNote = unreliableNote
	}
	return stats
}

func appliedDaysBucket(days *int) string {
	if days == nil {
		return "unknown"
	}
	d := *days
	switch {
	case d <= 1:
		return "0-1"
	case d <= 3:
		return "2-3"
	case d <= 7:
		return "4-7"
	default:
		return "8+"
	}
}

func isCallbackStatus(status string) bool {
	switch status {
	case StatusCallback, StatusInterview, StatusOffer:
		return true
	default:
		return false
	}
}

func isInterviewStatus(status string) bool {
	switch status {
	case StatusInterview, StatusOffer:
		return true
	default:
		return false
	}
}
