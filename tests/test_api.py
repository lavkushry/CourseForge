from pathlib import Path
from fastapi.testclient import TestClient
from app import main


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
