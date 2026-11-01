"""
Goal Pacing & Ratio Calculator
Target North Star: 5 Calls/Day
"""

from typing import Dict, Any

DAILY_QUOTAS = {
    "applications": {"min": 25, "target": 35},
    "recruiter_outreach": {"min": 10, "target": 15},
    "follow_ups": {"min": 5, "target": 8},
    "calls_scheduled": {"target": 5.0}
}

class PacingCalculator:
    @staticmethod
    def calculate_pacing_ratio(calls_scheduled: int) -> float:
        """Pacing ratio: calls / 5.0 (1.0 = 100% of North Star goal)."""
        target = DAILY_QUOTAS["calls_scheduled"]["target"]
        return round(float(calls_scheduled) / target, 2)

    @staticmethod
    def evaluate_funnel_health(metrics: Dict[str, Any]) -> Dict[str, Any]:
        calls = metrics.get("calls_scheduled", 0)
        apps = metrics.get("applications", 0)
        outreach = metrics.get("recruiter_outreach", 0)
        followups = metrics.get("follow_ups", 0)

        ratio = PacingCalculator.calculate_pacing_ratio(calls)

        return {
            "calls_scheduled": calls,
            "target_calls": DAILY_QUOTAS["calls_scheduled"]["target"],
            "pacing_ratio": ratio,
            "pacing_percentage": int(ratio * 100),
            "applications_status": "ON_TRACK" if apps >= DAILY_QUOTAS["applications"]["min"] else "BEHIND",
            "outreach_status": "ON_TRACK" if outreach >= DAILY_QUOTAS["recruiter_outreach"]["min"] else "BEHIND",
            "followups_status": "ON_TRACK" if followups >= DAILY_QUOTAS["follow_ups"]["min"] else "BEHIND"
        }
