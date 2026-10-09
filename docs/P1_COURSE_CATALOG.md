# CourseForge P1 — Local course catalog and thumbnail editing

## Behavior

- Courses remain identified by their source folder name; the friendly display title never changes `videos.course`, RAG indexes, progress, learning paths or saved notes.
- The new `course_metadata` SQLite table stores optional title, instructor, category, tags, cover origin and updated time. `init_db` automatically creates it on existing v2/v3 databases. Scan and reindex preserve edited details.
- Each course card shows a **real frame from its videos** if available, rather than an external image. The `/api/courses/{folder}/cover` endpoint lazily creates and caches a 960×540 JPEG in `DATA_DIR/covers` from an extracted screen chunk or a frame obtained with FFmpeg. `ffprobe` determines the seek time when the lecture duration is not indexed. If no usable frame exists, the original gradient fallback remains.
- Click **Edit details** on any course card in the Library or Dashboard. Change the title, optional instructor, category and comma-separated tags, or select an image from disk. Image upload is limited to 4 MiB, JPEG/PNG/WebP; the server decodes and re-encodes the file as 960×540 JPEG (stripping EXIF), so the original file is never persisted.
- **Restore video thumbnail** removes a custom cover and allows regeneration from the source video. Cover names are SHA-256 hashes of the course ID, not user-supplied filesystem paths.
- Course ratings are deliberately **not invented** and official Coursera/Udemy certificates are not created.

## API

| Endpoint | Description |
|---|---|
| `GET /api/courses` | Course metadata and lesson/duration counts |
| `PATCH /api/courses/{id}` | Update `title`, `instructor`, `category`, `tags` (`tags` max 12, each 1–32 characters) |
| `GET /api/courses/{id}/cover` | Generate/cache local cover image, or return 404 and use UI fallback |
| `PUT /api/courses/{id}/cover` | Raw JPEG/PNG/WebP request body, max 4 MiB |
| `DELETE /api/courses/{id}/cover` | Restore video-derived cover on next request |

All endpoints remain **loopback-only, unauthenticated**, like the existing app. Do not expose them publicly.

## Verify

```bash
python -m pytest -q
python -m compileall -q app scripts
node --check app/static/app.js
node --check app/static/services.js
```

Start API with `uvicorn app.main:app --host 127.0.0.1 --port 8000` and import a real local course via **Scan folders**. Open **Library → Edit details** and save changes. Check the course card, category/search filter and persisted metadata after restarting the app. The first thumbnail request may take longer on an unindexed video; subsequent requests use the local cache.

### Safety and limits

- User-entered metadata remains local. No network scraping or automatic inference of instructors, ratings or course ownership.
- FFmpeg processes local video files already under the configured library root. Uploaded images are size/type checked and re-encoded with Pillow. Source videos are never modified.
- Long libraries may generate many thumbnails when course cards first become visible. Images are lazy-loaded in the browser but thumbnail creation is still on-demand and CPU-bound; batch background generation and smarter frame selection are future improvements.
- If you change, remove, or rename an underlying course folder, its former metadata will not automatically migrate to a new folder name; a subsequent scan creates a new logical course.
- Browser tests use sample courses; real performance and color quality depend on actual video frames.
