package spatial

import (
	"strings"
	"testing"
)

func TestCatalogUsesLectureEvidenceAndHidesHeldAssets(t *testing.T) {
	assets, err := parseCatalog(fixtureJSON)
	if err != nil {
		t.Fatal(err)
	}
	if len(assets) != 3 {
		t.Fatalf("assets %d", len(assets))
	}
	visible := Visible(forLecture(assets, "lesson"))
	if len(visible) != 2 {
		t.Fatalf("visible %#v", visible)
	}
	for _, asset := range visible {
		if asset.Decision == DecisionHold {
			t.Fatalf("held asset leaked %#v", asset)
		}
		if asset.LectureID != "lesson" || asset.StartSeconds != 0 || asset.EndSeconds != 4 {
			t.Fatalf("moment %#v", asset)
		}
		if len(asset.ConceptIDs) != 1 || asset.ConceptIDs[0] != "containers" {
			t.Fatalf("concept ids %#v", asset.ConceptIDs)
		}
		if asset.Evidence != "docker containers package applications" {
			t.Fatalf("evidence %q", asset.Evidence)
		}
		if strings.Contains(asset.AssetURL, "odysee") || strings.Contains(strings.ToLower(asset.AssetURL), "token") {
			t.Fatalf("asset url %s", asset.AssetURL)
		}
	}
	if visible[0].Kind != Kind3D || visible[0].Decision != DecisionRelease {
		t.Fatalf("release %#v", visible[0])
	}
	if visible[1].Kind != KindAR || visible[1].Decision != DecisionLabel {
		t.Fatalf("label %#v", visible[1])
	}
	held := forLecture(assets, "lesson")[2]
	if held.Kind != KindVR || held.Decision != DecisionHold {
		t.Fatalf("hold %#v", held)
	}
}

func TestWatchAfterSpatialOpenStaysOnTheLecture(t *testing.T) {
	asset := Asset{LectureID: "lesson", Kind: Kind3D, Decision: DecisionRelease, AssetURL: "/api/v1/lessons/lesson/spatial/scene?kind=3d"}
	before := LectureWatch{LessonID: "lesson", Completed: false, Position: 10}
	after := WatchAfterSpatialOpen(before, asset)
	if after != before {
		t.Fatalf("spatial open retargeted progress: %#v", after)
	}
	completed := LectureWatch{LessonID: "lesson", Completed: true, Position: 4}
	if WatchAfterSpatialOpen(completed, asset).Completed != true {
		t.Fatal("spatial open cleared an existing completion")
	}
}

func TestGeneratedSceneHidesAHoldAndPublishesThreeModes(t *testing.T) {
	raw := []byte(`{"decision":"hold","labels":["API Gateway","Auth"],"concept_ids":["kco_gateway"],"evidence":"API Gateway\nAuth","start_seconds":0,"end_seconds":8,"glb_base64":""}`)
	assets, _, err := AssetsFromArtifact("lesson", raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(Visible(assets)) != 0 {
		t.Fatalf("held scene leaked %#v", Visible(assets))
	}
	released := []byte(`{"decision":"release","labels":["API Gateway","Auth"],"concept_ids":["kco_gateway"],"evidence":"API Gateway\nAuth","start_seconds":0,"end_seconds":8,"glb_base64":"YQ=="}`)
	assets, model, err := AssetsFromArtifact("lesson", released)
	if err != nil {
		t.Fatal(err)
	}
	if len(assets) != 3 || string(model) != "a" {
		t.Fatalf("assets %d model %q", len(assets), model)
	}
	if assets[0].Kind != Kind3D || assets[1].Kind != KindAR || assets[2].Kind != KindVR {
		t.Fatalf("kinds %#v", assets)
	}
	if assets[0].Labels[0] != "API Gateway" || assets[0].Evidence != "API Gateway\nAuth" {
		t.Fatalf("source %#v", assets[0])
	}
}

func TestRejectsOpenAssetURLs(t *testing.T) {
	raw := []byte(`{"assets":[{"lecture_id":"lesson","concept_ids":["containers"],"start_seconds":0,"end_seconds":4,"asset_url":"https://cdn.example/model.glb","kind":"3d","decision":"release","evidence":"docker containers package applications"}]}`)
	if _, err := parseCatalog(raw); err == nil {
		t.Fatal("accepted an off-origin asset url")
	}
}
