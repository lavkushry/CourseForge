#!/usr/bin/env bash
# Generate decodable synthetic media without copying any real course content.
set -euo pipefail
fixture_dir="${1:-/tmp/courseforge-rewrite-media}"
mkdir -p "$fixture_dir"
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i 'testsrc2=size=640x360:rate=30' \
  -f lavfi -i 'sine=frequency=440:sample_rate=48000' \
  -t 30 -c:v libx264 -threads 1 -preset veryfast -pix_fmt yuv420p \
  -b:v 3M -minrate 3M -maxrate 3M -bufsize 6M \
  -x264-params 'nal-hrd=cbr:force-cfr=1' -g 60 \
  -c:a aac -b:a 96k -movflags +faststart "$fixture_dir/lecture.mp4"
ffprobe -v error -show_entries format=duration,size -of json "$fixture_dir/lecture.mp4"
