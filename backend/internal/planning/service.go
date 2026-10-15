package planning

import (
	"context"
	"errors"
	"net/http"
	"time"

	"courseforge/backend/internal/identity"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrInvalid = errors.New("invalid planning command")
var ErrConflict = errors.New("planning command or revision conflict")
var ErrUnavailable = errors.New("linked planning feature unavailable")
var ErrLimit = errors.New("planning resource limit reached")

// Adapters do bounded SQL in the supplied transaction, with explicit caller
// ownership and course scope. Network/model work never belongs in this seam.
type PathAdapter interface {
	Validate(context.Context, pgx.Tx, identity.Principal, string) (string, error)
	Candidates(context.Context, pgx.Tx, identity.Principal, string, time.Time, string) ([]Candidate, []string, error)
	ValidateCandidate(context.Context, pgx.Tx, identity.Principal, string, Candidate) error
}
type LabAdapter interface {
	ValidateSession(context.Context, pgx.Tx, identity.Principal, string) (string, string, error)
}
type Service struct {
	Pool           *pgxpool.Pool
	Paths          PathAdapter
	Labs           LabAdapter
	Now            func() time.Time
	EmailAvailable bool
}

func New(pool *pgxpool.Pool) *Service { return &Service{Pool: pool} }
func (s *Service) Register(mux *http.ServeMux, auth *identity.Service) {
	for route, h := range map[string]http.HandlerFunc{
		"GET /api/v1/planner/preferences": s.preferences, "PUT /api/v1/planner/preferences": s.preferencesPut,
		"GET /api/v1/planner/week-preferences": s.weekPreferences, "PUT /api/v1/planner/week-preferences": s.weekPreferencesPut,
		"GET /api/v1/planner/days/{date}": s.day, "POST /api/v1/planner/days": s.generateDay,
		"PUT /api/v1/planner/items/{id}": s.itemStatus, "PUT /api/v1/planner/items/{id}/actual": s.itemActual,
		"GET /api/v1/planner/weeks/{date}": s.week, "POST /api/v1/planner/weeks": s.generateWeek,
		"POST /api/v1/focus/sessions": s.focusStart, "POST /api/v1/focus/sessions/{id}/actions": s.focusAction,
		"GET /api/v1/focus/active": s.focusActive, "GET /api/v1/focus/history": s.focusHistory, "GET /api/v1/focus/analytics/{date}": s.focusAnalytics,
		"GET /api/v1/me/habits": s.habits, "PUT /api/v1/me/habit-preferences": s.habitPreferencesPut,
		"GET /api/v1/studio/insights": s.insights,
	} {
		mux.Handle(route, auth.Require(h))
	}
}
