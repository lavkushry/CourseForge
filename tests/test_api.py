from pathlib import Path
from client_helpers import TestClient
from app import main, db
from dataclasses import replace
import pytest

@pytest.fixture(autouse=True)
def isolated(tmp_path,monkeypatch):
    config=replace(db.settings,data_dir=tmp_path/"data",courses_dir=tmp_path/"courses")
    monkeypatch.setattr(db,"settings",config)
    monkeypatch.setattr(main,"settings",config)


def test_app_root_and_health(tmp_path, monkeypatch):
    # Avoid starting expensive external services; the API startup only creates SQLite.
    client=TestClient(main.app)
    response=client.get('/')
    assert response.status_code==200
    assert b'CourseForge' in response.content
    assert client.get('/api/health').json()['status']=='ok'


def test_query_validation():
    client=TestClient(main.app)
    assert client.post('/api/ask',json={'question':'','mode':'explain'}).status_code==422
    assert client.post('/api/ask',json={'question':'hello','mode':'invalid'}).status_code==422
