package jobs

import "encoding/json"

// PublicJob is the browser boundary, also used by product submission endpoints.
// Assessment keys must never reach a learner through queue status or replay.
// New namespaced products require an explicit projector rather than inheriting
// raw executor output. Projectors must be pure and must not mutate the input.
func (q *Queue) PublicJob(job Job) Job {
	if len(job.Result) == 0 {
		return job
	}
	if q.ResultProjector != nil {
		if result, handled := q.ResultProjector(job); handled {
			job.Result = result
			return job
		}
	}
	var scope struct {
		Product string `json:"product"`
	}
	if job.Kind == "quiz" || json.Unmarshal(job.Payload, &scope) != nil || scope.Product != "" {
		job.Result = nil
	}
	return job
}
