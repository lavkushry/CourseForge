"""Scene/keyframe detection: PySceneDetect preferred, ffmpeg fallback."""

from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol


@dataclass(frozen=True)
class Keyframe:
    time_ms: int
    path: Path
    width: int = 0
    height: int = 0


@dataclass(frozen=True)
class SceneResult:
    engine: str
    keyframes: list[Keyframe]


class SceneDetector(Protocol):
    def detect(self, media_path: Path, out_dir: Path) -> SceneResult: ...


def _probe_size(path: Path) -> tuple[int, int]:
    try:
        from PIL import Image

        with Image.open(path) as img:
            return int(img.width), int(img.height)
    except Exception:
        return 0, 0


class PySceneDetectScenes:
    def detect(self, media_path: Path, out_dir: Path) -> SceneResult:
        from scenedetect import (  # type: ignore
            ContentDetector,
            SceneManager,
            open_video,
        )
        from scenedetect.scene_manager import save_images  # type: ignore

        out_dir.mkdir(parents=True, exist_ok=True)
        video = open_video(str(media_path))
        manager = SceneManager()
        manager.add_detector(ContentDetector())
        manager.detect_scenes(video)
        scene_list = manager.get_scene_list()
        if not scene_list:
            # At least one frame near the start for OCR coverage.
            frame = out_dir / "frame_000001.jpg"
            subprocess.run(
                [
                    "ffmpeg",
                    "-y",
                    "-ss",
                    "0",
                    "-i",
                    str(media_path),
                    "-frames:v",
                    "1",
                    str(frame),
                ],
                check=True,
                capture_output=True,
                timeout=120,
            )
            w, h = _probe_size(frame)
            return SceneResult(
                engine="pyscenedetect+ffmpeg",
                keyframes=[Keyframe(time_ms=0, path=frame, width=w, height=h)],
            )

        save_images(scene_list, video, num_images=1, output_dir=str(out_dir), image_name_template="frame_$SCENE_NUMBER")
        keyframes: list[Keyframe] = []
        for idx, (start, _end) in enumerate(scene_list, start=1):
            path = out_dir / f"frame_{idx:03d}.jpg"
            if not path.exists():
                # scenedetect naming can vary slightly by version
                matches = sorted(out_dir.glob(f"frame_{idx:03d}*.jpg"))
                if not matches:
                    continue
                path = matches[0]
            w, h = _probe_size(path)
            keyframes.append(
                Keyframe(time_ms=int(start.get_seconds() * 1000), path=path, width=w, height=h)
            )
        return SceneResult(engine="pyscenedetect", keyframes=keyframes)


class FFmpegScenes:
    """Fallback: extract frames on a fixed interval using ffmpeg scene filter."""

    def __init__(self, interval_seconds: float = 10.0) -> None:
        self._interval = max(1.0, float(interval_seconds))
        if shutil.which("ffmpeg") is None:
            raise FileNotFoundError("ffmpeg not found")

    def detect(self, media_path: Path, out_dir: Path) -> SceneResult:
        out_dir.mkdir(parents=True, exist_ok=True)
        pattern = out_dir / "frame_%06d.jpg"
        # scene filter + fps thinning keeps CPU cost bounded on arm64.
        filt = f"select='eq(n,0)+gt(scene,0.35)',fps=1/{self._interval}"
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-i",
                str(media_path),
                "-vf",
                filt,
                "-vsync",
                "vfr",
                str(pattern),
            ],
            check=True,
            capture_output=True,
            timeout=600,
        )
        frames = sorted(out_dir.glob("frame_*.jpg"))
        if not frames:
            # Guaranteed single frame so OCR stage has input.
            single = out_dir / "frame_000001.jpg"
            subprocess.run(
                ["ffmpeg", "-y", "-ss", "0", "-i", str(media_path), "-frames:v", "1", str(single)],
                check=True,
                capture_output=True,
                timeout=120,
            )
            frames = [single]
        keyframes: list[Keyframe] = []
        for idx, path in enumerate(frames):
            w, h = _probe_size(path)
            keyframes.append(
                Keyframe(time_ms=int(idx * self._interval * 1000), path=path, width=w, height=h)
            )
        return SceneResult(engine="ffmpeg", keyframes=keyframes)


def build_scene_detector(prefer: SceneDetector | None = None) -> SceneDetector:
    if prefer is not None:
        return prefer
    try:
        import scenedetect  # noqa: F401

        return PySceneDetectScenes()
    except Exception:
        return FFmpegScenes()


def write_scene_manifest(result: SceneResult, path: Path) -> None:
    path.write_text(
        json.dumps(
            {
                "engine": result.engine,
                "keyframes": [
                    {
                        "time_ms": kf.time_ms,
                        "path": str(kf.path),
                        "width": kf.width,
                        "height": kf.height,
                    }
                    for kf in result.keyframes
                ],
            },
            indent=2,
        ),
        encoding="utf-8",
    )
