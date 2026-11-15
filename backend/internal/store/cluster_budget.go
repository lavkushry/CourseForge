package store

import "fmt"

// ClusterConnCeiling is the experimental shared PostgreSQL connection budget from
// docs/GO_TYPESCRIPT_CAPACITY.md (illustrative: 4 API ×24 + 16 worker + 8 ops = 120).
// It is a planning ceiling, not measured capacity and not a 10k-learner claim.
const ClusterConnCeiling int32 = 120

// ClusterLayout describes replica × MaxConns across capacity domains.
// Use with PoolConfigFor defaults or CF_DB_MAX_CONNS overrides before adding replicas.
type ClusterLayout struct {
	APIReplicas      int
	APIMaxConns      int32
	MediaReplicas    int
	MediaMaxConns    int32
	WorkerAI         int // process count
	WorkerAIMaxConns int32
	WorkerLab        int
	WorkerLabMaxConns int32
	WorkerExport     int
	WorkerExportMaxConns int32
	EncodeWorkers    int
	EncodeMaxConns   int32
	OperationalConns int32 // migrations, admin, ad-hoc
}

// DefaultExperimentLayout mirrors docs/GO_TYPESCRIPT_CAPACITY.md arithmetic:
// 4 API ×24 + 16 worker + 8 operational = 120. Dedicated media gateway replicas
// must be carved from this ceiling via WithMediaGateways — never stacked silently.
// Single-box Cloud defaults stay smaller (PoolConfigFor); this layout is for
// planning scale-out, not a measured learner-capacity claim.
func DefaultExperimentLayout() ClusterLayout {
	return ClusterLayout{
		APIReplicas:          4,
		APIMaxConns:          24,
		WorkerAI:             2,
		WorkerAIMaxConns:     4, // 8
		WorkerLab:            1,
		WorkerLabMaxConns:    2, // 2
		WorkerExport:         1,
		WorkerExportMaxConns: 2, // 2
		EncodeWorkers:        2,
		EncodeMaxConns:       2, // 4 → workers total 16
		OperationalConns:     8,
	}
}

// WithMediaGateways adds standalone media-auth replicas by reducing API MaxConns
// so TotalConns stays ≤ ClusterConnCeiling. Returns an error if it cannot fit.
func (l ClusterLayout) WithMediaGateways(replicas int, maxConns int32) (ClusterLayout, error) {
	out := l
	out.MediaReplicas = replicas
	out.MediaMaxConns = maxConns
	need := int32(replicas) * maxConns
	if need <= 0 {
		return out, out.Validate()
	}
	for out.APIMaxConns > 8 && out.TotalConns() > ClusterConnCeiling {
		out.APIMaxConns--
	}
	if err := out.Validate(); err != nil {
		return ClusterLayout{}, fmt.Errorf("cannot fit %d media gateways×%d under ceiling: %w", replicas, maxConns, err)
	}
	return out, nil
}

// TotalConns sums planned pool budgets across the fleet.
func (l ClusterLayout) TotalConns() int32 {
	var n int32
	n += int32(l.APIReplicas) * l.APIMaxConns
	n += int32(l.MediaReplicas) * l.MediaMaxConns
	n += int32(l.WorkerAI) * l.WorkerAIMaxConns
	n += int32(l.WorkerLab) * l.WorkerLabMaxConns
	n += int32(l.WorkerExport) * l.WorkerExportMaxConns
	n += int32(l.EncodeWorkers) * l.EncodeMaxConns
	n += l.OperationalConns
	return n
}

// Validate reports whether the layout fits under ClusterConnCeiling.
// A passing Validate is not evidence of learner capacity.
func (l ClusterLayout) Validate() error {
	if l.APIReplicas < 0 || l.MediaReplicas < 0 || l.WorkerAI < 0 || l.WorkerLab < 0 || l.WorkerExport < 0 || l.EncodeWorkers < 0 {
		return fmt.Errorf("replica counts must be non-negative")
	}
	total := l.TotalConns()
	if total > ClusterConnCeiling {
		return fmt.Errorf("planned cluster connections %d exceed ceiling %d (see docs/GO_TYPESCRIPT_CAPACITY.md); reduce replicas or MaxConns before scaling", total, ClusterConnCeiling)
	}
	if total < 1 {
		return fmt.Errorf("planned cluster connections must be positive")
	}
	return nil
}

// Headroom returns remaining connections under the ceiling (may be negative if over budget).
func (l ClusterLayout) Headroom() int32 {
	return ClusterConnCeiling - l.TotalConns()
}
