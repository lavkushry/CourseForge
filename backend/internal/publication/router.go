// Package publication routes fenced executor results to their product owner.
package publication

import (
	"context"
	"encoding/json"

	"courseforge/backend/internal/jobs"
	"github.com/jackc/pgx/v5"
)

type Router struct {
	Learning jobs.Publisher
	Paths    jobs.Publisher
}

// Publish runs inside Queue.Complete's transaction. Payload namespace, rather
// than kind alone, distinguishes lesson quizzes from private topic assessments.
func (r Router) Publish(ctx context.Context, tx pgx.Tx, job jobs.Job, raw json.RawMessage) error {
	var scope struct {
		Product string `json:"product"`
	}
	if json.Unmarshal(job.Payload, &scope) != nil {
		return jobs.ErrInvalid
	}
	var publisher jobs.Publisher
	switch scope.Product {
	case "learning_path":
		if job.Kind != "path" {
			return jobs.ErrInvalid
		}
		publisher = r.Paths
	case "topic_assessment":
		if job.Kind != "quiz" {
			return jobs.ErrInvalid
		}
		publisher = r.Paths
	case "":
		switch job.Kind {
		case "quiz", "review":
			publisher = r.Learning
		case "path":
			return jobs.ErrInvalid
		default:
			return nil // Foundation jobs have no product side effects yet.
		}
	default:
		return jobs.ErrInvalid
	}
	if publisher == nil {
		return jobs.ErrInvalid
	}
	return publisher(ctx, tx, job, raw)
}
