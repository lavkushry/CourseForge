"""Threshold loading, comparison, and metrics table printing."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

from harness.metrics import AggregateMetrics


def load_thresholds(path: Path) -> dict[str, Any]:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or "metrics" not in data:
        raise ValueError(f"thresholds file {path} must contain a metrics map")
    metrics = data["metrics"]
    if not isinstance(metrics, dict):
        raise ValueError("thresholds.metrics must be a mapping")
    return data


def compare_thresholds(
    metrics: AggregateMetrics,
    thresholds: dict[str, float],
) -> list[tuple[str, float, float, bool]]:
    """Return rows of (name, actual, floor, passed)."""
    flat = metrics.as_flat()
    rows: list[tuple[str, float, float, bool]] = []
    for name, floor in thresholds.items():
        actual = float(flat.get(name, 0.0))
        rows.append((name, actual, float(floor), actual >= float(floor)))
    return rows


def format_metrics_table(
    metrics: AggregateMetrics,
    threshold_rows: list[tuple[str, float, float, bool]] | None = None,
) -> str:
    """ASCII metrics table for CI logs / docs."""
    lines = [
        "Living Video Knowledge — evaluation metrics",
        f"examples={metrics.n_examples} answerable={metrics.n_answerable} "
        f"unanswerable={metrics.n_unanswerable}",
        "",
        f"{'metric':<24} {'value':>8} {'threshold':>10} {'pass':>6}",
        "-" * 52,
    ]
    if threshold_rows is None:
        for name, value in metrics.as_flat().items():
            lines.append(f"{name:<24} {value:>8.3f} {'—':>10} {'—':>6}")
    else:
        for name, actual, floor, passed in threshold_rows:
            flag = "ok" if passed else "FAIL"
            lines.append(f"{name:<24} {actual:>8.3f} {floor:>10.3f} {flag:>6}")
    return "\n".join(lines)


def all_passed(threshold_rows: list[tuple[str, float, float, bool]]) -> bool:
    return all(passed for _, _, _, passed in threshold_rows)
