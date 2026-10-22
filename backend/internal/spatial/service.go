package spatial

import (
	"context"
	_ "embed"
	"errors"
	"net/http"

	"courseforge/backend/internal/access"
	"courseforge/backend/internal/httpx"
	"courseforge/backend/internal/identity"

	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed fixture.json
var fixtureJSON []byte

var ErrDenied = errors.New("spatial asset unavailable")

// Service serves the stored spatial read model. It does not run upload processing.
type Service struct {
	Pool   *pgxpool.Pool
	assets []Asset
}

func New(pool *pgxpool.Pool) *Service {
	assets, err := parseCatalog(fixtureJSON)
	if err != nil {
		panic(err)
	}
	return &Service{Pool: pool, assets: assets}
}

func (s *Service) Register(mux *http.ServeMux, auth *identity.Service) {
	mux.Handle("GET /api/v1/lessons/{id}/spatial", auth.Require(http.HandlerFunc(s.listHTTP)))
	mux.Handle("GET /api/v1/lessons/{id}/spatial/scene", auth.Require(http.HandlerFunc(s.sceneHTTP)))
}

func (s *Service) listHTTP(w http.ResponseWriter, r *http.Request) {
	p, ok := identity.FromContext(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "unauthenticated", "Please sign in")
		return
	}
	assets, err := s.List(r.Context(), p, r.PathValue("id"))
	if err != nil {
		writeErr(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"lecture_id": r.PathValue("id"),
		"assets":     assets,
	})
}

func (s *Service) sceneHTTP(w http.ResponseWriter, r *http.Request) {
	p, ok := identity.FromContext(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "unauthenticated", "Please sign in")
		return
	}
	scene, err := s.Scene(r.Context(), p, r.PathValue("id"), Kind(r.URL.Query().Get("kind")))
	if err != nil {
		writeErr(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, scene)
}

// List returns visible assets for one lecture after an enrollment check.
// Held assets are omitted. An unknown lecture returns an empty list when
// the caller can read that lesson, so the UI shows no Explore action.
func (s *Service) List(ctx context.Context, p identity.Principal, lectureID string) ([]Asset, error) {
	if err := s.allow(ctx, p, lectureID); err != nil {
		return nil, err
	}
	visible := Visible(forLecture(s.assets, lectureID))
	for i := range visible {
		visible[i].Evidence = ""
	}
	return visible, nil
}

// Scene returns the transcript-backed description for one visible mode.
// Held modes and unknown kinds are unavailable. Bytes are not served.
func (s *Service) Scene(ctx context.Context, p identity.Principal, lectureID string, kind Kind) (Scene, error) {
	if err := s.allow(ctx, p, lectureID); err != nil {
		return Scene{}, err
	}
	for _, asset := range Visible(forLecture(s.assets, lectureID)) {
		if asset.Kind != kind {
			continue
		}
		return Scene{
			LectureID:    asset.LectureID,
			ConceptIDs:   asset.ConceptIDs,
			StartSeconds: asset.StartSeconds,
			EndSeconds:   asset.EndSeconds,
			Kind:         asset.Kind,
			Evidence:     asset.Evidence,
		}, nil
	}
	return Scene{}, ErrDenied
}

func (s *Service) allow(ctx context.Context, p identity.Principal, lectureID string) error {
	if s.Pool == nil || lectureID == "" {
		return ErrDenied
	}
	ok, err := access.CanLesson(ctx, s.Pool, p.UserID, p.Role, lectureID)
	if err != nil {
		return err
	}
	if !ok {
		return ErrDenied
	}
	return nil
}

func writeErr(w http.ResponseWriter, err error) {
	if errors.Is(err, ErrDenied) {
		httpx.Error(w, http.StatusNotFound, "spatial_unavailable", "Spatial view unavailable")
		return
	}
	httpx.Error(w, http.StatusServiceUnavailable, "spatial_unavailable", "Spatial view unavailable")
}
