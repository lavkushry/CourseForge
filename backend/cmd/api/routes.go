package main

import (
	"net/http"

	"courseforge/backend/internal/activity"
	"courseforge/backend/internal/administration"
	"courseforge/backend/internal/ai"
	"courseforge/backend/internal/career"
	"courseforge/backend/internal/certificates"
	"courseforge/backend/internal/contract"
	"courseforge/backend/internal/identity"
	"courseforge/backend/internal/jobs"
	"courseforge/backend/internal/knowledge"
	"courseforge/backend/internal/labs"
	"courseforge/backend/internal/learning"
	"courseforge/backend/internal/media"
	"courseforge/backend/internal/paths"
	"courseforge/backend/internal/planning"
	"courseforge/backend/internal/playback"
	"courseforge/backend/internal/practice"
	"courseforge/backend/internal/spatial"
)

// apiRouteDeps holds services whose Register methods only call mux.Handle during wiring.
// Nil/fake deps are fine for registration tests that do not serve requests.
type apiRouteDeps struct {
	Auth         *identity.Service
	Reports      *administration.Service
	Player       *playback.Service
	Queue        *jobs.Queue
	Learning     *learning.Service
	Paths        *paths.Service
	Practice     *practice.Service
	Planner      *planning.Service
	Certificates *certificates.Service
	Activity     *activity.Service
	Labs         *labs.Service
	AI           *ai.Service
	Knowledge    *knowledge.Service
	Career       *career.Service
	Spatial      *spatial.Service
	Media        *media.Gateway // optional; only registered when non-nil
}

// registerAPIRoutes mounts the domain routes that sit alongside api.New's core routes.
// It panics if the same pattern is registered twice (Go ServeMux behavior).
func registerAPIRoutes(mux *http.ServeMux, d apiRouteDeps) {
	contract.Register(mux)
	d.Auth.RegisterAdminRoutes(mux)
	d.Reports.Register(mux, d.Auth)
	d.Player.Register(mux)
	d.Queue.Register(mux, d.Auth)
	d.Learning.Register(mux, d.Auth)
	d.Paths.Register(mux, d.Auth)
	d.Practice.Register(mux, d.Auth)
	d.Planner.Register(mux, d.Auth)
	d.Certificates.Register(mux, d.Auth)
	d.Activity.Register(mux, d.Auth)
	d.Labs.Register(mux, d.Auth)
	d.AI.Register(mux, d.Auth)
	d.Knowledge.Register(mux, d.Auth)
	d.Career.Register(mux, d.Auth)
	d.Spatial.Register(mux, d.Auth)
	if d.Media != nil {
		d.Media.Register(mux, d.Auth)
	}
}
