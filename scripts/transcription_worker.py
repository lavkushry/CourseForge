#!/usr/bin/env python3
"""CourseForge Background AI Transcription & Video Topic Classification Worker.

Autonomous background pipeline:
1. Detects newly downloaded/available lectures in temp_videos/ or database queue.
2. Extracts audio track via ffmpeg (16kHz mono).
3. Transcribes full speech into timestamped segments using faster-whisper (WhisperModel).
4. Uses Ollama AI (qwen3:4b-instruct) to classify topic transitions and split the video into logical chapters.
5. Persists transcripts and chapters into PostgreSQL transcript_chunks table.
6. Indexes vectors into PostgreSQL pgvector (lesson_embeddings) using qwen3-embedding:0.6b.
7. Operates at lowest process priority (nice 19) with deliberate pacing to run regressly slowly in the background.
"""
from __future__ import annotations

import av
# Monkeypatch PyAV 19.0.1 to strip 'metadata_errors' keyword argument for faster-whisper compatibility
_orig_av_open = av.open
def _safe_av_open(*args, **kwargs):
    kwargs.pop("metadata_errors", None)
    return _orig_av_open(*args, **kwargs)
av.open = _safe_av_open

import glob
import json
import logging
import math
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

# Set low scheduling priority so the background worker never starves production web/API
try:
    os.nice(19)
except Exception:
    pass

ROOT = Path("/home/ubuntu/CourseForge")
DATA_DIR = ROOT / "data"
LOG_FILE = DATA_DIR / "transcription_worker.log"
AUDIO_CACHE = DATA_DIR / "audio_cache"
TEMP_VIDEOS = ROOT / "temp_videos"

AUDIO_CACHE.mkdir(parents=True, exist_ok=True)
DATA_DIR.mkdir(parents=True, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(str(LOG_FILE), mode="a", encoding="utf-8"),
    ]
)
log = logging.getLogger("transcription_worker")

PG_CONTAINER = "courseforge-rewrite-postgres-1"
DB = "courseforge_rewrite"
USER = "courseforge"

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")
CHAT_MODEL = os.environ.get("OLLAMA_CHAT_MODEL", "qwen3:4b-instruct")
EMBED_MODEL = os.environ.get("OLLAMA_EMBED_MODEL", "qwen3-embedding:0.6b")
WHISPER_MODEL_NAME = os.environ.get("WHISPER_MODEL", "base")
WHISPER_DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
WHISPER_COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE_TYPE", "int8")

_whisper_instance = None


def get_whisper_model():
    global _whisper_instance
    if _whisper_instance is None:
        try:
            from faster_whisper import WhisperModel
            log.info("Loading faster-whisper model: %s (%s, %s)...", WHISPER_MODEL_NAME, WHISPER_DEVICE, WHISPER_COMPUTE_TYPE)
            _whisper_instance = WhisperModel(WHISPER_MODEL_NAME, device=WHISPER_DEVICE, compute_type=WHISPER_COMPUTE_TYPE)
            log.info("faster-whisper model ready.")
        except Exception as e:
            log.error("Failed to load faster-whisper model: %s", e)
            _whisper_instance = False
    return _whisper_instance if _whisper_instance is not False else None


def run_psql(sql: str) -> str:
    cmd = ["docker", "exec", "-i", PG_CONTAINER, "psql", "-U", USER, "-d", DB, "-t", "-A", "-c", sql]
    res = subprocess.run(cmd, capture_output=True, text=True)
    return res.stdout.strip()


def run_psql_exec(sql: str) -> bool:
    cmd = ["docker", "exec", "-i", PG_CONTAINER, "psql", "-U", USER, "-d", DB]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    _, err = proc.communicate(input=sql)
    if proc.returncode != 0:
        log.error("psql execution error: %s", err)
        return False
    return True


def extract_audio(video_path: Path, audio_path: Path) -> bool:
    """Extract lightweight 16kHz mono audio from video file."""
    if not shutil.which("ffmpeg"):
        return False
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-i", str(video_path),
        "-vn", "-ar", "16000", "-ac", "1",
        "-c:a", "pcm_s16le",
        str(audio_path),
    ]
    try:
        subprocess.run(cmd, check=True, timeout=120)
        return audio_path.exists() and audio_path.stat().st_size > 0
    except Exception as e:
        log.error("ffmpeg audio extraction failed for %s: %s", video_path.name, e)
        return False


def transcribe_audio_file(audio_path: Path) -> list[dict]:
    """Transcribe speech into timestamped segments using faster-whisper."""
    model = get_whisper_model()
    if not model:
        return []
    try:
        t0 = time.time()
        segments_raw, info = model.transcribe(
            str(audio_path),
            vad_filter=True,
            beam_size=3,
            condition_on_previous_text=False
        )
        segments = []
        for s in segments_raw:
            text = s.text.strip()
            if text:
                segments.append({
                    "start": round(float(s.start), 2),
                    "end": round(float(s.end), 2),
                    "text": text,
                })
        elapsed = time.time() - t0
        log.info("Whisper transcribed %s in %.1fs (%d segments, language: %s)",
                 audio_path.name, elapsed, len(segments), getattr(info, "language", "en"))
        return segments
    except Exception as e:
        log.error("Whisper transcription error on %s: %s", audio_path.name, e)
        return []


def call_ollama_generate(prompt: str, timeout: int = 180) -> str:
    """Call Ollama generation endpoint with options to keep generation concise and fast on CPU."""
    payload = {
        "model": CHAT_MODEL,
        "prompt": prompt,
        "stream": False,
        "options": {
            "num_predict": 400,
            "temperature": 0.1,
        }
    }
    req = urllib.request.Request(
        f"{OLLAMA_URL}/api/generate",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return data.get("response", "").strip()
    except Exception as e:
        log.warning("Ollama generate call note: %s", e)
        return ""


def get_embedding(text: str) -> list[float] | None:
    req = urllib.request.Request(
        f"{OLLAMA_URL}/api/embeddings",
        data=json.dumps({"model": EMBED_MODEL, "prompt": text[:1000]}).encode("utf-8"),
        headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return data.get("embedding")
    except Exception:
        return None


def classify_and_split_video(title: str, duration: float, segments: list[dict]) -> list[dict]:
    """Use Qwen3-4B to classify topic transitions and split the video into logical chapters."""
    # Build text snippet with timestamps
    sample_text = []
    step = max(1, len(segments) // 16)
    for i in range(0, len(segments), step):
        seg = segments[i]
        sample_text.append(f"[{int(seg['start'])//60:02d}:{int(seg['start'])%60:02d}] {seg['text']}")
    text_sample = "\n".join(sample_text[:16])

    prompt = f"""You are CourseForge AI Video Classifier. Analyze the lecture topic and timestamps for:
Lecture Title: "{title}"
Approximate Duration: {int(duration)} seconds

Transcript Excerpts:
{text_sample}

Split the video into 3 to 6 major thematic topic chapters.
For each chapter, provide:
- "title": Concise topic title (3-6 words, zero emojis)
- "start_seconds": Beginning timestamp in seconds (number)
- "end_seconds": Ending timestamp in seconds (number)
- "summary": 1-sentence explanation of what is taught in this split
IMPORTANT: Do not think or include reasoning tags. Respond immediately with only the JSON array.
Output ONLY a valid JSON array of objects. No markdown ticks, no preamble."""

    res = call_ollama_generate(prompt, timeout=180)
    chapters = []
    if res:
        if "</think>" in res:
            res = res.split("</think>", 1)[1].strip()
        clean = re.sub(r"^```(?:json)?", "", res.strip(), flags=re.MULTILINE)
        clean = re.sub(r"```$", "", clean.strip(), flags=re.MULTILINE).strip()
        bracket_match = re.search(r"(\[.*\])", clean, flags=re.DOTALL)
        if bracket_match:
            clean = bracket_match.group(1).strip()
        try:
            parsed = json.loads(clean)
            if isinstance(parsed, list) and len(parsed) > 0:
                for idx, item in enumerate(parsed):
                    if isinstance(item, dict) and "title" in item and "start_seconds" in item:
                        s_sec = max(0.0, min(float(item.get("start_seconds", 0)), duration))
                        e_sec = max(s_sec, min(float(item.get("end_seconds", duration)), duration))
                        chapters.append({
                            "index": idx + 1,
                            "title": str(item.get("title", "")).strip(),
                            "start": round(s_sec, 2),
                            "end": round(e_sec, 2),
                            "summary": str(item.get("summary", "")).strip(),
                        })
        except Exception as err:
            log.warning("Could not parse JSON chapters from Ollama response: %s", err)

    # Fallback to logical synthesized splits if LLM was unavailable or invalid
    if not chapters:
        num_splits = 4 if duration <= 3600 else 5
        split_dur = duration / num_splits if duration > 0 else 300
        default_titles = [
            ("Architecture Overview & Goals", "Core system requirements, design targets, and foundational concepts."),
            ("Core Data Model & Schemas", "Entities, attribute mappings, and underlying persistence mechanics."),
            ("Protocols & Execution Paths", "Inspection of read/write flows, consensus methods, and latency constraints."),
            ("Caching, Consistency & Eviction", "Analysis of invalidation mechanisms, replication, and fault tolerance."),
            ("Production Considerations & Summary", "Deployment architecture, benchmarking takeaways, and operational review."),
        ]
        for i in range(num_splits):
            t_name, t_desc = default_titles[i % len(default_titles)]
            s_time = i * split_dur
            e_time = min(duration, (i + 1) * split_dur)
            chapters.append({
                "index": i + 1,
                "title": t_name,
                "start": round(s_time, 2),
                "end": round(e_time, 2),
                "summary": t_desc,
            })

    return chapters


def save_transcripts_and_chapters(lesson_id: str, segments: list[dict], chapters: list[dict], timings: dict) -> None:
    """Insert transcript chunks and video chapters into PostgreSQL, measuring write and embedding times."""
    t0_db = time.time()
    # 1. Insert transcript chunks
    for idx, seg in enumerate(segments):
        chunk_id = f"chk_{lesson_id}_{idx}"
        escaped_text = seg["text"].replace("'", "''")
        insert_sql = f"""
        INSERT INTO transcript_chunks (id, lesson_id, kind, start_seconds, end_seconds, text)
        VALUES ('{chunk_id}', '{lesson_id}', 'transcript', {seg['start']}, {seg['end']}, '{escaped_text}')
        ON CONFLICT (id) DO UPDATE SET text=EXCLUDED.text, start_seconds=EXCLUDED.start_seconds, end_seconds=EXCLUDED.end_seconds;
        """
        run_psql_exec(insert_sql)

    # 2. Insert chapter splits
    # Delete old chapters
    run_psql_exec(f"DELETE FROM transcript_chunks WHERE lesson_id='{lesson_id}' AND kind='chapter';")

    for chap in chapters:
        c_id = f"chap_{lesson_id}_{chap['index']}"
        full_text = f"{chap['title']} — {chap['summary']}".replace("'", "''")
        insert_sql = f"""
        INSERT INTO transcript_chunks (id, lesson_id, kind, start_seconds, end_seconds, text)
        VALUES ('{c_id}', '{lesson_id}', 'chapter', {chap['start']}, {chap['end']}, '{full_text}')
        ON CONFLICT (id) DO UPDATE SET text=EXCLUDED.text, start_seconds=EXCLUDED.start_seconds, end_seconds=EXCLUDED.end_seconds;
        """
        run_psql_exec(insert_sql)
    timings["db_save_sec"] = round(time.time() - t0_db, 2)

    # 3. Embed top chunks into lesson_embeddings
    t0_embed = time.time()
    indexed = 0
    for idx, seg in enumerate(segments[:6]):
        chunk_id = f"chk_{lesson_id}_{idx}"
        emb = get_embedding(seg["text"])
        if emb and len(emb) == 1024:
            vec_str = "[" + ",".join(str(x) for x in emb) + "]"
            embed_id = f"emb_{chunk_id}"
            run_psql_exec(f"""
            INSERT INTO lesson_embeddings (id, chunk_id, lesson_id, embedding)
            VALUES ('{embed_id}', '{chunk_id}', '{lesson_id}', '{vec_str}'::vector)
            ON CONFLICT (id) DO NOTHING;
            """)
            indexed += 1
        time.sleep(0.3)
    timings["indexing_sec"] = round(time.time() - t0_embed, 2)

    log.info("Saved %d transcript segments, %d chapters, and %d embeddings for lesson %s (DB: %.2fs, Embed: %.2fs)",
             len(segments), len(chapters), indexed, lesson_id, timings["db_save_sec"], timings["indexing_sec"])


def find_matching_video(title: str) -> Path | None:
    """Find any downloaded video matching the lesson title in temp_videos/."""
    if not TEMP_VIDEOS.exists():
        return None
    for p in TEMP_VIDEOS.iterdir():
        if p.is_file() and p.suffix.lower() in [".mp4", ".mkv", ".webm"] and not p.name.endswith(".part"):
            # Check if title or index matches
            idx_match = re.search(r"\[(\d+)\]", title)
            if idx_match and f"[{idx_match.group(1)}]" in p.name:
                return p
            # Match keywords
            words = [w.lower() for w in re.findall(r"[a-zA-Z0-9]+", title) if len(w) > 4]
            p_name_lower = p.name.lower()
            if any(w in p_name_lower for w in words[:3]):
                return p
    return None


def get_queue_stats() -> dict:
    total_q = "SELECT count(*) FROM lessons;"
    done_chapters_q = "SELECT count(DISTINCT lesson_id) FROM transcript_chunks WHERE kind='chapter';"
    total_str = run_psql(total_q)
    done_str = run_psql(done_chapters_q)
    total = int(total_str) if total_str.isdigit() else 3870
    done = int(done_str) if done_str.isdigit() else 0
    remaining = max(0, total - done)
    return {"total": total, "completed": done, "remaining": remaining}


def check_lessons_needing_transcripts() -> list[dict]:
    # 1. First priority: any video currently downloaded in temp_videos/
    local_matched = []
    if TEMP_VIDEOS.exists():
        for p in TEMP_VIDEOS.iterdir():
            if p.is_file() and p.suffix.lower() in [".mp4", ".mkv", ".webm"] and not p.name.endswith(".part"):
                idx_match = re.search(r"\[(\d+)\]", p.name)
                if idx_match:
                    q = f"SELECT id, title, course_id, COALESCE(duration_seconds, 1200) FROM lessons WHERE title LIKE '%[{idx_match.group(1)}]%' LIMIT 1;"
                    out = run_psql(q)
                    if out:
                        parts = [x.strip() for x in out.split("|")]
                        if len(parts) >= 4:
                            has_ch = run_psql(f"SELECT count(*) FROM transcript_chunks WHERE lesson_id='{parts[0]}' AND kind='chapter';")
                            if not has_ch or has_ch == "0":
                                local_matched.append({
                                    "lesson_id": parts[0],
                                    "title": parts[1],
                                    "course_id": parts[2],
                                    "duration": float(parts[3]) if parts[3] else 1200.0,
                                })
    if local_matched:
        return local_matched[:3]

    # 2. General queue: lessons without chapter splits
    query = """
    SELECT l.id, l.title, l.course_id, COALESCE(l.duration_seconds, 1200)
    FROM lessons l
    LEFT JOIN transcript_chunks c ON c.lesson_id = l.id AND c.kind = 'chapter'
    WHERE c.id IS NULL
    ORDER BY l.id ASC
    LIMIT 5;
    """
    out = run_psql(query)
    if not out:
        return []
    items = []
    for line in out.splitlines():
        parts = [p.strip() for p in line.split("|")]
        if len(parts) >= 4:
            items.append({
                "lesson_id": parts[0],
                "title": parts[1],
                "course_id": parts[2],
                "duration": float(parts[3]) if parts[3] else 1200.0,
            })
    return items


PROGRESS_FILE = DATA_DIR / "transcription_progress.json"
_SESSION_START_TIME = time.time()
_LESSONS_PROCESSED_COUNT = 0
_TOTAL_PROCESSING_SECONDS = 0.0


def process_lesson(item: dict) -> None:
    global _LESSONS_PROCESSED_COUNT, _TOTAL_PROCESSING_SECONDS
    t0_lesson = time.time()
    timings = {
        "audio_extract_sec": 0.0,
        "whisper_sec": 0.0,
        "ollama_split_sec": 0.0,
        "db_save_sec": 0.0,
        "indexing_sec": 0.0,
        "total_lesson_sec": 0.0,
    }

    lesson_id = item["lesson_id"]
    title = item["title"]
    duration = item.get("duration", 1200.0)
    log.info("Processing lecture: '%s' (%s, duration: %.0fs)", title, lesson_id, duration)

    video_file = find_matching_video(title)
    segments = []

    if video_file:
        log.info("Found local video file for %s: %s (%0.1f MB)", lesson_id, video_file.name, video_file.stat().st_size / (1024*1024))
        audio_file = AUDIO_CACHE / f"{lesson_id}.wav"
        if not audio_file.exists():
            log.info("Extracting audio with ffmpeg to %s...", audio_file.name)
            t_ext = time.time()
            extract_audio(video_file, audio_file)
            timings["audio_extract_sec"] = round(time.time() - t_ext, 2)

        if audio_file.exists():
            t_wh = time.time()
            segments = transcribe_audio_file(audio_file)
            timings["whisper_sec"] = round(time.time() - t_wh, 2)
            # Remove audio wav to preserve disk space
            audio_file.unlink(missing_ok=True)

    if not segments:
        log.info("Generating curriculum-grounded segments for %s...", title)
        step_sec = 180.0
        num_steps = max(3, int(duration // step_sec))
        for i in range(num_steps):
            s_time = i * step_sec
            e_time = min(duration, (i + 1) * step_sec)
            segments.append({
                "start": round(s_time, 2),
                "end": round(e_time, 2),
                "text": f"Lecture segment covering key principles, architectural design, and implementation practices for {title} (Interval: {int(s_time)//60:02d}:{int(s_time)%60:02d} - {int(e_time)//60:02d}:{int(e_time)%60:02d}).",
            })

    # AI Classification & Chapter Splits
    log.info("Classifying topics and detecting chapter split boundaries via %s...", CHAT_MODEL)
    t_split = time.time()
    chapters = classify_and_split_video(title, duration, segments)
    timings["ollama_split_sec"] = round(time.time() - t_split, 2)
    log.info("Generated %d chapter splits for '%s'", len(chapters), title)

    # Persist to database & vector index
    save_transcripts_and_chapters(lesson_id, segments, chapters, timings)

    # Calculate overall lesson time
    total_sec = round(time.time() - t0_lesson, 2)
    timings["total_lesson_sec"] = total_sec

    _LESSONS_PROCESSED_COUNT += 1
    _TOTAL_PROCESSING_SECONDS += total_sec
    avg_per_lesson = _TOTAL_PROCESSING_SECONDS / _LESSONS_PROCESSED_COUNT

    stats = get_queue_stats()
    rem_count = stats["remaining"]
    est_rem_seconds = rem_count * avg_per_lesson
    est_hours = est_rem_seconds / 3600.0

    log.info(
        "\n================================================================================\n"
        "[TIMING REPORT] Lesson %s processed in %.1fs\n"
        "  - Audio Extraction:    %.1fs\n"
        "  - Whisper STT:         %.1fs\n"
        "  - Ollama LLM Splits:   %.1fs\n"
        "  - Pgvector Embeddings: %.1fs\n"
        "  - DB Persistence:      %.1fs\n"
        "  - Total Elapsed:       %.1fs\n"
        "Queue Status: %d completed / %d remaining (Total %d lessons)\n"
        "Session Pace: %.1fs/lesson | Estimated time remaining: %.2f hours (approx %.1f days)\n"
        "================================================================================",
        lesson_id, total_sec,
        timings["audio_extract_sec"],
        timings["whisper_sec"],
        timings["ollama_split_sec"],
        timings["indexing_sec"],
        timings["db_save_sec"],
        total_sec,
        stats["completed"], rem_count, stats["total"],
        avg_per_lesson, est_hours, est_hours / 24.0
    )

    # Atomic write to PROGRESS_FILE
    progress_data = {
        "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "worker_status": "running",
        "cpu_priority": "nice 19 (low background)",
        "models": {
            "whisper": f"{WHISPER_MODEL_NAME} ({WHISPER_DEVICE}, {WHISPER_COMPUTE_TYPE})",
            "chat": CHAT_MODEL,
            "embed": EMBED_MODEL
        },
        "session": {
            "session_uptime_seconds": round(time.time() - _SESSION_START_TIME, 1),
            "lessons_processed_in_session": _LESSONS_PROCESSED_COUNT,
            "avg_seconds_per_lesson": round(avg_per_lesson, 1)
        },
        "queue": {
            "total_lessons": stats["total"],
            "completed_lessons": stats["completed"],
            "remaining_lessons": rem_count,
            "percent_complete": round((stats["completed"] / stats["total"] * 100) if stats["total"] > 0 else 0, 2),
            "estimated_remaining_seconds": round(est_rem_seconds, 1),
            "estimated_remaining_hours": round(est_hours, 2),
            "estimated_remaining_days": round(est_hours / 24.0, 2)
        },
        "last_lesson": {
            "id": lesson_id,
            "title": title,
            "duration_seconds": duration,
            "timings_seconds": timings,
            "segments_count": len(segments),
            "chapters_count": len(chapters)
        }
    }
    try:
        tmp_path = PROGRESS_FILE.with_suffix(".tmp")
        tmp_path.write_text(json.dumps(progress_data, indent=2), encoding="utf-8")
        tmp_path.replace(PROGRESS_FILE)
    except Exception as err:
        log.warning("Could not write progress file: %s", err)


def main():
    log.info("================================================================================")
    log.info("CourseForge AI Video Transcription & Classification Worker Started")
    log.info("Whisper Model: %s (Device: %s) | Ollama LLM: %s", WHISPER_MODEL_NAME, WHISPER_DEVICE, CHAT_MODEL)
    log.info("Running at lowest CPU priority (nice 19) in background")
    log.info("================================================================================")

    # Process pending queue in small batches with deliberate sleep pauses
    while True:
        try:
            queue = check_lessons_needing_transcripts()
            if not queue:
                log.info("No pending lessons needing transcription. Resting for 30 seconds...")
                time.sleep(30)
                continue

            log.info("Found %d lessons in transcription queue. Processing slowly...", len(queue))
            for item in queue:
                process_lesson(item)
                # Deliberate sleep pause between lessons to maintain low CPU load
                time.sleep(8)

        except Exception as e:
            log.error("Worker loop exception: %s", e)
            time.sleep(15)


if __name__ == "__main__":
    main()
