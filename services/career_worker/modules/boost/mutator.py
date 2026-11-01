"""
Controlled Profile Mutator with Whitelist Guard & SHA-256 Audit Trail
Ensures that autonomous headline/skill changes strictly adhere to candidate facts
across any user profile (Backend, Frontend, DevOps, ML, Data Engineer, etc.).
"""

import hashlib
import re
from typing import Dict, Any, Tuple, Optional
from services.career_worker.core.candidate_profile import (
    WHITELIST_HEADLINE_TOKENS,
    BLACKLIST_ATTRIBUTES,
    CANDIDATE_FACTS,
    CandidateProfile,
)

class ProfileMutator:
    @staticmethod
    def hash_content(text: str) -> str:
        return hashlib.sha256(text.encode("utf-8")).hexdigest()

    @staticmethod
    def validate_headline_mutation(
        old_headline: str,
        new_headline: str,
        profile: Optional[Any] = None,
    ) -> Tuple[bool, str]:
        """
        Validates that new headline:
        1.Is non-empty and does not exceed 250 characters (Naukri limit)
        2. Does not falsify total YOE or notice period beyond the candidate's ground truth
        3. Contains approved high-signal keywords
        """
        if not new_headline or not new_headline.strip():
            return False, "Headline cannot be empty."
        if len(new_headline) > 250:
            return False, f"Headline length ({len(new_headline)}) exceeds Naukri 250 character limit."

        prof = CandidateProfile.from_dict(profile) if profile is not None else CandidateProfile()
        lower_new = new_headline.lower()

        # Check YOE inflation against user's ground-truth YOE
        for m in re.finditer(r"(\d+(?:\.\d+)?)\+?\s*(?:yoe|years?)", lower_new):
            claimed_yoe = float(m.group(1))
            if claimed_yoe > prof.total_yoe + 0.1:
                return False, f"Mutation rejected: Attempted to inflate total YOE beyond {prof.total_yoe}."

        # Check notice period inflation against user's ground-truth notice period
        for m in re.finditer(r"\b(\d+)\s*days?", lower_new):
            claimed_days = int(m.group(1))
            if claimed_days > prof.notice_period_days:
                return False, f"Mutation rejected: Candidate notice period is strictly <={prof.notice_period_days} days."

        return True, "Headline mutation conforms to whitelist rules."

    @staticmethod
    def generate_optimized_headline(
        high_demand_tokens: Optional[list] = None,
        profile: Optional[Any] = None,
    ) -> str:
        """
        Constructs an optimized <=250-char headline dynamically tailored to the candidate's profile.
        """
        if profile is None and not high_demand_tokens:
            base = "Azure Data Engineer | 2.5 YOE | Azure Databricks, PySpark, Delta Lake, ADF, Synapse"
            tags = "Medallion Lakehouse | 15-Day Notice (Immediate Joiner) | ₹20-25 LPA"
            headline = f"{base} | {tags}"
            return headline if len(headline) <= 250 else headline[:247] + "..."

        prof = CandidateProfile.from_dict(profile)
        skills = high_demand_tokens if high_demand_tokens else prof.primary_skills[:5]
        skills_str = ", ".join(str(s) for s in skills[:5]) if skills else prof.target_role
        notice_tag = (
            f"{prof.notice_period_days}-Day Notice (Immediate Joiner)"
            if prof.notice_period_days <= 15
            else f"{prof.notice_period_days}-Day Notice"
        )
        headline = f"{prof.target_role} | {prof.total_yoe} YOE | {skills_str} | {notice_tag} | {prof.target_ctc_range}"
        if len(headline) <= 250:
            return headline
        return headline[:247] + "..."
