#!/usr/bin/env python3
"""Read-only catalog/provider reconciliation. Never emits credentials or provider URLs.

No apply mode exists. build_mapping_plan() returns internal exact-ID proposals for a
separate reviewed repair tool; public reports contain only aggregate counts/hashes.
"""
from __future__ import annotations
import argparse
import ast
import collections
from datetime import datetime, timezone
import hashlib
import json
import math
import sys
from pathlib import Path, PurePosixPath
import re
import sqlite3
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]
CLAIM_NAME = re.compile(r"[A-Za-z0-9_-]+")
CLAIM_ID = re.compile(r"[0-9a-fA-F]{40}")


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def provider(row):
    if not isinstance(row, dict):
        return None
    name, claim = row.get("claim_name"), row.get("claim_id")
    if not isinstance(name, str) or not isinstance(claim, str):
        return None
    if not CLAIM_NAME.fullmatch(name) or not CLAIM_ID.fullmatch(claim):
        return None
    return name, claim.lower()


def qualified_key(value):
    if not isinstance(value, str) or "\\" in value:
        return None
    path = PurePosixPath(value)
    if path.is_absolute() or len(path.parts) < 2 or any(x in ("..", ".") for x in value.split("/")):
        return None
    return str(path)


def build_mapping_plan(legacy, destination, legacy_providers, current_providers, manifests):
    """Exact IDs or unique course-qualified filenames only; existing changes rejected.

    Returns private proposals and public counts. No SQL writes/network provider calls.
    A conflict in any source rejects that lesson, even when another source agrees.
    """
    source = {x["id"]: x for x in legacy}
    target = {x["id"]: x for x in destination}
    current = {x["lesson_id"]: provider(x) for x in current_providers}
    paths = collections.defaultdict(list)
    for row in legacy:
        key = qualified_key(row["course"] + "/" + PurePosixPath(row["path"]).name)
        if key:
            paths[key].append(row["id"])
    candidates = collections.defaultdict(set)
    reasons = collections.Counter()
    rejected = set()
    for row in legacy_providers:
        lid = row["video_id"]
        if lid not in source:
            reasons["orphan_legacy_provider"] += 1
        elif provider(row):
            candidates[lid].add(provider(row))
        else:
            reasons["invalid_legacy_provider"] += 1
            rejected.add(lid)
    for manifest in manifests:
        for key, entry in manifest.items():
            valid = provider(entry)
            if not valid:
                reasons["invalid_manifest_entry"] += 1
                continue
            explicit = entry.get("video_id")
            matches = paths.get(qualified_key(key), [])
            if explicit:
                if not isinstance(explicit, str) or explicit not in source:
                    reasons["unknown_explicit_manifest_id"] += 1
                    continue
                if entry.get("course") and entry["course"] != source[explicit]["course"]:
                    rejected.add(explicit)
                    reasons["explicit_course_conflict"] += 1
                    continue
                expected_key = source[explicit]["course"] + "/" + PurePosixPath(source[explicit]["path"]).name
                if (qualified_key(key) and key != expected_key) or len(matches) > 1 or (matches and matches != [explicit]):
                    rejected.add(explicit)
                    rejected.update(matches)
                    reasons["explicit_path_conflict"] += 1
                    continue
                lid = explicit
            else:
                if len(matches) != 1:
                    reasons["ambiguous_or_unqualified_manifest_key"] += 1
                    rejected.update(matches)
                    continue
                lid = matches[0]
                if entry.get("course") and entry["course"] != source[lid]["course"]:
                    rejected.add(lid)
                    reasons["manifest_course_conflict"] += 1
                    continue
            candidates[lid].add(valid)
    proposals = []
    for lid, values in candidates.items():
        if len(values) != 1:
            rejected.add(lid)
            reasons["conflicting_source_claims"] += 1
        if lid in rejected:
            continue
        if lid not in target:
            reasons["destination_lesson_missing"] += 1
            continue
        if source[lid]["course"] != target[lid]["course_id"]:
            reasons["destination_course_conflict"] += 1
            continue
        value = next(iter(values))
        if lid in current:
            if value == current[lid]:
                reasons["existing_mapping_agrees"] += 1
            else:
                reasons["existing_mapping_conflict"] += 1
            continue
        proposals.append({"lesson_id": lid, "course_id": source[lid]["course"],
                          "claim_name": value[0], "claim_id": value[1]})
    # A claim shared by different lessons is not guessed. Existing duplicate claims
    # remain untouched; proposed duplicates are rejected for operator investigation.
    owners = collections.defaultdict(set)
    for lid, value in current.items():
        if value:
            owners[value].add(lid)
    for row in proposals:
        owners[provider(row)].add(row["lesson_id"])
    accepted = []
    for row in proposals:
        if len(owners[provider(row)]) > 1:
            reasons["duplicate_claim_identity"] += 1
        else:
            accepted.append(row)
    accepted.sort(key=lambda x: x["lesson_id"])
    return accepted, {"eligible_missing_mapping_inserts": len(accepted),
                      "rejected_lesson_identities": len(rejected),
                      "reason_counts": dict(sorted(reasons.items())),
                      "proposal_sha256": digest(accepted)}


def read_legacy(path):
    conn = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA query_only=ON")
    conn.execute("BEGIN")
    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    def rows(sql):
        return [dict(r) for r in conn.execute(sql)]
    data = {
        "lessons": rows("SELECT id,course,path,title,duration,status FROM videos ORDER BY id"),
        "providers": rows("SELECT video_id,claim_name,claim_id FROM lecture_providers ORDER BY video_id"),
        "courses": rows("SELECT course,title,cover_kind FROM course_metadata ORDER BY course"),
        "publication": rows("SELECT course,published,description FROM course_publication ORDER BY course") if "course_publication" in tables else [],
        "organization": rows("SELECT course,video_id,section_title,position FROM course_lesson_organization ORDER BY video_id") if "course_lesson_organization" in tables else [],
        "materials": rows("SELECT id,course,filename,removed FROM course_materials_meta ORDER BY id") if "course_materials_meta" in tables else [],
    }
    conn.rollback()
    conn.close()
    return data


def read_pg():
    # Exact existing deployment only. No env inspection, learner rows or credentials.
    sql = """BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='10s';
SELECT json_build_object(
'lessons',(SELECT coalesce(json_agg(row_to_json(x)),'[]'::json) FROM
 (SELECT id,course_id,title,flow_order,sort_order,section_title,duration_seconds,status FROM lessons ORDER BY id)x),
'providers',(SELECT coalesce(json_agg(row_to_json(x)),'[]'::json) FROM
 (SELECT lesson_id,claim_name,claim_id FROM lesson_providers ORDER BY lesson_id)x),
'courses',(SELECT coalesce(json_agg(row_to_json(x)),'[]'::json) FROM
 (SELECT id,published,description,cover_relative_path FROM courses ORDER BY id)x),
'materials',(SELECT count(*) FROM materials));
ROLLBACK;"""
    run = subprocess.run(["docker", "exec", "-i", "courseforge-rewrite-postgres-1", "psql", "-X", "-qAt", "-U", "courseforge", "-d", "courseforge_rewrite", "-v", "ON_ERROR_STOP=1"],
                         input=sql, text=True, capture_output=True)
    if run.returncode:
        raise RuntimeError("Read-only PostgreSQL audit failed; raw database errors suppressed")
    return json.loads(run.stdout)


def legacy_functions():
    # Extract these two pure legacy functions without importing the application:
    # app imports can initialize credentials, databases, workers and routes.
    scope = {}
    for file, name in (("app/main.py", "compute_flow_order"), ("app/course_metadata.py", "infer_section_title")):
        tree = ast.parse((ROOT / file).read_text())
        node = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == name)
        exec(compile(ast.Module(body=[node], type_ignores=[]), file, "exec"), scope)
    return scope["compute_flow_order"], scope["infer_section_title"]


def audit(legacy, pg, manifests):
    src = {r["id"]: r for r in legacy["lessons"]}
    dst = {r["id"]: r for r in pg["lessons"]}
    sp = {r["video_id"]: provider(r) for r in legacy["providers"] if r["video_id"] in src and provider(r)}
    dp = {r["lesson_id"]: provider(r) for r in pg["providers"]}
    proposals, plan = build_mapping_plan(legacy["lessons"], pg["lessons"], legacy["providers"], pg["providers"], manifests)
    order, section = legacy_functions()
    organization = {(r["course"], r["video_id"]): r for r in legacy["organization"]}
    expected = {}
    for lid, row in src.items():
        custom = organization.get((row["course"], lid), {})
        flow = custom.get("position") if custom.get("position") is not None else order(row["course"], row["title"])
        expected[lid] = (flow, custom.get("section_title") or section(row["course"], row["title"], order(row["course"], row["title"])))
    course_ids = {r["course"] for r in legacy["courses"]} | {r["course"] for r in src.values()}
    pg_courses = {r["id"]: r for r in pg["courses"]}
    pub = {r["course"]: r for r in legacy["publication"]}
    per_course = []
    for cid in sorted(course_ids):
        ids = {lid for lid, r in src.items() if r["course"] == cid}
        source_order = sorted(ids, key=lambda lid: (expected[lid][0], src[lid]["title"]))
        target_order = sorted(ids & set(dst), key=lambda lid: (dst[lid]["flow_order"], dst[lid]["sort_order"], lid))
        per_course.append({"course_id": cid, "source_lessons": len(ids), "destination_lessons": len(ids & set(dst)),
            "source_valid_mappings": len(ids & set(sp)), "destination_mappings": len(ids & set(dp)),
            "eligible_mapping_inserts": sum(r["course_id"] == cid for r in proposals),
            "unmapped_after_proposed_repair": len(ids - set(dp) - {r["lesson_id"] for r in proposals}),
            "ordered_stable_ids_match": source_order == target_order})
    common = set(src) & set(dst)
    return {
        "audit_mode": "read_only_no_provider_requests", "production_writes": 0,
        "coverage": {"sqlite_courses": len(course_ids), "sqlite_lessons": len(src), "sqlite_provider_rows": len(legacy["providers"]),
            "sqlite_valid_owned_provider_rows": len(sp), "postgres_courses": len(pg_courses), "postgres_lessons": len(dst),
            "postgres_provider_rows": len(dp), "postgres_unmapped_lessons": len(set(dst) - set(dp)),
            "source_lessons_missing_destination": len(set(src) - set(dst)), "destination_extra_lessons": len(set(dst) - set(src)),
            "destination_extra_courses": len(set(pg_courses) - course_ids),
            "exact_legacy_mappings_missing_destination": len(set(sp) & set(dst) - set(dp)),
            "overlapping_provider_disagreements": sum(sp[i] != dp[i] for i in set(sp) & set(dp)),
            "manifest_entries": [len(x) for x in manifests], "manifest_content_equal": len({digest(x) for x in manifests}) == 1},
        "catalog_losses": {"course_identity_mismatches": sum(src[i]["course"] != dst[i]["course_id"] for i in common),
            "title_mismatches": sum(src[i]["title"] != dst[i]["title"] for i in common),
            "flow_order_mismatches": sum(not math.isclose(expected[i][0], dst[i]["flow_order"], abs_tol=1e-8) for i in common),
            "section_title_mismatches": sum(expected[i][1] != dst[i]["section_title"] for i in common),
            "courses_with_changed_lesson_sequence": sum(not r["ordered_stable_ids_match"] for r in per_course),
            "publication_mismatches": sum(cid in pg_courses and bool(row["published"]) != pg_courses[cid]["published"] for cid,row in pub.items()),
            "description_mismatches": sum(cid in pg_courses and (row["description"] or "") != pg_courses[cid]["description"] for cid,row in pub.items()),
            "legacy_organization_rows": len(legacy["organization"]), "legacy_material_metadata_rows": len(legacy["materials"]),
            "destination_material_rows": pg["materials"], "legacy_covers_declared": sum(bool(r["cover_kind"]) for r in legacy["courses"]),
            "destination_covers_declared": sum(bool(r["cover_relative_path"]) for r in pg_courses.values())},
        "mapping_repair_dry_run": plan,
        "snapshot_sha256": {"legacy_selected_content": digest(legacy), "destination_selected_content": digest(pg), "manifests": [digest(x) for x in manifests]},
        "courses": per_course,
        "limits": ["No provider authorization/byte/decoded playback check; mapping presence does not prove availability.",
                   "No learner record audit or import repair. Live SQLite and PG snapshots are independently consistent, not a common write-freeze snapshot.",
                   "Material metadata count does not include legacy on-demand filesystem/document-manifest discovery.",
                   "No mapping write exists in this script. Proposed claims and credentials are never included in the report."],
    }


class MappingPlanTests(unittest.TestCase):
    def setUp(self):
        self.v = [{"id": "lesson-a", "course": "course-a", "path": "/root/course-a/same.mp4"}, {"id": "lesson-b", "course": "course-b", "path": "/root/course-b/same.mp4"}]
        self.pg = [{"id": x["id"], "course_id": x["course"]} for x in self.v]
        self.claim = {"claim_name": "synthetic", "claim_id": "a" * 40}
    def plan(self, m, lp=(), current=(), pg=None):
        return build_mapping_plan(self.v, self.pg if pg is None else pg, list(lp), list(current), [m])
    def test_qualified_filename_is_exact_course_scoped(self):
        rows, _ = self.plan({"course-a/same.mp4": self.claim})
        self.assertEqual([x["lesson_id"] for x in rows], ["lesson-a"])
    def test_unqualified_and_fuzzy_titles_are_rejected(self):
        for key in ["same.mp4", "course-a/SAME.mp4", "course-a/../same.mp4"]:
            self.assertEqual(self.plan({key: dict(self.claim, title="same")})[0], [])
    def test_explicit_id_does_not_fallback_when_unknown(self):
        self.assertEqual(self.plan({"course-a/same.mp4": dict(self.claim, video_id="unknown")})[0], [])
    def test_explicit_id_path_disagreement_rejects_both(self):
        self.assertEqual(self.plan({"course-a/same.mp4": dict(self.claim, video_id="lesson-b")})[0], [])
    def test_explicit_id_with_unknown_qualified_path_rejected(self):
        self.assertEqual(self.plan({"course-b/unknown.mp4": dict(self.claim, video_id="lesson-a")})[0], [])
    def test_source_disagreement_rejected(self):
        lp = [dict(self.claim, video_id="lesson-a", claim_id="b" * 40)]
        self.assertEqual(self.plan({"course-a/same.mp4": self.claim}, lp=lp)[0], [])
    def test_existing_mapping_never_replaced(self):
        current = [dict(self.claim, lesson_id="lesson-a", claim_id="b" * 40)]
        rows, report = self.plan({"course-a/same.mp4": self.claim}, current=current)
        self.assertEqual(rows, []); self.assertEqual(report["reason_counts"]["existing_mapping_conflict"], 1)
    def test_existing_agreement_is_idempotent(self):
        self.assertEqual(self.plan({"course-a/same.mp4": self.claim}, current=[dict(self.claim, lesson_id="lesson-a")])[0], [])
    def test_destination_course_change_rejected(self):
        self.assertEqual(self.plan({"course-a/same.mp4": self.claim}, pg=[{"id": "lesson-a", "course_id": "course-b"}])[0], [])
    def test_duplicate_claims_rejected(self):
        self.assertEqual(self.plan({"course-a/same.mp4": self.claim, "course-b/same.mp4": self.claim})[0], [])
    def test_invalid_claim_not_a_candidate(self):
        self.assertEqual(self.plan({"course-a/same.mp4": dict(self.claim, claim_id="not-a-claim")})[0], [])
    def test_ambiguous_path_rejected(self):
        self.v.append(dict(self.v[0], id="duplicate"))
        self.assertEqual(self.plan({"course-a/same.mp4": self.claim})[0], [])
    def test_report_does_not_disclose_claim(self):
        _, report = self.plan({"course-a/same.mp4": self.claim})
        self.assertNotIn(self.claim["claim_id"], json.dumps(report))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--output", type=Path, default=ROOT / "docs/rewrite/COURSE_MAPPING_AUDIT.json")
    args = parser.parse_args()
    if args.self_test:
        result = unittest.TextTestRunner().run(unittest.defaultTestLoader.loadTestsFromTestCase(MappingPlanTests))
        sys.exit(0 if result.wasSuccessful() else 1)
    manifests = [json.loads((ROOT / p).read_text()) for p in ("data/odysee_manifest.json", "odysee_manifest.json")]
    if any(not isinstance(x, dict) for x in manifests):
        raise RuntimeError("Manifest root must be an object")
    legacy = read_legacy(ROOT / "data/courseforge.sqlite3")
    report = audit(legacy, read_pg(), manifests)
    docs_path = ROOT / "data/odysee_docs_manifest.json"
    docs = json.loads(docs_path.read_text()) if docs_path.exists() else {}
    course_ids = {r["course"] for r in legacy["lessons"]}
    video_paths = [Path(r["path"]) for r in legacy["lessons"]]
    report["artifact_discovery"] = {"legacy_lesson_paths_present": sum(p.is_file() for p in video_paths),
        "legacy_lesson_paths_absent": sum(not p.is_file() for p in video_paths),
        "document_manifest_entries": len(docs),
        "document_manifest_valid_providers": sum(provider(r) is not None for r in docs.values()),
        "document_manifest_known_course_entries": sum(isinstance(r, dict) and r.get("course") in course_ids for r in docs.values()),
        "document_manifest_sha256": digest(docs)}
    report["observed_at_utc"] = datetime.now(timezone.utc).isoformat()
    args.output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps({"coverage": report["coverage"], "catalog_losses": report["catalog_losses"], "artifact_discovery": report["artifact_discovery"], "mapping_repair_dry_run": report["mapping_repair_dry_run"]}, indent=2))

if __name__ == "__main__":
    main()
