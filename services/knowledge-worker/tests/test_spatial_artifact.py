import json
from pathlib import Path

import pytest

from knowledge_worker.spatial_artifact import (
    SpatialArtifactError,
    concept_id_for,
    generate_artifact,
    glb_json,
    label_supported,
)

EXAMPLE = Path(__file__).resolve().parents[1] / "examples" / "spatial" / "redundancy-lrs"
LABELS = [
    "Primary region",
    "Datacenter",
    "LRS",
    "Storage Account",
    "Copy 1",
    "Copy2",
    "Copy3",
]


def _candidate(**overrides):
    raw = json.loads((EXAMPLE / "candidate.json").read_text(encoding="utf-8"))
    raw.update(overrides)
    return raw


def test_label_must_occur_in_evidence_in_order():
    evidence = "Primary region\nLRS\nStorage\nAccount"
    assert label_supported("Storage Account", evidence)
    assert not label_supported("Account Storage", evidence)
    assert not label_supported("ZRS", evidence)


def test_rejects_a_label_the_evidence_does_not_contain(tmp_path: Path):
    candidate = _candidate()
    candidate["nodes"].append(
        {"label": "ZRS", "parent": "Primary region", "concept_id": concept_id_for(candidate["lecture_id"], "ZRS")}
    )
    candidate["concept_ids"].append(candidate["nodes"][-1]["concept_id"])
    with pytest.raises(SpatialArtifactError, match="ZRS"):
        generate_artifact(candidate, tmp_path)


def test_rejects_a_parent_that_is_not_a_source_label(tmp_path: Path):
    candidate = _candidate()
    candidate["nodes"][1]["parent"] = "Availability zone"
    with pytest.raises(SpatialArtifactError, match="Availability zone"):
        generate_artifact(candidate, tmp_path)


def test_library_example_uses_only_ocr_labels(tmp_path: Path):
    provenance = generate_artifact(
        _candidate(),
        tmp_path,
        keyframe_file=EXAMPLE / "keyframe.webp",
    )
    assert provenance["lecture_id"] == "54e8ac4d86229d113a38dccada0d7007b7251ad7"
    assert provenance["labels"] == LABELS
    assert provenance["concept_ids"] == [concept_id_for(provenance["lecture_id"], label) for label in LABELS]
    assert provenance["start_ms"] is None
    assert provenance["end_ms"] is None
    assert provenance["time_status"] == "unmeasured"
    assert (tmp_path / "keyframe.webp").is_file()
    scene = json.loads((tmp_path / "scene.json").read_text(encoding="utf-8"))
    assert [node["label"] for node in scene["nodes"]] == LABELS
    document = glb_json((tmp_path / "scene.glb").read_bytes())
    assert [node["name"] for node in document["nodes"]] == LABELS
    viewer = (tmp_path / "viewer.html").read_text(encoding="utf-8")
    for label in LABELS:
        assert label in viewer
    assert "ZRS" not in viewer
    assert "GRS" not in viewer


def test_indexing_pipeline_generates_from_the_worker_only():
    root = Path(__file__).resolve().parents[1] / "knowledge_worker"
    assert "spatial_artifact" in (root / "worker.py").read_text(encoding="utf-8")
    for name in ("pipeline.py", "index_pipeline.py"):
        assert "spatial_artifact" not in (root / name).read_text(encoding="utf-8")


def test_worker_scene_uses_the_ocr_diagram_and_the_confidence_gate():
    from knowledge_worker.spatial import rank_spatial_candidates
    from knowledge_worker.spatial_artifact import generated_scene
    from knowledge_worker.worker import IngestWorker

    lecture = json.loads(
        (Path(__file__).resolve().parent / "fixtures" / "spatial_lecture.json").read_text(encoding="utf-8")
    )
    measured = json.loads(json.dumps(lecture))
    for frame in measured["keyframes"]:
        frame["width"] = 1280
        frame["height"] = 720
        ocr = frame.get("ocr")
        if isinstance(ocr, dict) and str(ocr.get("text") or "").strip():
            ocr["confidence"] = 0.91
    candidates = rank_spatial_candidates(measured["segments"], measured["keyframes"], measured["concepts"])
    worker = object.__new__(IngestWorker)
    worker._attach_scene(
        measured["lesson_id"],
        candidates,
        measured["segments"],
        measured["keyframes"],
        measured["concepts"],
    )
    attached = [item for item in candidates if item.get("artifact")]
    assert len(attached) == 1
    artifact = attached[0]["artifact"]
    assert artifact["labels"] == ["API Gateway", "Auth", "Orders", "Queue"]
    assert "Presentation" not in artifact["labels"]
    assert attached[0]["keyframe_ordinal"] == 1
    assert artifact["decision"] in ("release", "label")
    assert artifact["glb_base64"]

    held = rank_spatial_candidates(lecture["segments"], lecture["keyframes"], lecture["concepts"])
    worker._attach_scene(
        lecture["lesson_id"],
        held,
        lecture["segments"],
        lecture["keyframes"],
        lecture["concepts"],
    )
    withheld = [item for item in held if item.get("artifact")]
    assert len(withheld) == 1
    assert withheld[0]["artifact"]["decision"] == "hold"
    assert withheld[0]["artifact"]["labels"] == ["API Gateway", "Auth", "Orders", "Queue"]
    assert generated_scene(lecture["lesson_id"], {"ocr_snippet": "API Gateway Auth Orders Queue"}, None) is None


def test_ocr_lines_become_scene_labels_and_nothing_else(tmp_path: Path):
    from knowledge_worker.spatial_artifact import generated_scene

    scene = generated_scene(
        "lesson",
        {
            "start_ms": 0,
            "end_ms": 8000,
            "keyframe_ordinal": 0,
            "ocr_snippet": "",
            "vision_snippet": "",
        },
        [
            {
                "ordinal": 0,
                "ocr": {"text": "API Gateway\nAuth\nOrders\nQueue"},
            }
        ],
    )
    assert scene is not None
    assert scene["labels"] == ["API Gateway", "Auth", "Orders", "Queue"]
    assert "Presentation" not in scene["labels"]
