"""Confidence gate for spatial assets. Fixtures are synthetic lectures."""

from __future__ import annotations

import json
from pathlib import Path

from knowledge_worker.index_pipeline import gate_spatial_for_index
from knowledge_worker.spatial_confidence import (
    CAPTION_WEIGHT,
    CONCEPT_WEIGHT,
    KEYFRAME_WEIGHT,
    LABEL_THRESHOLD,
    OCR_WEIGHT,
    RELEASE_THRESHOLD,
    gate_spatial_asset,
    render_spatial_inspect_html,
    score_spatial_confidence,
)

FIXTURE = Path(__file__).parent / "fixtures" / "spatial_confidence_cases.json"
INSPECT = Path(__file__).resolve().parents[1] / "fixtures" / "spatial_confidence_inspect.html"
ORDER = ("clean", "noisy", "labeled")


def _cases() -> dict:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def _gated(name: str) -> dict:
    case = _cases()[name]
    gated = gate_spatial_asset(case["asset"])
    gated["title"] = case["title"]
    return gated


def test_weights_are_obvious_and_sum_to_one():
    assert OCR_WEIGHT == 0.35
    assert CAPTION_WEIGHT == 0.30
    assert CONCEPT_WEIGHT == 0.20
    assert KEYFRAME_WEIGHT == 0.15
    assert round(OCR_WEIGHT + CAPTION_WEIGHT + CONCEPT_WEIGHT + KEYFRAME_WEIGHT, 10) == 1
    assert RELEASE_THRESHOLD == 0.75
    assert LABEL_THRESHOLD == 0.45


def test_each_signal_contributes_only_its_weight():
    assert score_spatial_confidence({"ocr_confidence": 1}) == 0.35
    assert score_spatial_confidence({"ocr_confidence": 50}) == 0.175
    assert (
        score_spatial_confidence(
            {
                "vision_caption": "btree nodes split",
                "transcript": "btree nodes split",
            }
        )
        == 0.30
    )
    assert (
        score_spatial_confidence(
            {
                "vision_caption": "btree nodes split",
                "concepts": [{"title": "btree nodes split", "summary": ""}],
            }
        )
        == 0.20
    )
    assert (
        score_spatial_confidence(
            {"keyframe_path": "frames/slide.jpg", "keyframe_time_ms": 1000, "width": 10, "height": 10}
        )
        == 0.15
    )


def test_missing_signals_score_zero_and_do_not_raise():
    assert score_spatial_confidence(None) == 0
    assert score_spatial_confidence({}) == 0
    assert score_spatial_confidence([]) == 0
    assert score_spatial_confidence("nope") == 0
    assert score_spatial_confidence({"ocr_confidence": "high", "width": "wide", "concepts": 3}) == 0
    held = gate_spatial_asset(None)
    assert held["decision"] == "hold"
    assert held["show_asset"] is False
    assert held["source_href"] == ""
    assert "not part of the lecture" in held["student_text"]


def test_clean_source_is_released_with_return_link():
    gated = _gated("clean")
    assert gated["score"] == 0.9755
    assert gated["signals"] == {
        "ocr": 0.93,
        "caption_transcript": 1.0,
        "concept_support": 1.0,
        "keyframe": 1.0,
    }
    assert gated["decision"] == "release"
    assert gated["show_asset"] is True
    assert gated["warning_required"] is False
    assert gated["student_text"] == "Original lecture at 1:24"
    assert gated["source_second"] == 84
    assert gated["lecture_id"] == "lec-btree-01"
    assert gated["source_href"] == "#learning/lec-btree-01?t=84"
    assert gated["source_link_text"] == "Original lecture at 1:24"


def test_noisy_source_is_withheld_and_still_links_to_the_second():
    gated = _gated("noisy")
    assert gated["score"] == 0.063
    assert gated["signals"]["ocr"] == 0.18
    assert gated["signals"]["caption_transcript"] == 0
    assert gated["signals"]["concept_support"] == 0
    assert gated["signals"]["keyframe"] == 0
    assert gated["decision"] == "hold"
    assert gated["show_asset"] is False
    assert gated["student_text"] == (
        "Withheld — this spatial asset is not part of the lecture. Original lecture at 3:30."
    )
    assert gated["source_second"] == 210
    assert gated["source_href"] == "#learning/lec-btree-01?t=210"


def test_partial_source_is_labeled_and_not_dismissible():
    gated = _gated("labeled")
    assert gated["score"] == 0.6443
    assert gated["decision"] == "label"
    assert gated["show_asset"] is True
    assert gated["warning_required"] is True
    assert gated["dismissible"] is False
    assert gated["student_text"] == "AI-generated — verify against original lecture at 2:06"
    assert gated["source_href"] == "#learning/lec-btree-01?t=126"
    assert gated["timestamp"] == "2:06"


def test_ranking_confidence_is_not_treated_as_ocr():
    gated = gate_spatial_asset(
        {
            "lecture_id": "lec-btree-01",
            "source_second": 10,
            "confidence": 0.99,
            "vision_caption": "purple dragon orbits the castle",
            "transcript": "purple dragon orbits the castle",
            "concepts": [{"title": "Dragon", "summary": "purple dragon orbits the castle"}],
            "keyframe_path": "frames/dragon.jpg",
            "keyframe_time_ms": 10000,
        }
    )
    assert gated["signals"]["ocr"] == 0
    assert gated["decision"] == "label"


def test_missing_timestamp_holds_even_when_the_score_is_high():
    asset = dict(_cases()["clean"]["asset"])
    asset.pop("source_second")
    asset.pop("keyframe_time_ms")
    gated = gate_spatial_asset(asset)
    assert gated["score"] == 0.8255
    assert gated["decision"] == "hold"
    assert gated["show_asset"] is False
    assert gated["source_href"] == ""


def test_keyframe_ocr_and_chapter_concepts_fill_missing_signals():
    gated = gate_spatial_asset(
        {"kind": "3d", "keyframe_ordinal": 1},
        lecture_id="lec-btree-01",
        segments=[{"start_ms": 80000, "end_ms": 90000, "text": "B-tree nodes split when the page is full"}],
        keyframes=[
            {
                "ordinal": 1,
                "time_ms": 84000,
                "path": "keyframes/btree-split.jpg",
                "width": 1280,
                "height": 720,
                "ocr": {"text": "B-tree nodes split when the page is full", "confidence": 0.93, "tags": ["slide"]},
                "vision_caption": "B-tree nodes split when the page is full",
            }
        ],
        concepts=[{"title": "B-Tree page split", "summary": "nodes split when the page is full"}],
    )
    assert gated["signals"]["ocr"] == 0.93
    assert gated["signals"]["keyframe"] == 1.0
    assert gated["decision"] == "release"
    assert gated["source_href"] == "#learning/lec-btree-01?t=84"


def test_index_path_gates_payload_and_keyframe_assets():
    clean = _cases()["clean"]["asset"]
    noisy = _cases()["noisy"]["asset"]
    gates = gate_spatial_for_index(
        "lec-btree-01",
        segments=[],
        keyframes=[
            {
                "ordinal": 0,
                "time_ms": 126000,
                "path": "keyframes/from-frame.jpg",
                "width": 640,
                "height": 360,
                "spatial": _cases()["labeled"]["asset"],
            }
        ],
        chapters=[{"title": "Other", "summary": "unrelated chapter"}],
        payload={"spatial_candidates": [clean, "skip-me", noisy]},
    )
    by_id = {item["asset_id"]: item for item in gates}
    assert by_id["spatial-btree-clean"]["decision"] == "release"
    assert by_id["spatial-btree-noisy"]["show_asset"] is False
    assert by_id["spatial-btree-labeled"]["warning_required"] is True
    assert gate_spatial_for_index("lec", [], [], []) == []


def test_zero_size_keyframe_is_not_clear():
    assert (
        score_spatial_confidence(
            {"keyframe_path": "frames/empty.jpg", "keyframe_time_ms": 0, "width": 0, "height": 10}
        )
        == 0
    )


def test_inspect_fixture_shows_withhold_and_label():
    sections = [_gated(name) for name in ORDER]
    html = render_spatial_inspect_html(sections)
    assert INSPECT.is_file()
    assert INSPECT.read_text(encoding="utf-8") == html
    assert 'data-decision="hold"' in html
    assert 'data-decision="label"' in html
    assert 'data-decision="release"' in html
    assert html.count('class="spatial-asset"') == 2
    assert "AI-generated — verify against original lecture at 2:06" in html
    assert "Withheld — this spatial asset is not part of the lecture. Original lecture at 3:30." in html
    assert 'href="#learning/lec-btree-01?t=84"' in html
    assert 'href="#learning/lec-btree-01?t=210"' in html
    assert "dismiss" not in html.lower()
