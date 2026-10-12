#!/usr/bin/env python3
"""Inventory registered legacy HTTP contracts without importing the application."""
from __future__ import annotations

import argparse
import ast
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
METHODS = {"get", "head", "post", "put", "patch", "delete", "options", "api_route"}
SLICES = {
    "identity_access": {
        "owner": "backend.identity/access", "milestone": "M1/M3",
        "tests": ["tests/test_academy.py", "tests/test_registration.py"],
        "invariants": ["cookie sessions and CSRF", "verified account and role", "shared session revocation", "course enrollment and publication"],
    },
    "catalog_discovery": {
        "owner": "backend.catalog", "milestone": "M1/M3",
        "tests": ["tests/test_course_metadata.py", "tests/test_library.py", "tests/test_stage1_streaming_foundations.py", "tests/test_stage4_title_and_episodes.py"],
        "invariants": ["stable course/lesson/provider IDs", "publication and enrollment filtering", "safe materials and artwork access", "stable ordering and bounded pagination"],
    },
    "player": {
        "owner": "backend.playback/media + web.player", "milestone": "M2",
        "tests": ["tests/test_native_player.py", "tests/test_player_sessions.py", "tests/test_player_delivery.py", "tests/test_player_recovery.py", "tests/test_stage5_playback_experience.py"],
        "invariants": ["account/login/lesson bound playback", "atomic ownership and takeover", "position/coverage/activity remain distinct", "durable duplicate-safe credit", "restricted provider redirects", "no credential leakage"],
    },
    "learning_records": {
        "owner": "backend.learning", "milestone": "M1/M3",
        "tests": ["tests/test_academy.py", "tests/test_study.py", "tests/test_assessments.py", "tests/test_adaptive_practice.py", "tests/test_learning_paths.py"],
        "invariants": ["explicit learner isolation", "private notes/bookmarks/results", "duplicate-safe writes", "stable source citations and timestamps"],
    },
    "planning_habits": {
        "owner": "backend.learning", "milestone": "M3",
        "tests": ["tests/test_daily_planner.py", "tests/test_weekly_calendar.py", "tests/test_focus_timer.py", "tests/test_habits.py", "tests/test_phase3_habit_loop.py", "tests/test_phase4_learning_retention.py"],
        "invariants": ["learner isolation", "timezone/day boundaries", "pause lifecycle", "distinct planning/focus/activity/watch metrics"],
    },
    "ai_import": {
        "owner": "backend.jobs + isolated Python adapters", "milestone": "M3",
        "tests": ["tests/test_tutor.py", "tests/test_syllabus.py", "tests/test_vision.py", "tests/test_worker_integration.py", "tests/test_phase5_ai_companion.py"],
        "invariants": ["durable user-bound job state", "bounded retries and resource concurrency", "idempotent fenced publication", "source citations/timestamps"],
    },
    "labs": {
        "owner": "backend.jobs/labs", "milestone": "M3",
        "tests": ["tests/test_labs.py", "tests/test_lab_tracks.py", "tests/test_academy.py"],
        "invariants": ["curated isolated execution", "learner-bound results", "resource limits and cancellation", "fenced duplicate-safe publication"],
    },
    "administration": {
        "owner": "backend.administration", "milestone": "M3",
        "tests": ["tests/test_academy.py", "tests/test_native_player.py", "tests/test_phase1_navigation_materials_admin.py"],
        "invariants": ["admin-only reads/writes", "last-admin protection", "account/enrollment/session revocation", "audit and CSV protections", "bounded exports/deletion and retained aggregates"],
    },
    "delivery_operations": {
        "owner": "coordinator.operations + web.delivery", "milestone": "M1/M5",
        "tests": ["tests/test_release_gate.py", "tests/test_mobile_foundation.py", "tests/test_responsive_layout.py", "tests/test_ui_contract.py"],
        "invariants": ["static cache refresh", "private API/media cache exclusions", "health/readiness", "backup/restore and safe release"],
    },
}


def feature(path: str, module: str) -> str:
    if path.startswith("/api/admin/"):
        return "administration"
    if module in {"native_player", "player_sessions", "media"} or path in {"/api/me/playback"} or path.endswith("/stream"):
        return "player"
    if module == "auth" or path.startswith(("/api/auth/", "/api/public/account-")) or path in {"/api/me", "/api/me/bootstrap"} or path.endswith("/enroll"):
        return "identity_access"
    if path.startswith(("/api/planner", "/api/focus", "/api/me/habit")) or module == "habits":
        return "planning_habits"
    if path.startswith(("/api/labs", "/api/lab-sessions")) or "/practice/" in path:
        return "labs"
    if path in {"/api/scan", "/api/ask", "/api/jobs", "/api/syllabus/generate"} or path.startswith("/api/tasks/") or path.endswith("/reindex"):
        return "ai_import"
    if module in {"streaming", "artwork"} or path in {"/api/videos", "/api/courses", "/api/search", "/api/syllabus"} or path.startswith(("/api/public/courses", "/api/materials", "/api/chunks/")) or path.startswith("/api/courses/") and path.endswith("/cover") or path == "/api/courses/{course_id}" or path == "/api/videos/{video_id}":
        return "catalog_discovery"
    if not path.startswith("/api/") or path in {"/api/health", "/api/docs", "/api/openapi.json"}:
        return "delivery_operations"
    return "learning_records"


def literal(node: ast.AST):
    try:
        return ast.literal_eval(node)
    except (ValueError, TypeError):
        raise ValueError(f"Dynamic route expression at line {node.lineno}; inventory needs explicit handling")


def inventory() -> dict:
    main_tree = ast.parse((ROOT / "app/main.py").read_text())
    imported: dict[str, str] = {}
    for node in ast.walk(main_tree):
        if isinstance(node, ast.ImportFrom) and node.level == 1:
            for alias in node.names:
                imported[alias.asname or alias.name] = node.module or alias.name
    included = {"main"}
    mounts = []
    for node in ast.walk(main_tree):
        if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute):
            continue
        if node.func.attr == "include_router":
            reference = node.args[0]
            key = reference.value.id if isinstance(reference, ast.Attribute) and isinstance(reference.value, ast.Name) else reference.id
            if key not in imported:
                raise ValueError(f"Unresolved router {key}")
            included.add(imported[key])
        if node.func.attr == "mount":
            mounts.append({"path": literal(node.args[0]), "kind": "static_mount", "source": "app/main.py", "line": node.lineno})
    routes = []
    source_hashes = {}
    for module in sorted(included):
        path = ROOT / "app" / f"{module}.py"
        source_hashes[str(path.relative_to(ROOT))] = hashlib.sha256(path.read_bytes()).hexdigest()
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            for dec in node.decorator_list:
                if not isinstance(dec, ast.Call) or not isinstance(dec.func, ast.Attribute) or dec.func.attr not in METHODS:
                    continue
                kwargs = {key.arg: key.value for key in dec.keywords}
                route_path = literal(dec.args[0]) if dec.args else literal(kwargs["path"])
                methods = literal(kwargs["methods"]) if dec.func.attr == "api_route" else [dec.func.attr.upper()]
                group = feature(route_path, module)
                for method in methods:
                    routes.append({"method": method.upper(), "path": route_path, "source": str(path.relative_to(ROOT)),
                                   "line": dec.lineno, "handler": node.name, "async": isinstance(node, ast.AsyncFunctionDef),
                                   "default_status": literal(kwargs["status_code"]) if "status_code" in kwargs else 200,
                                   "feature": group, "owner": SLICES[group]["owner"], "milestone": SLICES[group]["milestone"],
                                   "legacy_candidate_tests": SLICES[group]["tests"],
                                   "required_invariants": SLICES[group]["invariants"],
                                   "rewrite_gate": "public-interface behavior test; migration semantic comparison where persistent",
                                   "rewrite_status": "pending"})
    routes.sort(key=lambda route: (route["path"], route["method"]))
    keys = [(route["method"], route["path"]) for route in routes]
    if len(keys) != len(set(keys)):
        raise ValueError("Duplicate registered method/path needs review")
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    return {"schema_version": 1, "method": "offline AST of app.main decorators and directly included routers; application not imported",
            "revision": revision, "source_sha256": source_hashes, "included_modules": sorted(included),
            "declared_method_path_count": len(routes), "routes": routes, "mounts": mounts,
            "framework_routes": [{"method": "GET/HEAD", "path": path, "source": "FastAPI constructor"} for path in ("/api/docs", "/docs/oauth2-redirect", "/api/openapi.json")],
            "features": {name: {**config, "declared_method_path_count": sum(route["feature"] == name for route in routes),
                                     "evidence_status": "candidate legacy tests; rewritten behavior coverage not yet verified"} for name, config in SLICES.items()},
            "limitations": ["Static mount and framework routes are listed separately from declared handlers.",
                            "Tests are candidate parity owners, not a claim that every endpoint or invariant is exercised.",
                            "Browser-only behaviors, stored-record migrations, vector/artifact recovery and capacity require separate gates."]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "docs/rewrite/LEGACY_ROUTE_INVENTORY.json")
    args = parser.parse_args()
    report = inventory()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(json.dumps({"output": str(args.output), "routes": report["declared_method_path_count"], "modules": len(report["included_modules"])}))


if __name__ == "__main__":
    main()
