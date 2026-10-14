package playback

import (
	"errors"
	"net/http"
	"time"

	"courseforge/backend/internal/identity"

	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrDenied = errors.New("playback access denied")
var ErrConflict = errors.New("another window owns playback")

type Service struct {
	Pool           *pgxpool.Pool
	Identity       *identity.Service
	Now            func() time.Time
	telemetryLimit *telemetryLimiter
}
type Preferences struct {
	Autoplay bool    `json:"autoplay"`
	Speed    float64 `json:"speed"`
	Theater  bool    `json:"theater"`
}
type Ack struct {
	Sequence       int64   `json:"sequence"`
	Position       float64 `json:"position"`
	WatchedSeconds float64 `json:"watched_seconds"`
	VisibleSeconds float64 `json:"visible_seconds"`
	Coverage       float64 `json:"coverage"`
	Owner          bool    `json:"owner"`
	Completed      bool    `json:"completed"`
}
type session struct {
	ID, LessonID                                                         string
	Sequence                                                             int64
	Position, Duration, Watched, Visible, PreviousPosition, PreviousRate float64
	Ranges                                                               []Interval
	At                                                                   time.Time
	Playing, WasVisible                                                  bool
}
type Source struct {
	LessonID, ClaimName, ClaimID, CourseID, Title string
}

func New(pool *pgxpool.Pool, id *identity.Service) *Service {
	return &Service{Pool: pool, Identity: id, Now: time.Now}
}
func (s *Service) Register(mux *http.ServeMux) {
	routes := []struct {
		pattern string
		handler http.HandlerFunc
	}{
		{"POST /api/v1/playback/sessions", s.open},
		{"POST /api/v1/playback/sessions/{id}/pulse", s.pulse},
		{"POST /api/v1/playback/sessions/{id}/claim", s.claim},
		{"POST /api/v1/playback/sessions/{id}/release", s.release},
		{"GET /api/v1/player/preferences", s.getPreferences},
		{"PUT /api/v1/player/preferences", s.putPreferences},
		{"POST /api/v1/player/telemetry", s.postTelemetry},
		{"GET /api/v1/admin/player/telemetry", s.telemetryAggregate},
	}
	for _, r := range routes {
		mux.Handle(r.pattern, s.Identity.Require(r.handler))
	}
}
