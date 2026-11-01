"""
Keyword Utility Miner & Diff-in-Diff Attribution Engine
Calculates token utility: U = Demand / max(1, Saturation)
"""

from typing import Dict, Any, List

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
            demand = item.get("demand", 0)
            saturation = max(1, item.get("saturation", 1))
            score = round(demand / float(saturation), 2)
            results.append({
                "token": item.get("token", ""),
                "demand_frequency": demand,
                "saturation_count": saturation,
                "utility_score": score,
                "claimable": item.get("claimable", True)
            })
        results.sort(key=lambda x: x["utility_score"], reverse=True)
        return results
