package api_test

import (
	"encoding/json"
	"reflect"
	"testing"

	"courseforge/backend/internal/api"
)

func TestKnownDurationValidationAndManualResumePreserveAcknowledgedCompletion(t *testing.T) {
	f := setup(t)
	alice := f.login(t, "alice")
	data := expect(t, alice, "PUT", "/api/v1/lessons/lesson-z/progress", map[string]any{"percent": 100, "position": 120}, 200, nil)
	var before api.Progress
	_ = json.Unmarshal(data, &before)
	expect(t, alice, "PUT", "/api/v1/lessons/lesson-z/progress", map[string]any{"percent": 33, "position": 1000000}, 422, nil)
	data = expect(t, alice, "GET", "/api/v1/lessons/lesson-z/progress", nil, 200, nil)
	var after api.Progress
	_ = json.Unmarshal(data, &after)
	if after.Percent != before.Percent || after.Position != before.Position || after.Revision != before.Revision {
		t.Fatal("rejected duration mutated acknowledged progress")
	}
	data = expect(t, alice, "PUT", "/api/v1/lessons/lesson-z/resume-point", map[string]any{"position": 20}, 200, nil)
	_ = json.Unmarshal(data, &after)
	if after.Position != 20 || after.Percent != 100 || !after.Completed || !after.ExplicitCompleted {
		t.Fatal("manual resume erased prior completion", after)
	}
	expect(t, alice, "PUT", "/api/v1/lessons/lesson-z/progress", map[string]any{}, 422, nil)
}

func TestResumePointCannotMutateCompletionFields(t *testing.T) {
	f := setup(t)
	alice := f.login(t, "alice")
	data := expect(t, alice, "PUT", "/api/v1/lessons/lesson-z/progress", map[string]any{"percent": 100, "position": 120}, 200, nil)
	var before api.Progress
	_ = json.Unmarshal(data, &before)
	for _, body := range []map[string]any{
		{"position": 20, "percent": 0},
		{"position": 20, "percent": 100},
		{"position": 20, "percent": nil},
		{"position": 20, "expected_revision": before.Revision},
	} {
		expect(t, alice, "PUT", "/api/v1/lessons/lesson-z/resume-point", body, 400, nil)
		data = expect(t, alice, "GET", "/api/v1/lessons/lesson-z/progress", nil, 200, nil)
		var after api.Progress
		_ = json.Unmarshal(data, &after)
		if !reflect.DeepEqual(after, before) {
			t.Fatal("invalid resume command mutated progress", after)
		}
	}
}
