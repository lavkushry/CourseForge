from pathlib import Path

from knowledge_worker import QDRANT_COLLECTION
from knowledge_worker.pipeline import resolve_media_path, run_ingest
from knowledge_worker.qdrant_store import ensure_knowledge_collection

from conftest import MockASR, MockOCR, MockScenes


def test_resolve_media_path_relative(tmp_path: Path, tiny_media: Path):
    root = tiny_media.parent
    resolved = resolve_media_path({"source_path": tiny_media.name}, root)
    assert resolved == tiny_media.resolve()


def test_run_ingest_with_mocks(tmp_path: Path, tiny_media: Path, tiny_frame: Path, fixtures_dir: Path):
    bundle = run_ingest(
        tiny_media,
        tmp_path / "work",
        asr=MockASR(fixtures_dir),
        scenes=MockScenes(tiny_frame),
        ocr=MockOCR(),
    )
    assert bundle.asr_engine == "mock-whisper"
    assert bundle.scene_engine == "mock-scenedetect"
    assert bundle.ocr_engine == "mock-tesseract"
    assert len(bundle.words) == 2
    assert bundle.segments[0]["text"] == "hello world"
    assert bundle.keyframes[0]["ocr"]["tags"] == ["command", "code"]


def test_qdrant_collection_guard():
    class FakeClient:
        def __init__(self) -> None:
            self.created = None

        def collection_exists(self, name: str) -> bool:
            return False

        def create_collection(self, collection_name: str, vectors_config) -> None:
            self.created = collection_name

    client = FakeClient()
    ensure_knowledge_collection(client, dimension=8)
    assert client.created == QDRANT_COLLECTION
    try:
        ensure_knowledge_collection(client, dimension=8, collection="courseforge_chunks")
        raise AssertionError("should refuse legacy collection")
    except ValueError:
        pass
