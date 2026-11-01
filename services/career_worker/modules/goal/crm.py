"""
Recruiter CRM & High-Signal Outreach Pipeline (Multi-Profile Aware)
"""

from typing import Dict, Any, List, Optional
from services.career_worker.core.candidate_profile import CandidateProfile

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
    def generate_connection_note_300(
        recruiter_name: str,
        company: str,
        profile: Optional[Any] = None,
    ) -> str:
        """300-char max LinkedIn connection request note tailored to any candidate profile."""
        if profile is None:
            note = (
                f"Hi {recruiter_name}, noticed you recruit Azure Data Engineers at {company}. "
                "I bring 2.5 YOE with Azure Databricks, PySpark, Delta Lake & ADF (Medallion Lakehouse). "
                "Immediate joiner (<=15 days notice), ₹20-25 LPA target. Best, Lavkush"
            )
            return note[:300]

        prof = CandidateProfile.from_dict(profile)
        first_name = prof.full_name.split()[0] if prof.full_name else "Candidate"
        top_skills = ", ".join(prof.primary_skills[:4]) if prof.primary_skills else prof.target_role
        note = (
            f"Hi {recruiter_name}, noticed you hire for {prof.target_role} roles at {company}. "
            f"I bring {prof.total_yoe} YOE in {top_skills}. "
            f"{prof.notice_period_days}-day notice, {prof.target_ctc_range} target. Best, {first_name}"
        )
        return note[:300]

    @staticmethod
    def generate_engineering_pitch(
        recruiter_name: str,
        company: str,
        profile: Optional[Any] = None,
    ) -> str:
        """InMail / Message pitch dynamically generated from the user's ground-truth profile."""
        if profile is None:
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

        prof = CandidateProfile.from_dict(profile)
        top_skills = ", ".join(prof.primary_skills[:5]) if prof.primary_skills else prof.target_role
        locs = " / ".join(prof.preferred_locations[:3]) if prof.preferred_locations else "Remote"
        return (
            f"Hi {recruiter_name},\n\n"
            f"I hope you're having a productive week. I'm reaching out regarding {prof.target_role} opportunities at {company}.\n\n"
            f"Quick snapshot of my background ({prof.total_yoe} YOE):\n"
            f"• Core Stack: {top_skills}\n"
            f"• Availability: {prof.notice_period_days}-day notice period, targeting {prof.target_ctc_range} in {locs}.\n\n"
            "I'd love to jump on a quick 10-minute screening call this week if you have an open role.\n\n"
            f"Best regards,\n{prof.full_name} | {prof.phone} | {prof.email}"
        )
