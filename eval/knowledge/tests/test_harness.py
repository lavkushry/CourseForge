"""Unit tests for the Living Video Knowledge evaluation harness."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from harness.answer import cited_timestamps_ms, format_clock, grounded_answer
from harness.faithfulness import LexicalFaithfulnessJudge, extract_claims, faithfulness_score
from harness.gold import GoldExample, load_gold_dir
from harness.metrics import citation_within_tolerance, hit_at_k, reciprocal_rank
from harness.report import all_passed, compare_thresholds
from harness.run import run_evaluation
from knowledge_worker.retrieve import RankedHit


def test_gold_loader_reads_required_fields():
    examples = load_gold_dir(ROOT / "gold")
    assert len(examples) >= 8
    assert all(e.question and e.video_id for e in examples)
    assert any(e.answerable for e in examples)
    assert any(not e.answerable for e in examples)


def test_citation_tolerance_and_clock():
    assert format_clock(8000) == "0:08"
    assert cited_timestamps_ms("see [0:08] and [1:05]") == [8000, 65000]
    assert citation_within_tolerance([8200], [8000], tolerance_ms=5000)
    assert not citation_within_tolerance([20000], [8000], tolerance_ms=5000)


def test_retrieval_metrics_helpers():
    retrieved = ["a", "b", "c"]
    relevant = {"b"}
    assert hit_at_k(retrieved, relevant, 1) is False
    assert hit_at_k(retrieved, relevant, 2) is True
    assert reciprocal_rank(retrieved, relevant) == 0.5


def test_faithfulness_lexical_judge():
    judge = LexicalFaithfulnessJudge(min_overlap=0.35)
    ctx = ["Docker containers package applications with their dependencies"]
    assert judge.is_supported("Docker containers package applications", ctx)
    assert not judge.is_supported("quantum entanglement spins forever", ctx)
    claims = extract_claims("Based on the video:\n- [0:00] Docker containers package applications")
    assert claims
    score = faithfulness_score(
        "Based on the video:\n- [0:00] Docker containers package applications with dependencies",
        ctx,
        judge=judge,
    )
    assert score >= 0.9


def test_grounded_answer_abstains_when_unsupported():
    hits = [RankedHit("x", "unrelated", 0, 1, 0.01)]
    ans = grounded_answer(hits, supported=False)
    assert ans.abstained
    assert "not covered" in ans.text


def test_full_harness_meets_thresholds():
    metrics, rows, table = run_evaluation()
    assert "recall_at_1" in table
    assert metrics.n_examples >= 8
    assert metrics.abstention_recall >= 0.9
    assert all_passed(rows), table


def test_compare_thresholds_detects_failure():
    metrics, _, _ = run_evaluation()
    rows = compare_thresholds(metrics, {"mrr": 1.1})
    assert not all_passed(rows)
