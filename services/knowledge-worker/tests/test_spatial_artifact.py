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


def test_indexing_pipeline_does_not_import_the_generator():
    root = Path(__file__).resolve().parents[1] / "knowledge_worker"
    for name in ("worker.py", "pipeline.py", "index_pipeline.py"):
        assert "spatial_artifact" not in (root / name).read_text(encoding="utf-8")
