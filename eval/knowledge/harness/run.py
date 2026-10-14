"""Run Living Video Knowledge evaluation over gold + synthetic fixtures."""

from __future__ import annotations

from pathlib import Path

from harness.answer import grounded_answer
from harness.corpus import load_corpus
from harness.faithfulness import LexicalFaithfulnessJudge
from harness.gold import load_gold_dir
from harness.metrics import AggregateMetrics, score_example, aggregate
from harness.report import (
    all_passed,
    compare_thresholds,
    format_metrics_table,
    load_thresholds,
)
from harness.retrieve import FixtureRetriever

DEFAULT_ROOT = Path(__file__).resolve().parents[1]


def run_evaluation(
    *,
    gold_dir: Path | None = None,
    corpus_path: Path | None = None,
    thresholds_path: Path | None = None,
    top_k: int = 10,
    # Lexical Jaccard can hit ~0.05 on stopword-only overlap; require clearer support.
    support_min_score: float = 0.08,
) -> tuple[AggregateMetrics, list[tuple[str, float, float, bool]], str]:
    root = DEFAULT_ROOT
    gold_dir = gold_dir or root / "gold"
    corpus_path = corpus_path or root / "fixtures" / "corpus.json"
    thresholds_path = thresholds_path or root / "thresholds.yaml"

    examples = load_gold_dir(gold_dir)
    corpus = load_corpus(corpus_path)
    thresholds_doc = load_thresholds(thresholds_path)
    tolerance_ms = int(thresholds_doc.get("citation_tolerance_ms", 5000))
    metric_floors = {str(k): float(v) for k, v in thresholds_doc["metrics"].items()}

    retriever = FixtureRetriever(corpus)
    judge = LexicalFaithfulnessJudge()
    results = []
    for example in examples:
        hits = retriever.search(example.video_id, example.question, limit=top_k)
        supported = retriever.supported(hits, min_score=support_min_score)
        answer = grounded_answer(hits, supported=supported)
        results.append(
            score_example(
                example,
                hits,
                answer.text,
                answer.abstained,
                tolerance_ms=tolerance_ms,
                judge=judge,
            )
        )

    metrics = aggregate(results)
    rows = compare_thresholds(metrics, metric_floors)
    table = format_metrics_table(metrics, rows)
    return metrics, rows, table


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description="Living Video Knowledge eval harness")
    parser.add_argument("--gold-dir", type=Path, default=None)
    parser.add_argument("--corpus", type=Path, default=None)
    parser.add_argument("--thresholds", type=Path, default=None)
    parser.add_argument("--top-k", type=int, default=10)
    args = parser.parse_args(argv)

    metrics, rows, table = run_evaluation(
        gold_dir=args.gold_dir,
        corpus_path=args.corpus,
        thresholds_path=args.thresholds,
        top_k=args.top_k,
    )
    print(table)
    print()
    if all_passed(rows):
        print("All metrics meet thresholds.")
        return 0
    failed = [name for name, _, _, passed in rows if not passed]
    print("Below threshold:", ", ".join(failed))
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
