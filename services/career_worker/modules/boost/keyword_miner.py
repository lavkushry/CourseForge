"""
Keyword Utility Miner & Diff-in-Diff Attribution Engine
Calculates token utility: U = Demand / max(1, Saturation)
"""

import math
from typing import Dict, Any, List, Optional


def _num(value: Any) -> Optional[float]:
    """Best-effort float for demand/saturation fields (None if unusable)."""
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) else None

class KeywordUtilityMiner:
    DEFAULT_TOKENS = [
        {"token": "Azure Databricks", "demand": 142, "saturation": 45, "claimable": True},
        {"token": "PySpark Delta Lake", "demand": 128, "saturation": 38, "claimable": True},
        {"token": "Medallion Architecture", "demand": 95, "saturation": 20, "claimable": True},
        {"token": "Azure Data Factory (ADF)", "demand": 160, "saturation": 70, "claimable": True},
        {"token": "Synapse Analytics", "demand": 88, "saturation": 35, "claimable": True},
        {"token": "15 Days Notice", "demand": 180, "saturation": 15, "claimable": True},
        {"token": "Lakehouse Optimization", "demand": 74, "saturation": 18, "claimable": True},
        {"token": "Delta Live Tables (DLT)", "demand": 62, "saturation": 14, "claimable": True},
    ]

    @classmethod
    def calculate_utilities(cls, custom_data: List[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        raw = custom_data or cls.DEFAULT_TOKENS
        results = []
        for item in raw:
            raw_demand = item.get("demand", 0)
            raw_saturation = item.get("saturation", 1)
            # Non-numeric/None demand or saturation (e.g. from scraped JD
            # data) previously raised TypeError in max()/division and lost
            # the whole utility table; degrade per-item instead.
            demand_f = _num(raw_demand)
            saturation_f = _num(raw_saturation)
            demand = raw_demand if demand_f is not None and isinstance(raw_demand, (int, float)) else (demand_f or 0.0)
            saturation = max(1, raw_saturation) if saturation_f is not None and isinstance(raw_saturation, (int, float)) else max(1.0, saturation_f or 1.0)
            score = round(float(demand) / float(saturation), 2)
            results.append({
                "token": item.get("token", ""),
                "demand_frequency": demand,
                "saturation_count": saturation,
                "utility_score": score,
                "claimable": item.get("claimable", True)
            })
        results.sort(key=lambda x: x["utility_score"], reverse=True)
        return results
