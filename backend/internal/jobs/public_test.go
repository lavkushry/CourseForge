package jobs

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestPublicJobRequiresKnownProductProjection(t *testing.T) {
	q := &Queue{}
	private := json.RawMessage(`{"answer":"private-sentinel"}`)
	for _, payload := range []string{`{"product":"future_product"}`, `{"product":12}`, `{`} {
		job := Job{Kind: "tutor", Payload: json.RawMessage(payload), Result: private}
		if q.PublicJob(job).Result != nil {
			t.Fatal("unknown namespace disclosed executor output")
		}
		if !strings.Contains(string(job.Result), "private-sentinel") {
			t.Fatal("projection mutated durable input")
		}
	}
	for _, kind := range []string{"tutor", "review"} {
		job := Job{Kind: kind, Payload: json.RawMessage(`{"version":1}`), Result: private}
		if string(q.PublicJob(job).Result) != string(private) {
			t.Fatal("ordinary owned output lost", kind)
		}
	}
	q.ResultProjector = func(job Job) (json.RawMessage, bool) {
		return json.RawMessage(`{"assessment_id":"safe-reference"}`), job.Kind == "quiz"
	}
	job := Job{Kind: "quiz", Payload: json.RawMessage(`{"product":"topic_assessment"}`), Result: private}
	if string(q.PublicJob(job).Result) != `{"assessment_id":"safe-reference"}` {
		t.Fatal("known projector not applied")
	}
}
