"""
Recruiter CRM & High-Signal Outreach Pipeline
"""

from typing import Dict, Any, List

class RecruiterCRM:
    STAGES = [
        "DRAFT_PENDING_MANUAL_SEND",
        "CONTACTED",
        "CONNECTED",
        "PITCH_SENT",
        "CALL_SCHEDULED",
        "TECH_SCREEN",
        "REJECTED",
        "OFFER"
    ]

    @staticmethod
    def generate_connection_note_300(recruiter_name: str, company: str) -> str:
        """300-char max LinkedIn connection request note."""
        note = (
            f"Hi {recruiter_name}, noticed you recruit Azure Data Engineers at {company}. "
            "I bring 2.5 YOE with Azure Databricks, PySpark, Delta Lake & ADF (Medallion Lakehouse). "
            "Immediate joiner (<=15 days notice), ₹20-25 LPA target. Best, Lavkush"
        )
        return note[:300]

    @staticmethod
    def generate_engineering_pitch(recruiter_name: str, company: str) -> str:
        """InMail / Message pitch emphasizing Medallion Lakehouse & production ETL."""
        return (
            f"Hi {recruiter_name},\n\n"
            f"I hope you're having a productive week. I'm reaching out regarding Azure Data Engineer opportunities at {company}.\n\n"
            "Quick snapshot of my production track record (2.5 YOE at CGI & HFCL):\n"
            "• Azure Databricks & PySpark: Engineered Medallion Lakehouse pipelines processing 2M+ events daily with ACID Delta guarantees.\n"
            "• ADF & Delta Lake CDC: Reduced ETL pipeline runtimes by 35% using Delta MERGE optimization.\n"
            "• Immediate Joiner: 15-day notice period, targeting ₹20–25 LPA in Bengaluru / Hyderabad / Remote.\n\n"
            "I'd love to jump on a quick 10-minute screening call this week if you have an open role.\n\n"
            "Best regards,\nLavkush Kumar | +91-9122036484 | lav84095@gmail.com"
        )
