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
DEFAULT_ALPHA = 0.25  # per Muse 10-worker swarm directive (was 0.2)

class Action(IntEnum):
    APPLY = 0
    SKIP = 1
    DEFER_TO_REVIEW = 2

class LinUCBPolicy:
    def __init__(self, alpha: float = DEFAULT_ALPHA, version: str = "v2.1-linucb"):
        alpha = float(alpha)
        if not math.isfinite(alpha) or alpha < 0:
            raise ValueError(f"alpha must be a finite, non-negative number, got {alpha!r}")
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

    @staticmethod
    def _clamp01(value: float) -> float:
        """Clamps to [0, 1]; a non-finite input degrades to 0.0, never NaN."""
        try:
            v = float(value)
        except (TypeError, ValueError):
            return 0.0
        if not math.isfinite(v):
            return 0.0
        return min(1.0, max(0.0, v))

    def extract_context(self, job: Dict[str, Any]) -> List[float]:
        """Extracts normalized 7-dimensional context vector x in [0, 1]^7."""
        # Every component is clamped: previously an out-of-range job field
        # (e.g. match_score 150 or a negative salary) silently produced a
        # context outside the documented [0, 1]^7.
        match_score = self._clamp01(float(job.get("match_score", 70.0)) / 100.0)
        yoe = self._clamp01(min(float(job.get("required_yoe", 2.5)), 10.0) / 10.0)
        age = self._clamp01(min(float(job.get("posting_age_hours", 24.0)), 168.0) / 168.0)

        company_tier = 0.5
        comp = job.get("company", "").lower()
        if any(gcc in comp for gcc in ["microsoft", "google", "amazon", "deloitte", "pwc", "ey", "cgi"]):
            company_tier = 1.0
        elif any(c in comp for c in ["startup", "stealth"]):
            company_tier = 0.3

        platform = job.get("platform", "").lower()
        platform_weight = 1.0 if "naukri" in platform or "easy" in platform else 0.6

        skill_overlap = self._clamp01(job.get("skill_overlap", 0.8))
        salary = self._clamp01(min(float(job.get("salary_lpa", 22.0)), 40.0) / 40.0)

        return [match_score, yoe, age, company_tier, platform_weight, skill_overlap, salary]

    def _validate_context(self, context: List[float]) -> List[float]:
        """Returns the context as floats, rejecting anything that would
        corrupt the bandit state (wrong dimension, NaN/inf components).

        Previously a short context raised IndexError mid-selection and a
        NaN component/reward permanently poisoned A and b, after which every
        score was NaN and selection silently degenerated to the first action.
        """
        if len(context) != self.d:
            raise ValueError(f"context must have dimension {self.d}, got {len(context)}")
        values = [float(v) for v in context]
        if not all(math.isfinite(v) for v in values):
            raise ValueError("context components must be finite numbers")
        return values

    def select_action(self, context: List[float]) -> Tuple[Action, float, Dict[str, float]]:
        """
        Computes Upper Confidence Bound for all actions and returns selected action,
        highest score, and confidence scores per action.
        """
        context = self._validate_context(context)
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
        context = self._validate_context(context)
        reward = float(reward)
        if not math.isfinite(reward):
            raise ValueError(f"reward must be a finite number, got {reward!r}")
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
            # Partial pivoting: swap in the row with the largest |pivot| in
            # this column. The previous code substituted 1e-6 for a near-zero
            # pivot and then DIVIDED BY IT, which returns a wrong inverse
            # for any matrix that needs a row swap (e.g. [[0, 1], [1, 0]]).
            pivot_row = max(range(i, n), key=lambda r: abs(augmented[r][i]))
            if abs(augmented[pivot_row][i]) < 1e-12:
                # Singular column: regularise instead of scaling by ~0.
                augmented[i][i] += 1e-6
                pivot_row = i
            if pivot_row != i:
                augmented[i], augmented[pivot_row] = augmented[pivot_row], augmented[i]
            pivot = augmented[i][i]
            for j in range(2 * n):
                augmented[i][j] /= pivot
            for k in range(n):
                if k != i:
                    factor = augmented[k][i]
                    for j in range(2 * n):
                        augmented[k][j] -= factor * augmented[i][j]

        return [[augmented[i][j + n] for j in range(n)] for i in range(n)]
