# Media delivery (HLS + progressive MP4)

## Edge / nginx

- Terminate TLS at the edge with **HTTP/2** enabled (`listen 443 ssl http2;` or the
  newer `http2 on;` directive for nginx ≥ 1.25.1). Application containers may
  speak cleartext HTTP/1.1 to the upstream Go media gateway.
- Enable `sendfile on;` and `tcp_nopush on;` so static/HLS segment responses avoid
  tiny packet writes.
- **Cache-Control**
  - HLS segments (`.m4s`, `.ts`, init `.mp4`): `private, max-age=31536000, immutable`
    (set by the media gateway; filenames are encode-stable).
  - HLS playlists (`.m3u8`): `private, max-age=5`.
  - Progressive MP4 via the playback token URL: `private, no-store` (capability URL).
- **Range requests**: progressive MP4 and local HLS files advertise `Accept-Ranges: bytes`.
  nginx must forward `Range` / `Content-Range` (already true for `/media/` and session media).
- **Compression**: `gzip` is enabled for text/JS/JSON/SVG and `application/vnd.apple.mpegurl`.
  Do not gzip media segments. **Brotli** is optional — enable only when the
  `ngx_brotli` module is present; otherwise leave gzip-only (this tree ships gzip).

## Worker

`backend/cmd/media/worker` encodes a 240p–1080p ladder (no upscaling past source),
fixed 5s fMP4 (or TS) segments, master playlist, plus `progressive.mp4` fallback.
