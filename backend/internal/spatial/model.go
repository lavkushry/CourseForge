package spatial

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// Kind is one spatial presentation of a lecture moment.
type Kind string

const (
	Kind3D Kind = "3d"
	KindAR Kind = "ar"
	KindVR Kind = "vr"
)

// Decision is the quality-gate outcome for a spatial asset.
// release opens directly, label must warn and return to the lecture second,
// hold is omitted from every learning surface.
type Decision string

const (
	DecisionRelease Decision = "release"
	DecisionLabel   Decision = "label"
	DecisionHold    Decision = "hold"
)

// Asset is the read model learning surfaces consume.
// Evidence is stored with the artifact and is not part of the list payload.
type Asset struct {
	LectureID    string   `json:"lecture_id"`
	ConceptIDs   []string `json:"concept_ids"`
	StartSeconds float64  `json:"start_seconds"`
	EndSeconds   float64  `json:"end_seconds"`
	AssetURL     string   `json:"asset_url"`
	Kind         Kind     `json:"kind"`
	Decision     Decision `json:"decision"`
	Evidence     string   `json:"-"`
	Labels       []string `json:"labels,omitempty"`
}

type storedAsset struct {
	LectureID    string   `json:"lecture_id"`
	ConceptIDs   []string `json:"concept_ids"`
	StartSeconds float64  `json:"start_seconds"`
	EndSeconds   float64  `json:"end_seconds"`
	AssetURL     string   `json:"asset_url"`
	Kind         Kind     `json:"kind"`
	Decision     Decision `json:"decision"`
	Evidence     string   `json:"evidence"`
}

func (s storedAsset) asset() Asset {
	return Asset{
		LectureID:    s.LectureID,
		ConceptIDs:   append([]string(nil), s.ConceptIDs...),
		StartSeconds: s.StartSeconds,
		EndSeconds:   s.EndSeconds,
		AssetURL:     s.AssetURL,
		Kind:         s.Kind,
		Decision:     s.Decision,
		Evidence:     s.Evidence,
	}
}

// Scene is the authenticated description of one visible asset.
// It carries the transcript quote from the stored artifact and nothing else.
type Scene struct {
	LectureID    string   `json:"lecture_id"`
	ConceptIDs   []string `json:"concept_ids"`
	StartSeconds float64  `json:"start_seconds"`
	EndSeconds   float64  `json:"end_seconds"`
	Kind         Kind     `json:"kind"`
	Evidence     string   `json:"evidence"`
	Labels       []string `json:"labels,omitempty"`
}

// LectureWatch is the progress subject while a spatial view is open.
// Opening a spatial asset must not retarget or complete a lesson.
type LectureWatch struct {
	LessonID  string
	Completed bool
	Position  float64
}

// WatchAfterSpatialOpen returns the same lecture watch record.
// The asset is not a lesson, so it cannot change completion or ownership.
func WatchAfterSpatialOpen(watch LectureWatch, _ Asset) LectureWatch {
	return LectureWatch{
		LessonID:  watch.LessonID,
		Completed: watch.Completed,
		Position:  watch.Position,
	}
}

func parseCatalog(raw []byte) ([]Asset, error) {
	var file struct {
		Assets []storedAsset `json:"assets"`
	}
	if err := json.Unmarshal(raw, &file); err != nil {
		return nil, err
	}
	if len(file.Assets) == 0 {
		return nil, errors.New("spatial catalog is empty")
	}
	out := make([]Asset, 0, len(file.Assets))
	for _, item := range file.Assets {
		asset := item.asset()
		if err := validateAsset(asset); err != nil {
			return nil, err
		}
		out = append(out, asset)
	}
	return out, nil
}

func validateAsset(asset Asset) error {
	if strings.TrimSpace(asset.LectureID) == "" {
		return errors.New("spatial asset missing lecture id")
	}
	if len(asset.ConceptIDs) == 0 {
		return errors.New("spatial asset missing concept ids")
	}
	for _, id := range asset.ConceptIDs {
		if strings.TrimSpace(id) == "" {
			return errors.New("spatial asset has an empty concept id")
		}
	}
	if asset.StartSeconds < 0 || asset.EndSeconds <= asset.StartSeconds {
		return fmt.Errorf("spatial asset has an invalid time range")
	}
	switch asset.Kind {
	case Kind3D, KindAR, KindVR:
	default:
		return fmt.Errorf("spatial asset has kind %q", asset.Kind)
	}
	switch asset.Decision {
	case DecisionRelease, DecisionLabel, DecisionHold:
	default:
		return fmt.Errorf("spatial asset has decision %q", asset.Decision)
	}
	if strings.TrimSpace(asset.Evidence) == "" {
		return errors.New("spatial asset missing source evidence")
	}
	if !safeAssetURL(asset.AssetURL, asset.LectureID, asset.Kind) {
		return fmt.Errorf("spatial asset url is not an authenticated scene")
	}
	return nil
}

func safeAssetURL(raw, lectureID string, kind Kind) bool {
	if strings.Contains(raw, "://") || strings.Contains(raw, "..") || strings.HasPrefix(raw, "//") {
		return false
	}
	want := "/api/v1/lessons/" + lectureID + "/spatial/scene?kind=" + string(kind)
	return raw == want
}

// Visible drops held assets. Learning surfaces must not offer them.
func Visible(assets []Asset) []Asset {
	out := make([]Asset, 0, len(assets))
	for _, asset := range assets {
		if asset.Decision == DecisionHold {
			continue
		}
		out = append(out, asset)
	}
	return out
}

type storedScene struct {
	Decision     string   `json:"decision"`
	Labels       []string `json:"labels"`
	ConceptIDs   []string `json:"concept_ids"`
	Evidence     string   `json:"evidence"`
	StartSeconds float64  `json:"start_seconds"`
	EndSeconds   float64  `json:"end_seconds"`
	GLB          string   `json:"glb_base64"`
}

// AssetsFromArtifact expands one generated scene into the 3D, AR, and VR read models.
// A hold decision is returned so callers can drop it. An empty document is not an error.
func AssetsFromArtifact(lectureID string, raw []byte) ([]Asset, []byte, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil, nil
	}
	var scene storedScene
	if err := json.Unmarshal(raw, &scene); err != nil {
		return nil, nil, err
	}
	decision := Decision(scene.Decision)
	switch decision {
	case DecisionRelease, DecisionLabel, DecisionHold:
	default:
		return nil, nil, errors.New("spatial artifact decision")
	}
	if len(scene.ConceptIDs) == 0 || strings.TrimSpace(scene.Evidence) == "" {
		return nil, nil, nil
	}
	var glb []byte
	if scene.GLB != "" {
		decoded, err := base64.StdEncoding.DecodeString(scene.GLB)
		if err != nil {
			return nil, nil, err
		}
		glb = decoded
	}
	assets := make([]Asset, 0, 3)
	for _, kind := range []Kind{Kind3D, KindAR, KindVR} {
		asset := Asset{
			LectureID:    lectureID,
			ConceptIDs:   append([]string(nil), scene.ConceptIDs...),
			StartSeconds: scene.StartSeconds,
			EndSeconds:   scene.EndSeconds,
			AssetURL:     "/api/v1/lessons/" + lectureID + "/spatial/scene?kind=" + string(kind),
			Kind:         kind,
			Decision:     decision,
			Evidence:     scene.Evidence,
			Labels:       append([]string(nil), scene.Labels...),
		}
		if err := validateAsset(asset); err != nil {
			return nil, nil, err
		}
		assets = append(assets, asset)
	}
	return assets, glb, nil
}

func forLecture(assets []Asset, lectureID string) []Asset {
	out := make([]Asset, 0, len(assets))
	for _, asset := range assets {
		if asset.LectureID == lectureID {
			out = append(out, asset)
		}
	}
	return out
}
