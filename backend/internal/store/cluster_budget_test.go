package store

import "testing"

func TestDefaultExperimentLayoutFitsCeiling(t *testing.T) {
	t.Parallel()
	layout := DefaultExperimentLayout()
	if err := layout.Validate(); err != nil {
		t.Fatal(err)
	}
	if got := layout.TotalConns(); got != ClusterConnCeiling {
		t.Fatalf("expected exact capacity-doc 120, got %d", got)
	}
	if layout.Headroom() != 0 {
		t.Fatal("expected zero headroom at the documented ceiling")
	}
}

func TestWithMediaGatewaysFitsByShrinkingAPI(t *testing.T) {
	t.Parallel()
	layout, err := DefaultExperimentLayout().WithMediaGateways(2, 8)
	if err != nil {
		t.Fatal(err)
	}
	if layout.MediaReplicas != 2 || layout.TotalConns() > ClusterConnCeiling {
		t.Fatalf("media=%d total=%d", layout.MediaReplicas, layout.TotalConns())
	}
	if layout.APIMaxConns >= 24 {
		t.Fatal("expected API MaxConns reduced to make room for media gateways")
	}
}

func TestClusterLayoutRejectsOverBudget(t *testing.T) {
	t.Parallel()
	layout := ClusterLayout{
		APIReplicas: 10,
		APIMaxConns: 24,
	}
	if err := layout.Validate(); err == nil {
		t.Fatal("expected over-budget error")
	}
}

func TestPoolConfigForNotesRemainBelowPerProcessCap(t *testing.T) {
	t.Parallel()
	for _, role := range []PoolRole{PoolAPI, PoolMediaAuth, PoolWorkerAI, PoolEncode} {
		cfg := PoolConfigFor(role)
		if cfg.MaxConns > ClusterConnCeiling {
			t.Fatalf("%s MaxConns %d exceeds cluster ceiling", role, cfg.MaxConns)
		}
	}
}
