"""Spatial candidate scoring from synthetic lecture artifacts."""

from __future__ import annotations

import json
from pathlib import Path

from knowledge_worker.spatial import _agreement, rank_spatial_candidates, score_bundle

FIXTURE = Path(__file__).parent / "fixtures" / "spatial_lecture.json"


def _bundle() -> dict:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def test_fixture_ranks_diagram_above_speech_and_skips_commands():
    ranked = score_bundle(_bundle())
    candidates = ranked["candidates"]
    assert ranked["lesson_id"] == "fixture-request-path"
    assert [item["ordinal"] for item in candidates] == list(range(len(candidates)))
    assert len(candidates) == 3
    confidences = [item["confidence"] for item in candidates]
    assert confidences == sorted(confidences, reverse=True)
    top = candidates[0]
    assert top["confidence"] > candidates[-1]["confidence"]
    assert top["signals"]["on_screen_diagram"] == 1.0
    assert top["concept_ids"] == ["kco_layers"]
    assert top["signals"]["concept_agreement"] > 0.8
    request = next(item for item in candidates if item["concept_ids"] == ["kco_request"])
    assert "API Gateway" in request["ocr_snippet"]
    assert "arrows" in request["vision_snippet"]
    assert request["signals"]["on_screen_diagram"] == 1.0
    assert request["start_ms"] < request["end_ms"]
    assert "spatial view" in request["reason"].lower()
    assert all("kubectl" not in item["ocr_snippet"] for item in candidates)
    speech = candidates[-1]
    assert speech["signals"]["on_screen_diagram"] == 0
    assert speech["confidence"] <= 0.49
    assert speech["concept_ids"] == ["kco_dataplane"]
    assert "keyframe_ordinal" not in speech


def test_missing_vision_and_ocr_still_score():
    bundle = _bundle()
    diagram = next(frame for frame in bundle["keyframes"] if frame["id"] == "kf_request")
    diagram.pop("vision_caption")
    vision_only = next(frame for frame in bundle["keyframes"] if frame["id"] == "kf_layers")
    vision_only["ocr"] = {"text": "", "tags": []}
    ranked = rank_spatial_candidates(bundle["segments"], bundle["keyframes"], bundle["concepts"])
    by_concept = {tuple(item["concept_ids"]): item for item in ranked}
    assert by_concept[("kco_request",)]["signals"]["on_screen_diagram"] >= 0.85
    assert by_concept[("kco_request",)]["vision_snippet"] == ""
    layers = by_concept[("kco_layers",)]
    assert layers["ocr_snippet"] == ""
    assert layers["signals"]["on_screen_diagram"] == 1.0
    assert layers["confidence"] >= 0.40


def test_empty_artifacts_return_no_candidates():
    assert rank_spatial_candidates([], [], []) == []
    assert rank_spatial_candidates(None, None, None) == []


def test_command_slide_without_architecture_is_omitted():
    candidates = rank_spatial_candidates(
        [{"start_ms": 0, "end_ms": 4000, "text": "Run the install command now."}],
        [{
            "ordinal": 0,
            "time_ms": 1000,
            "path": "frames/cmd.jpg",
            "ocr": {"text": "sudo apt update", "tags": ["command", "code"]},
        }],
        [{"id": "kco_install", "ordinal": 0, "title": "Install", "summary": "Update packages", "start_ms": 0, "end_ms": 4000}],
    )
    assert candidates == []


def test_academy_seconds_and_embedded_caption_are_read():
    candidates = rank_spatial_candidates(
        [{"start": 10.0, "end": 25.0, "text": "The request path flows into the queue."}],
        [{
            "start": 12.0,
            "frame_path": "frames/at_0000012.jpg",
            "text": "API Gateway\nAuth\nOrders\nQueue\n\nVisual explanation:\nArchitecture diagram with arrows between the services.",
        }],
        [{"id": "kco_path", "title": "Request path", "summary": "gateway auth orders queue", "start": 10, "end": 25}],
    )
    assert len(candidates) == 1
    assert candidates[0]["start_ms"] >= 10_000
    assert "Architecture diagram" in candidates[0]["vision_snippet"]
    assert "API Gateway" in candidates[0]["ocr_snippet"]
    assert candidates[0]["concept_ids"] == ["kco_path"]


def test_concept_agreement_ignores_ocr_that_only_matches_the_caption():
    assert _agreement(set(), "layers components", "layers components") == 0
    assert _agreement({"queue"}, "queue gateway", "unrelated caption") > 0
