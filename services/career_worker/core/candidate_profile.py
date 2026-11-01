"""
Candidate Profile & Ground Truth Matrix
Contains factual ground-truth parameters, dynamic multi-user CandidateProfile model,
screening answer resolver, and strict whitelist/blacklist guards for profile mutations.
"""

from dataclasses import dataclass, field
from typing import Dict, Any, List, Optional

CANDIDATE_FACTS: Dict[str, Any] = {
    "name": "Lavkush Kumar",
    "full_name": "Lavkush Kumar",
    "email": "lav84095@gmail.com",
    "phone": "+91-9122036484",
    "primary_track_id": "data",
    "target_role": "Azure Data Engineer",
    "total_yoe": 2.5,
    "relevant_yoe": 2.5,
    "current_company": "CGI",
    "previous_company": "HFCL",
    "current_ctc_lpa": 12.0,
    "expected_ctc_lpa": 22.0,
    "target_ctc_range": "₹20–25 LPA",
    "notice_period_days": 15,
    "notice_period_str": "15 Days or less (Immediate Joiner)",
    "primary_skills": [
        "Azure Databricks", "PySpark", "Delta Lake", "Azure Data Factory (ADF)",
        "Azure Synapse Analytics", "SQL", "Python", "Data Lakehouse (Medallion)",
        "ETL / ELT", "Azure DevOps", "Git"
    ],
    "preferred_locations": ["Bengaluru", "Hyderabad", "Pune", "Noida", "Remote"]
}

# Whitelist of permissible headline mutation tokens (default profile)
WHITELIST_HEADLINE_TOKENS: List[str] = [
    "Azure Data Engineer",
    "2.5 YOE",
    "Databricks",
    "PySpark",
    "Delta Lake",
    "ADF",
    "Synapse",
    "Medallion Architecture",
    "15 Days Notice",
    "Immediate Joiner",
    "ETL Optimization",
    "₹20-25 LPA Target"
]

# Blacklist: Guard rails that must NEVER be mutated or compromised
BLACKLIST_ATTRIBUTES: List[str] = [
    "total_yoe",
    "current_company",
    "education",
    "gender",
    "identity_docs",
    "current_salary"
]


@dataclass
class CandidateProfile:
    user_id: str = "lavkush"
    full_name: str = "Lavkush Kumar"
    email: str = "lav84095@gmail.com"
    phone: str = "+91-9122036484"
    primary_track_id: str = "data"
    target_role: str = "Azure Data Engineer"
    total_yoe: float = 2.5
    relevant_yoe: float = 2.5
    current_company: str = "CGI"
    previous_company: str = "HFCL"
    current_ctc_lpa: float = 12.0
    expected_ctc_lpa: float = 22.0
    target_ctc_range: str = "₹20–25 LPA"
    notice_period_days: int = 15
    notice_period_str: str = "15 Days or less (Immediate Joiner)"
    primary_skills: List[str] = field(default_factory=lambda: list(CANDIDATE_FACTS["primary_skills"]))
    tools: List[str] = field(default_factory=list)
    preferred_locations: List[str] = field(default_factory=lambda: list(CANDIDATE_FACTS["preferred_locations"]))
    whitelist_headline_tokens: List[str] = field(default_factory=lambda: list(WHITELIST_HEADLINE_TOKENS))
    screening_answers: Dict[str, str] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: Optional[Dict[str, Any]] = None) -> "CandidateProfile":
        if not data:
            return cls()
        if isinstance(data, cls):
            return data
        full_name = data.get("full_name") or data.get("name") or CANDIDATE_FACTS["full_name"]
        target_role = data.get("target_role") or CANDIDATE_FACTS["target_role"]
        total_yoe = float(data.get("total_yoe", CANDIDATE_FACTS["total_yoe"]))
        notice_days = int(data.get("notice_period_days", CANDIDATE_FACTS["notice_period_days"]))
        skills = data.get("primary_skills") or list(CANDIDATE_FACTS["primary_skills"])
        whitelist = data.get("whitelist_headline_tokens") or [
            target_role,
            f"{total_yoe} YOE",
            f"{notice_days} Days Notice",
            "Immediate Joiner",
            *skills[:8],
        ]
        return cls(
            user_id=str(data.get("user_id", "lavkush")),
            full_name=str(full_name),
            email=str(data.get("email", CANDIDATE_FACTS["email"])),
            phone=str(data.get("phone", CANDIDATE_FACTS["phone"])),
            primary_track_id=str(data.get("primary_track_id", "data")),
            target_role=str(target_role),
            total_yoe=total_yoe,
            relevant_yoe=float(data.get("relevant_yoe", total_yoe)),
            current_company=str(data.get("current_company", "")),
            previous_company=str(data.get("previous_company", "")),
            current_ctc_lpa=float(data.get("current_ctc_lpa", 12.0)),
            expected_ctc_lpa=float(data.get("expected_ctc_lpa", 22.0)),
            target_ctc_range=str(data.get("target_ctc_range", "₹20–25 LPA")),
            notice_period_days=notice_days,
            notice_period_str=str(data.get("notice_period_str", f"{notice_days} Days Notice")),
            primary_skills=list(skills),
            tools=list(data.get("tools") or []),
            preferred_locations=list(data.get("preferred_locations") or CANDIDATE_FACTS["preferred_locations"]),
            whitelist_headline_tokens=list(whitelist),
            screening_answers=dict(data.get("screening_answers") or {}),
        )


def resolve_screening_question(prompt: str, profile: Optional[ Any ] = None) -> str:
    """Deterministic resolver for automated application screening questions (supports dynamic user profiles)."""
    p = prompt.lower()
    prof = CandidateProfile.from_dict(profile) if profile is not None else None

    if "notice" in p:
        if prof is not None:
            return f"{prof.notice_period_days} days"
        return "15 days"
    if "current ctc" in p or "current salary" in p:
        if prof is not None:
            val = int(prof.current_ctc_lpa) if prof.current_ctc_lpa.is_integer() else prof.current_ctc_lpa
            return f"{val} LPA"
        return "12 LPA"
    if "expected ctc" in p or "expected salary" in p:
        if prof is not None:
            val = int(prof.expected_ctc_lpa) if prof.expected_ctc_lpa.is_integer() else prof.expected_ctc_lpa
            return f"{val} LPA"
        return "22 LPA"
    if "experience" in p:
        if prof is not None:
            return str(prof.total_yoe)
        return "2.5"
    if "relocate" in p or "willing to" in p:
        return "Yes"
    if "authorized" in p or "legally" in p or "visa" in p:
        return "Yes"
    if "comfortable" in p:
        return "Yes"
    return "Yes"
