"""Metric computations for Living Video Knowledge evaluation."""

from __future__ import annotations

from dataclasses import dataclass, field

from harness.answer import cited_timestamps_ms
from harness.faithfulness import FaithfulnessJudge, faithfulness_score
from harness.gold import GoldExample
from knowledge_worker.retrieve import RankedHit


RECALL_KS = (1, 3, 5, 10)


@dataclass
class ExampleResult:
    example_id: str
    answerable: bool
    retrieved_ids: list[str]
    hits_at_k: dict[int, bool]
    reciprocal_rank: float
    abstained: bool
    citation_ok: bool | None
    faithfulness: float | None
    answer: str


@dataclass
class AggregateMetrics:
    recall_at_k: dict[int, float]
    mrr: float
    citation_accuracy: float
    faithfulness: float
    abstention_precision: float
    abstention_recall: float
    n_examples: int
    n_answerable: int
    n_unanswerable: int
    examples: list[ExampleResult] = field(default_factory=list)

    def as_flat(self) -> dict[str, float]:
        flat = {
            f"recall_at_{k}": self.recall_at_k[k]
            for k in RECALL_KS
        }
        flat.update(
            {
                "mrr": self.mrr,
                "citation_accuracy": self.citation_accuracy,
                "faithfulness": self.faithfulness,
                "abstention_precision": self.abstention_precision,
                "abstention_recall": self.abstention_recall,
            }
        )
        return flat


def _relevant_ids(example: GoldExample) -> set[str]:
    return set(example.relevant_chunk_ids)


def hit_at_k(retrieved: list[str], relevant: set[str], k: int) -> bool:
    if not relevant:
        return False
    return bool(relevant.intersection(retrieved[:k]))


def reciprocal_rank(retrieved: list[str], relevant: set[str]) -> float:
    for i, chunk_id in enumerate(retrieved, start=1):
        if chunk_id in relevant:
            return 1.0 / i
    return 0.0


def citation_within_tolerance(
    cited_ms: list[int],
    expected_ms: list[int],
    *,
    tolerance_ms: int,
) -> bool:
    if not expected_ms:
        return False
    if not cited_ms:
        return False
    for cited in cited_ms:
        if any(abs(cited - exp) <= tolerance_ms for exp in expected_ms):
            return True
    return False


def score_example(
    example: GoldExample,
    hits: list[RankedHit],
    answer_text: str,
    abstained: bool,
    *,
    tolerance_ms: int,
    judge: FaithfulnessJudge | None = None,
) -> ExampleResult:
    retrieved_ids = [h.chunk_id for h in hits]
    relevant = _relevant_ids(example)
    hits_map = {k: hit_at_k(retrieved_ids, relevant, k) for k in RECALL_KS}
    rr = reciprocal_rank(retrieved_ids, relevant) if example.answerable else 0.0

    citation_ok: bool | None = None
    faith: float | None = None
    if example.answerable and not abstained:
        citation_ok = citation_within_tolerance(
            cited_timestamps_ms(answer_text),
            example.expected_timestamps_ms,
            tolerance_ms=tolerance_ms,
        )
        contexts = [h.text for h in hits]
        faith = faithfulness_score(answer_text, contexts, judge=judge)
    elif example.answerable and abstained:
        citation_ok = False
        faith = 0.0

    return ExampleResult(
        example_id=example.id,
        answerable=example.answerable,
        retrieved_ids=retrieved_ids,
        hits_at_k=hits_map,
        reciprocal_rank=rr,
        abstained=abstained,
        citation_ok=citation_ok,
        faithfulness=faith,
        answer=answer_text,
    )


def aggregate(results: list[ExampleResult]) -> AggregateMetrics:
    answerable = [r for r in results if r.answerable]
    unanswerable = [r for r in results if not r.answerable]

    recall: dict[int, float] = {}
    for k in RECALL_KS:
        if not answerable:
            recall[k] = 0.0
        else:
            recall[k] = sum(1 for r in answerable if r.hits_at_k[k]) / len(answerable)

    mrr = (
        sum(r.reciprocal_rank for r in answerable) / len(answerable)
        if answerable
        else 0.0
    )

    citation_vals = [r.citation_ok for r in answerable if r.citation_ok is not None]
    citation_accuracy = (
        sum(1 for v in citation_vals if v) / len(citation_vals) if citation_vals else 0.0
    )

    faith_vals = [r.faithfulness for r in answerable if r.faithfulness is not None]
    faithfulness = sum(faith_vals) / len(faith_vals) if faith_vals else 0.0

    abstentions = [r for r in results if r.abstained]
    true_abstentions = [r for r in abstentions if not r.answerable]
    abstention_precision = (
        len(true_abstentions) / len(abstentions) if abstentions else 1.0
    )
    abstention_recall = (
        sum(1 for r in unanswerable if r.abstained) / len(unanswerable)
        if unanswerable
        else 1.0
    )

    return AggregateMetrics(
        recall_at_k=recall,
        mrr=mrr,
        citation_accuracy=citation_accuracy,
        faithfulness=faithfulness,
        abstention_precision=abstention_precision,
        abstention_recall=abstention_recall,
        n_examples=len(results),
        n_answerable=len(answerable),
        n_unanswerable=len(unanswerable),
        examples=results,
    )
