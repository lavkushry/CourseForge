"""
LinUCB Contextual Bandit Selection Policy (v2.1-linucb)
SOLID implementation of the autonomous job application decision engine.
"""

import math
import logging
from enum import IntEnum
from typing import Dict, Any, List, Tuple, Optional

logger = logging.getLogger("CareerWorker.LinUCB")

CONTEXT_DIMENSION = 7
DEFAULT_ALPHA = 0.2

class Action(IntEnum):
    APPLY = 0
    SKIP = 1
    DEFER_TO_REVIEW = 2

class LinUCBPolicy:
    def __init__(self, alpha: float = DEFAULT_ALPHA, version: str = "v2.1-linucb"):
        self.alpha = alpha
        self.version = version
        self.d = CONTEXT_DIMENSION
        self.decisions_count = 0
        self.mode = "ACTIVE"

        # Initialize A as identity matrix and b as zero vector for each action
        self.A: Dict[int, List[List[float]]] = {}
        self.b: Dict[int, List[float]] = {}
        for a in Action:
            self.A[a.value] = [[1.0 if i == j else 0.0 for j in range(self.d)] for i in range(self.d)]
            self.b[a.value] = [0.0 for _ in range(self.d)]

    def extract_context(self, job: Dict[str, Any]) -> List[float]:
        """Extracts normalized 7-dimensional context vector x in [0, 1]^7."""
        match_score = float(job.get("match_score", 70.0)) / 100.0
        yoe = min(float(job.get("required_yoe", 2.5)), 10.0) / 10.0
        age = min(float(job.get("posting_age_hours", 24.0)), 168.0) / 168.0

        company_tier = 0.5
        comp = job.get("company", "").lower()
        if any(gcc in comp for gcc in ["microsoft", "google", "amazon", "deloitte", "pwc", "ey", "cgi"]):
            company_tier = 1.0
        elif any(c in comp for c in ["startup", "stealth"]):
            company_tier = 0.3

        platform = job.get("platform", "").lower()
        platform_weight = 1.0 if "naukri" in platform or "easy" in platform else 0.6

        skill_overlap = float(job.get("skill_overlap", 0.8))
        salary = min(float(job.get("salary_lpa", 22.0)), 40.0) / 40.0

        return [match_score, yoe, age, company_tier, platform_weight, skill_overlap, salary]

    def select_action(self, context: List[float]) -> Tuple[Action, float, Dict[str, float]]:
        """
        Computes Upper Confidence Bound for all actions and returns selected action,
        highest score, and confidence scores per action.
        """
        p_scores: Dict[str, float] = {}
        best_action = Action.APPLY
        max_p = -float("inf")

        for a in Action:
            inv_A = self._invert_matrix(self.A[a.value])
            theta = self._mat_vec_mult(inv_A, self.b[a.value])

            # mean estimate theta^T x
            mean = sum(theta[i] * context[i] for i in range(self.d))

            # confidence bound alpha * sqrt(x^T inv(A) x)
            invA_x = self._mat_vec_mult(inv_A, context)
            variance = max(0.0, sum(context[i] * invA_x[i] for i in range(self.d)))
            ucb = self.alpha * math.sqrt(variance)

            score = mean + ucb
            p_scores[a.name] = score

            if score > max_p:
                max_p = score
                best_action = a

        self.decisions_count += 1
        return best_action, max_p, p_scores

    def update(self, action: Action, reward: float, context: List[float]):
        """Updates bandit parameters A_a and b_a with observed feedback reward."""
        a_idx = action.value
        # A_a <- A_a + x * x^T
        for i in range(self.d):
            for j in range(self.d):
                self.A[a_idx][i][j] += context[i] * context[j]

        # b_a <- b_a + r * x
        for i in range(self.d):
            self.b[a_idx][i] += reward * context[i]

    def _mat_vec_mult(self, mat: List[List[float]], vec: List[float]) -> List[float]:
        return [sum(mat[i][j] * vec[j] for j in range(len(vec))) for i in range(len(mat))]

    def _invert_matrix(self, mat: List[List[float]]) -> List[List[float]]:
        """Simple Gauss-Jordan inversion for small 7x7 matrix."""
        n = len(mat)
        augmented = [[mat[i][j] for j in range(n)] + [1.0 if i == j else 0.0 for j in range(n)] for i in range(n)]

        for i in range(n):
            # Pivot
            pivot = augmented[i][i]
            if abs(pivot) < 1e-9:
                pivot = 1e-6
            for j in range(2 * n):
                augmented[i][j] /= pivot
            for k in range(n):
                if k != i:
                    factor = augmented[k][i]
                    for j in range(2 * n):
                        augmented[k][j] -= factor * augmented[i][j]

        return [[augmented[i][j + n] for j in range(n)] for i in range(n)]
