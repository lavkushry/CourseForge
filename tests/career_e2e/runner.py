#!/usr/bin/env python3
"""
CourseForge Career Studio (ForgeCareer) Unified E2E Test Runner
Executes test suites across Tiers 1-4 with structured ANSI reporting.
"""

import sys
import time
import argparse
import subprocess
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
REPO_ROOT = BASE_DIR.parents[1]

# ANSI colors
GREEN = "\033[92m"
RED = "\033[91m"
YELLOW = "\033[93m"
BLUE = "\033[94m"
CYAN = "\033[96m"
BOLD = "\033[1m"
RESET = "\033[0m"


def print_banner():
    print(f"\n{CYAN}{BOLD}{'=' * 80}{RESET}")
    print(f"{CYAN}{BOLD}  COURSEFORGE CAREER STUDIO (FORGECAREER) - OPAQUE-BOX E2E TEST RUNNER{RESET}")
    print(f"{CYAN}{BOLD}{'=' * 80}{RESET}\n")


def run_tier(name: str, test_file: Path, verbose: bool = False) -> tuple[int, int, float]:
    """Runs pytest on target test file and returns (passed_count, failed_count, duration)."""
    start = time.time()
    pytest_bin = sys.executable
    cmd = [pytest_bin, "-m", "pytest", str(test_file)]
    if verbose:
        cmd.append("-v")
    else:
        cmd.append("-q")

    res = subprocess.run(cmd, capture_output=True, text=True)
    duration = time.time() - start

    output = res.stdout + res.stderr

    # Check if pytest is missing from the active interpreter
    if res.returncode != 0 and ("No module named pytest" in output or "pytest: command not found" in output):
        raise RuntimeError(
            f"pytest is not installed in Python interpreter '{pytest_bin}'.\n"
            f"Run E2E tests using the project virtual environment:\n"
            f"  /home/ubuntu/Resume/.venv/bin/python3 {BASE_DIR / 'runner.py'}"
        )

    passed = 0
    failed = 0

    # Parse counts from pytest summary output using findall to capture the final outer summary line
    import re
    pass_matches = re.findall(r"(\d+)\s+passed", output)
    fail_matches = re.findall(r"(\d+)\s+failed", output)
    error_matches = re.findall(r"(\d+)\s+error", output)

    if pass_matches:
        passed = int(pass_matches[-1])
    if fail_matches:
        failed = int(fail_matches[-1])
    if error_matches:
        failed += int(error_matches[-1])

    # If pytest exited with a non-zero returncode but no failed tests were parsed (e.g. collection error or crash)
    if res.returncode != 0 and failed == 0:
        raise RuntimeError(
            f"pytest exited with returncode {res.returncode} for {name} ({test_file.name}) but no test failures were parsed.\n"
            f"Process Output:\n{output.strip()}"
        )

    return passed, failed, duration


def main():
    parser = argparse.ArgumentParser(description="ForgeCareer E2E Test Runner")
    parser.add_argument("--tier", choices=["1", "2", "3", "4", "all"], default="all", help="Target test tier")
    parser.add_argument("-v", "--verbose", action="store_true", help="Verbose pytest output")
    args = parser.parse_args()

    print_banner()

    tiers = [
        ("Tier 1: Feature Coverage (R1-R5)", BASE_DIR / "test_tier1_feature_coverage.py"),
        ("Tier 2: Boundary & Corner Cases", BASE_DIR / "test_tier2_boundary_corner.py"),
        ("Tier 3: Cross-Feature Interactions", BASE_DIR / "test_tier3_cross_feature.py"),
        ("Tier 4: Real-World Scenarios", BASE_DIR / "test_tier4_real_world.py"),
    ]

    selected_tiers = tiers
    if args.tier != "all":
        idx = int(args.tier) - 1
        selected_tiers = [tiers[idx]]

    results = []
    total_passed = 0
    total_failed = 0
    total_duration = 0.0

    for name, test_file in selected_tiers:
        print(f"{BLUE}▶ Running {name}...{RESET}")
        passed, failed, duration = run_tier(name, test_file, verbose=args.verbose)
        results.append((name, passed, failed, duration))
        total_passed += passed
        total_failed += failed
        total_duration += duration

        status_str = f"{GREEN}PASS{RESET}" if (failed == 0 and passed > 0) else f"{RED}FAIL{RESET}"
        print(f"  {status_str} — {passed} passed, {failed} failed in {duration:.2f}s\n")

    # Summary Table
    print(f"{BOLD}{'-' * 80}{RESET}")
    print(f"{BOLD}{'Tier Name':<42} {'Passed':<10} {'Failed':<10} {'Duration':<10} {'Status':<8}{RESET}")
    print(f"{BOLD}{'-' * 80}{RESET}")

    for name, p, f, d in results:
        status = f"{GREEN}PASS{RESET}" if (f == 0 and p > 0) else f"{RED}FAIL{RESET}"
        print(f"{name:<42} {p:<10} {f:<10} {f'{d:.2f}s':<10} {status:<8}")

    print(f"{BOLD}{'-' * 80}{RESET}")
    total_status = f"{GREEN}{BOLD}PASSED{RESET}" if (total_failed == 0 and total_passed > 0) else f"{RED}{BOLD}FAILED{RESET}"
    print(f"{BOLD}{'TOTAL':<42} {total_passed:<10} {total_failed:<10} {f'{total_duration:.2f}s':<10} {total_status:<8}\n")

    if total_failed > 0 or total_passed == 0:
        print(f"{RED}{BOLD}❌ E2E Test Suite run failed with {total_failed} errors (total passed: {total_passed}).{RESET}\n")
        sys.exit(1)
    else:
        print(f"{GREEN}{BOLD}✅ 100% E2E Test Suite verification complete! All {total_passed} tests passed.{RESET}\n")
        sys.exit(0)


if __name__ == "__main__":
    main()
