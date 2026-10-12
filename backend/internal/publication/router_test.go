package publication

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"courseforge/backend/internal/jobs"
	"github.com/jackc/pgx/v5"
)

func TestNamespacesKeepTopicAssessmentsOutOfLessonCuration(t *testing.T) {
	ctx := context.Background()
	var learning, paths int
	childError := errors.New("typed publisher rejection")
	r := Router{
		Learning: func(context.Context, pgx.Tx, jobs.Job, json.RawMessage) error { learning++; return childError },
		Paths:    func(context.Context, pgx.Tx, jobs.Job, json.RawMessage) error { paths++; return childError },
	}
	for _, tc := range []struct {
		kind, payload string
		path          bool
	}{
		{"quiz", `{"version":1}`, false}, {"review", `{"version":1}`, false},
		{"quiz", `{"version":1,"product":"topic_assessment"}`, true},
		{"path", `{"version":1,"product":"learning_path"}`, true},
	} {
		beforeLearning, beforePaths := learning, paths
		err := r.Publish(ctx, nil, jobs.Job{Kind: tc.kind, Payload: json.RawMessage(tc.payload)}, json.RawMessage(`{"version":1}`))
		if !errors.Is(err, childError) {
			t.Fatal("publisher rejection was swallowed")
		}
		if tc.path && (paths != beforePaths+1 || learning != beforeLearning) || !tc.path && (learning != beforeLearning+1 || paths != beforePaths) {
			t.Fatal("result reached the wrong product")
		}
	}
	beforeLearning, beforePaths := learning, paths
	for _, tc := range []struct{ kind, payload string }{
		{"review", `{"product":"topic_assessment"}`}, {"quiz", `{"product":"learning_path"}`},
		{"path", `{"version":1}`}, {"quiz", `{"product":"unknown"}`}, {"quiz", `{"product":1}`}, {"quiz", `{`},
	} {
		if err := r.Publish(ctx, nil, jobs.Job{Kind: tc.kind, Payload: json.RawMessage(tc.payload)}, nil); !errors.Is(err, jobs.ErrInvalid) {
			t.Fatal("unrecognized scope accepted", tc.kind, tc.payload)
		}
	}
	if learning != beforeLearning || paths != beforePaths {
		t.Fatal("invalid scope reached publication")
	}
	if err := (Router{}).Publish(ctx, nil, jobs.Job{Kind: "quiz", Payload: json.RawMessage(`{}`)}, nil); !errors.Is(err, jobs.ErrInvalid) {
		t.Fatal("missing product publisher accepted")
	}
}
