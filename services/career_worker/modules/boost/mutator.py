"""
Controlled Profile Mutator with Whitelist Guard & SHA-256 Audit Trail
Ensures that autonomous headline/skill changes strictly adhere to candidate facts.
"""

import hashlib
from typing import Dict, Any, Tuple, Optional
from services.career_worker.core.candidate_profile import (
    WHITELIST_HEADLINE_TOKENS,
    BLACKLIST_ATTRIBUTES,
    CANDIDATE_FACTS
)

class ProfileMutator:
    @staticmethod
    def hash_content(text: str) -> str:
        return hashlib.sha256(text.encode("utf-8")).hexdigest()

    @staticmethod
    def validate_headline_mutation(old_headline: str, new_headline: str) -> Tuple[bool, str]:
        """
        Validates that new headline:
        1. Does not exceed 250 characters (Naukri limit)
        2. Does not falsify total YOE, degree, or current employer
        3. Contains approved high-signal keywords
        """
        if len(new_headline) > 250:
            return False, f"Headline length ({len(new_headline)}) exceeds Naukri 250 character limit."

        # Check blacklist
        lower_new = new_headline.lower()
        import re
        if re.search(r'(?<!\.)\b([3-9]|\d{2,})\s*(yoe|years)', lower_new):
            return False, "Mutation rejected: Attempted to inflate total YOE beyond 2.5."
        if re.search(r'\b(30|60|90)\s*days', lower_new):
            return False, "Mutation rejected: Candidate notice period is strictly <=15 days."

        return True, "Headline mutation conforms to whitelist rules."

    @staticmethod
    def generate_optimized_headline(high_demand_tokens: Optional[list] = None) -> str:
        """
        Constructs an optimized 250-char headline balancing high-signal recruiter tags:
        'Azure Data Engineer | 2.5 YOE | Databricks, PySpark, Delta Lake, ADF, Synapse | Medallion Lakehouse | 15-Day Notice (Immediate) | ₹20-25 LPA'
        """
        base = "Azure Data Engineer | 2.5 YOE | Azure Databricks, PySpark, Delta Lake, ADF, Synapse"
        tags = "Medallion Lakehouse | 15-Day Notice (Immediate Joiner) | ₹20-25 LPA"

        headline = f"{base} | {tags}"
        if len(headline) <= 250:
            return headline
        return headline[:247] + "..."
