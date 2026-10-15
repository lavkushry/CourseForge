package playback

import "testing"

func TestValidateTelemetry(t *testing.T) {
	ok := TelemetryPayload{
		SessionID: "ps_abc", StartupMs: 1200, RebufferMs: 40, PlayMs: 60_000, Errors: 0, BitrateSwitches: 2,
	}
	if !ValidateTelemetry(ok) {
		t.Fatal("expected valid payload")
	}
	bad := ok
	bad.SessionID = ""
	if ValidateTelemetry(bad) {
		t.Fatal("empty session must fail")
	}
	bad = ok
	bad.StartupMs = -1
	if ValidateTelemetry(bad) {
		t.Fatal("negative startup must fail")
	}
	bad = ok
	bad.PlayMs = 100_000_000
	if ValidateTelemetry(bad) {
		t.Fatal("oversized play_ms must fail")
	}
}

func TestAggregateTelemetry(t *testing.T) {
	startups := []int{100, 200, 300, 400, 1000}
	reb := []int64{10, 0, 20, 0, 50}
	play := []int64{1000, 1000, 1000, 1000, 1000}
	errs := []int{0, 0, 1, 0, 0}
	agg := AggregateTelemetry(startups, reb, play, errs)
	if agg.Samples != 5 {
		t.Fatalf("samples=%d", agg.Samples)
	}
	if agg.StartupP50Ms != 300 {
		t.Fatalf("p50=%v", agg.StartupP50Ms)
	}
	if agg.StartupP95Ms != 1000 {
		t.Fatalf("p95=%v", agg.StartupP95Ms)
	}
	if agg.RebufferRatio < 0.015 || agg.RebufferRatio > 0.017 {
		t.Fatalf("rebuffer_ratio=%v", agg.RebufferRatio)
	}
	if agg.ErrorRate != 0.2 {
		t.Fatalf("error_rate=%v", agg.ErrorRate)
	}
	empty := AggregateTelemetry(nil, nil, nil, nil)
	if empty.Samples != 0 || empty.StartupP50Ms != 0 {
		t.Fatalf("empty aggregate: %+v", empty)
	}
}
