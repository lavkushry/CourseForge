"""
6-Stage Automated Bottleneck Diagnostic Engine
Evaluates top-to-bottom candidate conversion funnel.
"""

from typing import Dict, Any, List

class DiagnosticEngine:
    @staticmethod
    def evaluate(metrics: Dict[str, Any]) -> List[Dict[str, str]]:
        alerts = []

        appearances = metrics.get("search_appearances", 0)
        contact_views = metrics.get("contact_views", 0)
        apps = metrics.get("applications_today", 0)
        outreach = metrics.get("outreaches_today", 0)
        replies = metrics.get("replies_today", 0)
        calls = metrics.get("calls_scheduled_today", 0)

        # 1. LOW_SEARCH_APPEARANCES (<150)
        if appearances < 150:
            alerts.append({
                "code": "LOW_SEARCH_APPEARANCES",
                "stage": "Resdex Ranking",
                "severity": "HIGH",
                "description": f"Weekly search appearances ({appearances}) below target (150).",
                "action_required": "Trigger Resdex profile bump and inject 25 core skill keywords."
            })

        # 2. LOW_CONTACT_VIEWS (<5 with >=100 appearances)
        if appearances >= 100 and contact_views < 5:
            alerts.append({
                "code": "LOW_CONTACT_VIEWS",
                "stage": "Headline Conversion",
                "severity": "HIGH",
                "description": f"Search visibility is healthy, but CTR ({contact_views} views) is low.",
                "action_required": "Strengthen headline with '15-Day Notice' and '₹20-25 LPA Medallion Lakehouse'."
            })

        # 3. LOW_APPLICATION_VELOCITY (<25/day)
        if apps < 25:
            alerts.append({
                "code": "LOW_APPLICATION_VELOCITY",
                "stage": "Top-of-Funnel",
                "severity": "MEDIUM",
                "description": f"Daily application count ({apps}) below target (25-35).",
                "action_required": "Dispatch Block 1 1-Click Apply batch for Azure Data Engineer vacancies."
            })

        # 4. LOW_OUTREACH_VOLUME (<10/day)
        if outreach < 10:
            alerts.append({
                "code": "LOW_OUTREACH_VOLUME",
                "stage": "Recruiter Outbound",
                "severity": "MEDIUM",
                "description": f"Recruiter outbound pitches ({outreach}) below quota (10-15).",
                "action_required": "Dispatch Afternoon Block 2 GCC Recruiter pitches."
            })

        # 5. LOW_REPLY_RATE (<15% when outreach >= 10)
        if outreach >= 10 and (replies / float(outreach)) < 0.15:
            alerts.append({
                "code": "LOW_REPLY_RATE",
                "stage": "Pitch Relevance",
                "severity": "MEDIUM",
                "description": "Recruiter response rate is below 15%.",
                "action_required": "Switch pitch template to Medallion Lakehouse ACID & Delta MERGE focus."
            })

        # 6. LOW_CALL_CONVERSION (<5 calls)
        if calls < 5:
            alerts.append({
                "code": "LOW_CALL_CONVERSION",
                "stage": "North Star Metric",
                "severity": "CRITICAL",
                "description": f"Scheduled screening calls ({calls}/5) below daily target.",
                "action_required": "Activate 48-Hour Recruiter Follow-Up batch and schedule screening slots."
            })

        return alerts
