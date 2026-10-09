"""Single source of truth for local configuration."""
import os
from dataclasses import dataclass
from pathlib import Path
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / '.env')


def resolve_dir(raw: str) -> Path:
    path = Path(raw).expanduser()
    return (path if path.is_absolute() else ROOT / path).resolve()


@dataclass(frozen=True)
class Settings:
    courses_dir: Path = resolve_dir(os.getenv('COURSES_DIR', './courses'))
    data_dir: Path = resolve_dir(os.getenv('DATA_DIR', './data'))
    ollama_url: str = os.getenv('OLLAMA_URL', 'http://127.0.0.1:11434').rstrip('/')
    qdrant_url: str = os.getenv('QDRANT_URL', 'http://127.0.0.1:6333').rstrip('/')
    chat_model: str = os.getenv('CHAT_MODEL', 'qwen3:4b-instruct')
    embed_model: str = os.getenv('EMBED_MODEL', 'qwen3-embedding:0.6b')
    whisper_model: str = os.getenv('WHISPER_MODEL', 'base')
    whisper_device: str = os.getenv('WHISPER_DEVICE', 'cpu')
    whisper_compute_type: str = os.getenv('WHISPER_COMPUTE_TYPE', 'int8')
    frame_interval: int = max(10, int(os.getenv('FRAME_INTERVAL_SECONDS', '30')))
    max_frames: int = max(1, int(os.getenv('MAX_FRAMES_PER_VIDEO', '180')))
    disable_frames: bool = os.getenv('DISABLE_FRAMES', '0') == '1'
    enable_vision: bool = os.getenv('ENABLE_VISION', '1') == '1'
    vision_required: bool = os.getenv('VISION_REQUIRED', '0') == '1'
    vision_model: str = os.getenv('VISION_MODEL', 'gemma3:4b')
    max_vision_frames: int = max(0, int(os.getenv('MAX_VISION_FRAMES_PER_VIDEO', '30')))
    lab_image: str = os.getenv('LAB_IMAGE', 'courseforge-lab:local')
    enable_kind: bool = os.getenv('ENABLE_KIND_LABS', '0') == '1'

    @property
    def db_path(self) -> Path:
        return self.data_dir / 'courseforge.sqlite3'


settings = Settings()
