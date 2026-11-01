"""
Candidate Profile & Ground Truth Matrix
Contains factual ground-truth parameters, screening answer resolver,
and strict whitelist/blacklist guards for profile mutations.
"""

from typing import Dict, Any, List

CANDIDATE_FACTS: Dict[str, Any] = {
    "name": "Lavkush Kumar",
    "email": "lav84095@gmail.com",
    "phone": "+91-9122036484",
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

# Whitelist of permissible headline mutation tokens
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

def resolve_screening_question(prompt: str) -> str:
    """Deterministic resolver for automated application screening questions."""
    p = prompt.lower()
    if "notice" in p:
        return "15 days"
    if "current ctc" in p or "current salary" in p:
        return "12 LPA"
    if "expected ctc" in p or "expected salary" in p:
        return "22 LPA"
    if "experience" in p and ("azure" in p or "databricks" in p or "pyspark" in p or "total" in p):
        return "2.5"
    if "experience" in p:
        return "2.5"
    if "relocate" in p or "willing to" in p:
        return "Yes"
    if "authorized" in p or "legally" in p or "visa" in p:
        return "Yes"
    if "comfortable" in p:
        return "Yes"
    return "Yes"
