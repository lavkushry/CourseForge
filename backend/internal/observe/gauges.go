package observe

// MediaGauges are media-plane dashboard values without session or learner labels.
// Busy sheds are MaxTransfers admission rejects; no-source is permanent missing media.
type MediaGauges struct {
	InUse         int
	Capacity      int
	BusySheds     int64
	NoSourceSheds int64
	ProviderFails int64
}

// AdmissionGauges are priority-limiter slots/sheds for one class (critical/pulse/browse/ai).
type AdmissionGauges struct {
	Class    string
	InUse    int
	Capacity int
	Sheds    int64
}

// CircuitGauges report provider circuit state for the media control plane.
// Open is 1 when cold resolves are shedding; Trips/Rejects are cumulative counters.
type CircuitGauges struct {
	Open    bool
	Trips   int64
	Rejects int64
}
