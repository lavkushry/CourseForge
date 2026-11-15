package observe

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMetricsExportMediaAdmissionAndCircuitGauges(t *testing.T) {
	m := New(nil)
	m.AttachMedia(func() MediaGauges {
		return MediaGauges{InUse: 2, Capacity: 8, BusySheds: 3, NoSourceSheds: 1, ProviderFails: 4}
	})
	m.AttachAdmission(func() []AdmissionGauges {
		return []AdmissionGauges{
			{Class: "critical", InUse: 1, Capacity: 256, Sheds: 0},
			{Class: "ai", InUse: 2, Capacity: 32, Sheds: 9},
		}
	})
	m.AttachCircuit(func() CircuitGauges {
		return CircuitGauges{Open: true, Trips: 2, Rejects: 11}
	})

	w := httptest.NewRecorder()
	m.Handler().ServeHTTP(w, httptest.NewRequest("GET", "/metrics", nil))
	body := w.Body.String()
	for _, want := range []string{
		"courseforge_media_transfers_in_use 2",
		"courseforge_media_transfers_capacity 8",
		"courseforge_media_busy_sheds_total 3",
		"courseforge_media_no_source_total 1",
		"courseforge_media_provider_fail_total 4",
		`courseforge_admission_in_use{class="critical"} 1`,
		`courseforge_admission_capacity{class="ai"} 32`,
		`courseforge_admission_sheds_total{class="ai"} 9`,
		"courseforge_media_circuit_open 1",
		"courseforge_media_circuit_trips_total 2",
		"courseforge_media_circuit_rejects_total 11",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("missing %q in\n%s", want, body)
		}
	}
	// Avoid bare "ps_" — it appears inside metric names like circuit_trips_total.
	for _, leak := range []string{"ps_session", "claim_id", "odysee.com", "learner-id", "Bearer ", "t=secret"} {
		if strings.Contains(body, leak) {
			t.Fatalf("gauge export leaked %q", leak)
		}
	}
}
