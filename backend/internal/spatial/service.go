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
	mux.Handle("GET /api/v1/lessons/{id}/spatial/model", auth.Require(http.HandlerFunc(s.modelHTTP)))
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

func (s *Service) modelHTTP(w http.ResponseWriter, r *http.Request) {
	p, ok := identity.FromContext(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "unauthenticated", "Please sign in")
		return
	}
	model, err := s.Model(r.Context(), p, r.PathValue("id"))
	if err != nil {
		writeErr(w, err)
		return
	}
	w.Header().Set("Content-Type", "model/gltf-binary")
	w.Header().Set("Cache-Control", "private, max-age=60")
	_, _ = w.Write(model)
}

// List returns visible assets for one lecture after an enrollment check.
// Held assets are omitted. An unknown lecture returns an empty list when
// the caller can read that lesson, so the UI shows no Explore action.
func (s *Service) List(ctx context.Context, p identity.Principal, lectureID string) ([]Asset, error) {
	if err := s.allow(ctx, p, lectureID); err != nil {
		return nil, err
	}
	visible, _, err := s.lessonAssets(ctx, lectureID)
	if err != nil {
		return nil, err
	}
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
	visible, _, err := s.lessonAssets(ctx, lectureID)
	if err != nil {
		return Scene{}, err
	}
	for _, asset := range visible {
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
			Labels:       append([]string(nil), asset.Labels...),
		}, nil
	}
	return Scene{}, ErrDenied
}

// Model returns the generated GLB for a visible spatial asset.
func (s *Service) Model(ctx context.Context, p identity.Principal, lectureID string) ([]byte, error) {
	if err := s.allow(ctx, p, lectureID); err != nil {
		return nil, err
	}
	_, model, err := s.lessonAssets(ctx, lectureID)
	if err != nil {
		return nil, err
	}
	if len(model) == 0 {
		return nil, ErrDenied
	}
	return model, nil
}

func (s *Service) lessonAssets(ctx context.Context, lectureID string) ([]Asset, []byte, error) {
	if s.Pool != nil {
		rows, err := s.Pool.Query(ctx, `
			SELECT artifact FROM knowledge_spatial_candidates
			WHERE lesson_id=$1 AND artifact IS NOT NULL
			ORDER BY ordinal`, lectureID)
		if err != nil {
			return nil, nil, err
		}
		defer rows.Close()
		sawArtifact := false
		for rows.Next() {
			var raw []byte
			if err = rows.Scan(&raw); err != nil {
				return nil, nil, err
			}
			sawArtifact = true
			assets, model, err := AssetsFromArtifact(lectureID, raw)
			if err != nil {
				return nil, nil, err
			}
			visible := Visible(assets)
			if len(visible) == 0 {
				continue
			}
			return visible, model, nil
		}
		if err = rows.Err(); err != nil {
			return nil, nil, err
		}
		if sawArtifact {
			return []Asset{}, nil, nil
		}
	}
	return Visible(forLecture(s.assets, lectureID)), nil, nil
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
