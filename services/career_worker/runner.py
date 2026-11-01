#!/usr/bin/env python3
"""
CourseForge Career Studio Autonomous Runner CLI
Executes scheduled career routines (Blocks 1, 2, 3), Resdex bumps, and funnel evaluations.
Compatible with systemd timers, cron jobs, and manual terminal execution.
"""

import sys
import argparse
import logging
from pathlib import Path
from datetime import datetime, timezone, timedelta

# Ensure repo root and worker dir in sys.path
REPO_ROOT = Path(__file__).resolve().parents[2]
WORKER_DIR = Path(__file__).resolve().parent

if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
if str(WORKER_DIR) not in sys.path:
    sys.path.insert(0, str(WORKER_DIR))

from services.career_worker.config import HEADLESS, DRY_RUN, DEFAULT_USER_ID
from services.career_worker.core.lock import acquire_worker_lock
from services.career_worker.adapters.naukri_adapter import NaukriAdapter
from services.career_worker.adapters.simulation_adapter import SimulationAdapter
from services.career_worker.modules.plan.daily_blocks import DailyBlockOrchestrator
from services.career_worker.modules.goal.pacing import PacingCalculator
from services.career_worker.modules.goal.diagnostics import DiagnosticEngine
from services.career_worker.modules.boost.mutator import ProfileMutator

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("CareerWorker.Runner")

def get_ist_now() -> datetime:
    return datetime.now(timezone.utc) + timedelta(hours=5, minutes=30)

def determine_auto_block() -> int:
    ist_hour = get_ist_now().hour
    if 8 <= ist_hour < 13:
        return 1
    elif 13 <= ist_hour < 17:
        return 2
    elif 17 <= ist_hour < 23:
        return 3
    return 1

def main():
    parser = argparse.ArgumentParser(description="CourseForge Career Studio Runner")
    parser.add_argument("--action", choices=["block", "bump", "apply", "outreach", "evaluate", "mutate", "digest"], default="block", help="Action to execute")
    parser.add_argument("--block", default="auto", help="Block ID (1, 2, 3, or auto)")
    parser.add_argument("--dry-run", action="store_true", default=DRY_RUN, help="Run in dry-run simulation mode")
    parser.add_argument("--headless", action="store_true", default=HEADLESS, help="Run browser in headless mode")
    parser.add_argument("--user-id", default=DEFAULT_USER_ID, help="Candidate user ID")

    args = parser.parse_args()

    logger.info(f"Starting Career Runner [action={args.action}, dry_run={args.dry_run}, headless={args.headless}]")

    with acquire_worker_lock() as acquired:
        if not acquired:
            logger.warning("Another career worker session is currently active. Exiting cleanly.")
            return

        adapter = SimulationAdapter(platform="naukri") if args.dry_run else NaukriAdapter(headless=args.headless)

        if args.action == "block":
            block_id = determine_auto_block() if args.block == "auto" else int(args.block)
            logger.info(f"Executing Daily Block {block_id} routine...")
            orchestrator = DailyBlockOrchestrator(adapter)
            res = orchestrator.execute_block(block_id, dry_run=args.dry_run)
            logger.info(f"Block {block_id} executed successfully: {res['tasks_completed']}")

        elif args.action == "bump":
            logger.info("Executing Resdex profile bump...")
            res = adapter.bump_profile()
            logger.info(f"Bump result: {res}")

        elif args.action == "apply":
            logger.info("Executing High-Velocity Apply batch...")
            apps = adapter.search_and_apply("Azure Data Engineer", limit=20, dry_run=args.dry_run)
            logger.info(f"Submitted {len(apps)} applications.")

        elif args.action == "outreach":
            logger.info("Executing Recruiter Outbound batch...")
            orchestrator = DailyBlockOrchestrator(adapter)
            res = orchestrator.execute_block(2, dry_run=args.dry_run)
            logger.info(f"Outreach batch completed: {res['tasks_completed']}")

        elif args.action == "mutate":
            logger.info("Executing Cadence Profile Mutator cycle...")
            optimized = ProfileMutator.generate_optimized_headline()
            valid, msg = ProfileMutator.validate_headline_mutation("", optimized)
            logger.info(f"Profile Mutator verified: {msg} [Headline: {optimized}]")

        elif args.action == "digest":
            logger.info("Compiling Weekly Career Pacing Digest...")
            metrics = adapter.extract_metrics()
            eval_res = PacingCalculator.evaluate_funnel_health({
                "calls_scheduled": 2,
                "applications": 35,
                "recruiter_outreach": 15,
                "follow_ups": 6
            })
            alerts = DiagnosticEngine.evaluate(metrics)
            logger.info(f"Weekly Digest compiled: Pacing={eval_res['pacing_percentage']}%, Active Bottlenecks={len(alerts)}")

        elif args.action == "evaluate":
            metrics = adapter.extract_metrics()
            alerts = DiagnosticEngine.evaluate(metrics)
            logger.info(f"Diagnostic evaluation complete: {len(alerts)} alerts triggered.")

if __name__ == "__main__":
    main()
