"""Unit tests for authoritative course → video / materials mapping."""
from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "scripts" / "course_content_mapping.py"


def _load():
    spec = importlib.util.spec_from_file_location("course_content_mapping", MODULE_PATH)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


M = _load()


class CourseContentMappingTests(unittest.TestCase):
    def test_study_items_are_materials_not_videos(self):
        study = {"kind": "study", "clean_filename": "notes.pdf", "claim_name": "course-doc-01"}
        video = {"kind": "video", "clean_filename": "01.mp4", "claim_name": "course-001-intro"}
        self.assertTrue(M.is_material_item(study))
        self.assertFalse(M.is_video_item(study))
        self.assertTrue(M.is_video_item(video))
        self.assertFalse(M.is_material_item(video))

    def test_document_claim_never_counts_as_video(self):
        item = {
            "kind": "video",
            "claim_name": "gauravsen-ai-2026-doc-module-01-notes-pdf",
            "clean_filename": "notes.pdf",
        }
        self.assertTrue(M.is_material_item(item))
        self.assertFalse(M.is_video_item(item))

    def test_claim_prefix_rejects_foreign_course(self):
        self.assertTrue(
            M.claim_belongs_to_course(
                "vizuara-slm-eng-2026-doc-study-03-links-txt",
                "Vizuara AI - SLM Small Language Models Engineering 2026",
                "vizuara-slm-eng-2026",
            )
        )
        self.assertFalse(
            M.claim_belongs_to_course(
                "vizuara-slm-eng-2026-doc-study-03-links-txt",
                "Vizuara AI - Context Engineering for LLMs 2026",
                "vizuara-context-eng-2026",
            )
        )

    def test_repair_clears_stolen_video_claim_from_study_item(self):
        course = {
            "course_key": "Demo Course",
            "claim_prefix": "demo-2026",
            "items": [],
        }
        video_claims = {"demo-2026-001-intro"}
        video_ids = {"v_aaaa"}
        docs_index = {
            "Demo Course/notes.pdf": {
                "course": "Demo Course",
                "name": "notes.pdf",
                "claim_name": "demo-2026-doc-notes-pdf",
                "claim_id": "a" * 40,
            }
        }
        study = {
            "kind": "study",
            "title": "Notes",
            "clean_filename": "notes.pdf",
            "video_id": "v_aaaa",
            "claim_name": "demo-2026-001-intro",
            "claim_id": "b" * 40,
        }
        fixed = M.repair_curricula_item(
            course,
            study,
            docs_index=docs_index,
            video_ids=video_ids,
            video_claims=video_claims,
        )
        self.assertEqual(fixed["kind"], "study")
        self.assertNotIn("video_id", fixed)
        self.assertEqual(fixed["claim_name"], "demo-2026-doc-notes-pdf")
        self.assertEqual(fixed["claim_id"], "a" * 40)
        self.assertTrue(fixed["material_id"].startswith("mat_"))

    def test_repair_drops_foreign_vizuara_claim(self):
        course = {
            "course_key": "Vizuara AI - Context Engineering for LLMs 2026",
            "claim_prefix": "vizuara-context-eng-2026",
        }
        item = {
            "kind": "study",
            "title": "[Study 03] Links",
            "clean_filename": "[Study 03] Links.txt",
            "claim_name": "vizuara-slm-eng-2026-doc-study-03-links-txt",
            "claim_id": "c" * 40,
            "video_id": "v_foreign",
        }
        fixed = M.repair_curricula_item(
            course,
            item,
            docs_index={},
            video_ids=set(),
            video_claims=set(),
        )
        self.assertNotIn("claim_name", fixed)
        self.assertNotIn("claim_id", fixed)

    def test_partition_and_contamination_detection(self):
        curricula = [
            {
                "course_key": "A",
                "claim_prefix": "a-",
                "items": [
                    {"kind": "video", "claim_id": "1" * 40, "claim_name": "a-1", "video_id": "v1"},
                    {"kind": "study", "claim_id": "2" * 40, "claim_name": "a-doc-1", "clean_filename": "a.pdf"},
                ],
            },
            {
                "course_key": "B",
                "claim_prefix": "b-",
                "items": [
                    {"kind": "study", "claim_id": "2" * 40, "claim_name": "a-doc-1", "clean_filename": "b.pdf"},
                ],
            },
        ]
        videos, materials = M.partition_items(curricula[0]["items"])
        self.assertEqual(len(videos), 1)
        self.assertEqual(len(materials), 1)
        findings = M.detect_cross_course_contamination(curricula)
        self.assertEqual(len(findings), 1)
        self.assertEqual(set(findings[0]["courses"]), {"A", "B"})

    def test_alias_prefixes_accept_sameer_adb_docs(self):
        self.assertTrue(
            M.claim_belongs_to_course(
                "sameer-adb-2026-doc-008-medallion",
                "Azure Data Bricks by Sameer Sir Durgasoft",
                "sameer-azure-databricks",
            )
        )

    def test_resolve_material_relative_path_prefers_data_materials(self):
        import tempfile
        from pathlib import Path

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            course = "Demo Course"
            name = "guide.pdf"
            target = root / "data" / "materials" / course
            target.mkdir(parents=True)
            (target / name).write_bytes(b"%PDF")
            rel = M.resolve_material_relative_path(
                course,
                name,
                root=str(root),
                preferred=f"materials/{course}/{name}",
            )
            self.assertEqual(rel, f"data/materials/{course}/{name}")
            self.assertTrue((root / rel).is_file())

    def test_rejects_truncated_video_filenames_as_materials(self):
        self.assertFalse(
            M.is_material_filename(
                "[350] 6) udp-mp4 mp4 Batch Name Codersgyan Master Backend.mp"
            )
        )
        self.assertTrue(M.is_material_filename("[01] Module 01 - Notes.pdf"))

    def test_infer_material_placement_matches_week_and_falls_back_to_course(self):
        lessons = [
            {
                "id": "v1",
                "section_title": "Module 01: Week 01 — Foundations",
            },
            {
                "id": "v2",
                "section_title": "Module 02: Week 02 — Spark",
            },
        ]
        scope, lid, sec = M.infer_material_placement(
            filename="[405] Week1RunningNotes.pdf",
            lessons=lessons,
        )
        self.assertEqual(scope, "section")
        self.assertIsNone(lid)
        self.assertIn("Week 01", sec)

        scope, lid, sec = M.infer_material_placement(
            filename="random-handout.pdf",
            lessons=lessons,
        )
        self.assertEqual(scope, "course")
        self.assertIsNone(lid)


if __name__ == "__main__":
    unittest.main()
