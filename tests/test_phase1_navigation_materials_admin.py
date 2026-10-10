"""Phase 1 tests: universal search, course organization, lesson materials, and admin course/materials management."""
from dataclasses import replace
import json
import pytest
from fastapi.testclient import TestClient
from app import main, db, auth, media, labs, academy_worker

PASSWORD = "An actual long test password 124"


@pytest.fixture
def phase1_env(tmp_path, monkeypatch):
    config = replace(db.settings, data_dir=tmp_path / "data", courses_dir=tmp_path / "courses")
    for mod in (main, db, media, labs, academy_worker):
        monkeypatch.setattr(mod, "settings", config)
    monkeypatch.setenv("PUBLIC_BASE_URL", "https://testserver")
    monkeypatch.setenv("COOKIE_SECURE", "1")
    monkeypatch.setenv("REGISTRATION_MODE", "open")
    db.init_db()
    admin_user = auth.bootstrap_admin("admin@courseforge.test", "Owner", PASSWORD)

    course_dir = config.courses_dir / "Azure Cloud Fundamentals"
    course_dir.mkdir(parents=True)
    (course_dir / "1. Introduction to Cloud.ipynb").write_text(
        json.dumps({"cells": [{"cell_type": "markdown", "source": ["# Welcome to Cloud"]}]}),
        encoding="utf-8",
    )
    (course_dir / "2. Virtual Networks Guide.pdf").write_bytes(b"%PDF-1.4 sample pdf content")
    (course_dir / "week1_starter_pack.zip").write_bytes(b"PK\x03\x04sample zip")

    with db.connect() as conn:
        conn.execute(
            "INSERT INTO videos(id,path,course,title,bytes,mtime_ns,status,duration,created_at) VALUES(?,?,?,?,?,?,?,180,?)",
            (
                "vid_intro",
                str(course_dir / "1. Introduction to Cloud.mp4"),
                "Azure Cloud Fundamentals",
                "1. Introduction to Cloud",
                1000,
                1,
                "done",
                db.utcnow(),
            ),
        )
        conn.execute(
            "INSERT INTO videos(id,path,course,title,bytes,mtime_ns,status,duration,created_at) VALUES(?,?,?,?,?,?,?,240,?)",
            (
                "vid_vnet",
                str(course_dir / "2. Virtual Networks Deep Dive.mp4"),
                "Azure Cloud Fundamentals",
                "2. Virtual Networks Deep Dive",
                2000,
                2,
                "done",
                db.utcnow(),
            ),
        )
        conn.execute(
            "INSERT INTO course_publication VALUES(?,1,?,?)",
            ("Azure Cloud Fundamentals", "Hands-on cloud architecture", db.utcnow()),
        )
        conn.execute(
            "INSERT INTO lecture_providers VALUES(?,?,?,?)",
            ("vid_intro", "intro-claim", "a" * 40, db.utcnow()),
        )

    def login(email, password=PASSWORD):
        c = TestClient(main.app, base_url="https://testserver")
        r = c.post("/api/auth/login", json={"email": email, "password": password})
        assert r.status_code == 200, r.text
        c.headers["x-csrf-token"] = r.json()["csrf_token"]
        return c, r.json()["user"]

    admin_client, _ = login("admin@courseforge.test")

    student_client = TestClient(main.app, base_url="https://testserver")
    r = student_client.post(
        "/api/auth/register",
        json={"email": "learner@courseforge.test", "name": "Learner", "password": PASSWORD},
    )
    assert r.status_code == 201, r.text
    student_client.headers["x-csrf-token"] = r.json()["csrf_token"]
    assert (
        student_client.post("/api/courses/Azure Cloud Fundamentals/enroll", json={}).status_code
        == 201
    )

    return config, admin_user, admin_client, student_client


def test_universal_search_courses_lessons_and_materials(phase1_env):
    _, _, _, student = phase1_env
    res = student.get("/api/search?q=Virtual")
    assert res.status_code == 200
    data = res.json()
    assert any(l["id"] == "vid_vnet" for l in data["lessons"])
    assert any(m["name"] == "2. Virtual Networks Guide.pdf" for m in data["materials"])

    res_course = student.get("/api/search?q=Azure")
    assert res_course.status_code == 200
    assert any(c["course"] == "Azure Cloud Fundamentals" for c in res_course.json()["courses"])


def test_materials_grouping_types_and_no_jargon(phase1_env):
    _, _, _, student = phase1_env
    mats_res = student.get("/api/materials?course=Azure Cloud Fundamentals")
    assert mats_res.status_code == 200
    mats = mats_res.json()["materials"]
    by_name = {m["name"]: m for m in mats}

    nb = by_name["1. Introduction to Cloud.ipynb"]
    assert nb["material_type"] == "Notebook"
    assert nb["friendly_name"] == "Introduction to Cloud"
    assert nb["scope"] == "lesson"
    assert nb["lesson_id"] == "vid_intro"

    pdf = by_name["2. Virtual Networks Guide.pdf"]
    assert pdf["material_type"] == "PDF"
    assert pdf["scope"] == "lesson"
    assert pdf["lesson_id"] == "vid_vnet"

    # Preview notebook in browser and ensure zero developer/storage jargon
    preview = student.get(nb["url"])
    assert preview.status_code == 200
    assert "Welcome to Cloud" in preview.text
    for forbidden in ("Odysee Cloud Claim", "Odysee Cloud Vault", "stream_create"):
        assert forbidden not in preview.text

    # Download endpoint sets attachment Content-Disposition
    dl = student.get(nb["download_url"])
    assert dl.status_code == 200
    assert "attachment" in dl.headers.get("content-disposition", "").lower()


def test_admin_course_listing_reordering_and_materials_management(phase1_env):
    _, _, admin, student = phase1_env

    # 1. Admin course listing metrics
    listing = admin.get("/api/admin/courses")
    assert listing.status_code == 200
    courses = listing.json()["courses"]
    course_row = next(c for c in courses if c["course"] == "Azure Cloud Fundamentals")
    assert course_row["lesson_count"] == 2
    assert course_row["available_lessons"] == 1
    assert course_row["pending_lessons"] == 1
    assert course_row["material_count"] == 3
    assert course_row["enrolled_students"] == 1
    assert course_row["published"] is True

    # 2. Drill into course detail
    detail = admin.get("/api/admin/courses/Azure Cloud Fundamentals/detail")
    assert detail.status_code == 200
    d_json = detail.json()
    assert [l["id"] for l in d_json["lessons"]] == ["vid_intro", "vid_vnet"]

    # 3. Reorder lessons (swap vid_vnet to #1 and vid_intro to #2) and assign custom sections
    reorder_res = admin.put(
        "/api/admin/courses/Azure Cloud Fundamentals/organization",
        json={
            "lessons": [
                {"video_id": "vid_vnet", "display_order": 1, "section_title": "Week 1 — Networking Core"},
                {"video_id": "vid_intro", "display_order": 2, "section_title": "Week 2 — Cloud Overview"},
            ]
        },
    )
    assert reorder_res.status_code == 200

    # Verify course and lecture IDs never changed, order updated, and material-to-lesson assignments survived!
    videos = student.get("/api/videos?course=Azure Cloud Fundamentals").json()["videos"]
    assert [v["id"] for v in videos] == ["vid_vnet", "vid_intro"]
    assert videos[0]["section"] == "Week 1 — Networking Core"
    assert videos[1]["section"] == "Week 2 — Cloud Overview"

    mats_after = {
        m["name"]: m
        for m in student.get("/api/materials?course=Azure Cloud Fundamentals").json()["materials"]
    }
    assert mats_after["1. Introduction to Cloud.ipynb"]["lesson_id"] == "vid_intro"
    assert mats_after["2. Virtual Networks Guide.pdf"]["lesson_id"] == "vid_vnet"
    assert mats_after["2. Virtual Networks Guide.pdf"]["flow_order"] < mats_after["1. Introduction to Cloud.ipynb"]["flow_order"]

    # 4. Upload a new section-level material, then update & delete it
    import base64
    upload_res = admin.post(
        "/api/admin/courses/Azure Cloud Fundamentals/materials",
        json={
            "filename": "week1_cheatsheet.pdf",
            "friendly_name": "Week 1 Reference Sheet",
            "scope": "section",
            "lesson_id": None,
            "section_title": "Week 1 — Networking Core",
            "content_base64": base64.b64encode(b"%PDF-1.4 cheatsheet").decode("ascii"),
        },
    )
    assert upload_res.status_code == 201
    created_mats = {m["name"]: m for m in upload_res.json()["materials"]}
    created_mat = created_mats["week1_cheatsheet.pdf"]
    assert created_mat["friendly_name"] == "Week 1 Reference Sheet"
    assert created_mat["scope"] == "section"
    assert created_mat["lesson_id"] is None
    assert created_mat["section"] == "Week 1 — Networking Core"

    # Patch material metadata to assign to vid_vnet lesson
    patch_res = admin.patch(
        "/api/admin/courses/Azure Cloud Fundamentals/materials/week1_cheatsheet.pdf",
        json={
            "friendly_name": "Updated Networking Sheet",
            "scope": "lesson",
            "lesson_id": "vid_vnet",
            "section_title": "Week 1 — Networking Core",
        },
    )
    assert patch_res.status_code == 200
    mats_patched = {
        m["name"]: m
        for m in student.get("/api/materials?course=Azure Cloud Fundamentals").json()["materials"]
    }
    assert mats_patched["week1_cheatsheet.pdf"]["friendly_name"] == "Updated Networking Sheet"
    assert mats_patched["week1_cheatsheet.pdf"]["scope"] == "lesson"
    assert mats_patched["week1_cheatsheet.pdf"]["lesson_id"] == "vid_vnet"

    # Delete material
    del_res = admin.delete("/api/admin/courses/Azure Cloud Fundamentals/materials/week1_cheatsheet.pdf")
    assert del_res.status_code == 200
    mats_final = {
        m["name"]: m
        for m in student.get("/api/materials?course=Azure Cloud Fundamentals").json()["materials"]
    }
    assert "week1_cheatsheet.pdf" not in mats_final
