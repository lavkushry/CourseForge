#!/bin/bash
# Autonomous Watchdog for CourseForge Pipeline

DIR="/home/ubuntu/CourseForge"
VENV="$DIR/.venv/bin/python"
SCRIPT="$DIR/linux_pipeline.py"
LOG="$DIR/linux_pipeline.log"
WATCHDOG_LOG="$DIR/watchdog.log"
CURRICULA="$DIR/new_5_curricula.json"
MANIFEST="$DIR/data/odysee_manifest.json"

# 1. Check if linux_pipeline is already running
if pgrep -f "linux_pipeline.py" > /dev/null 2>&1; then
    exit 0
fi

# 2. Check if all courses are completed
UNFINISHED=$($VENV -c '
import json
from pathlib import Path

curricula = json.loads(Path("'$CURRICULA'").read_text())
manifest = json.loads(Path("'$MANIFEST'").read_text()) if Path("'$MANIFEST'").exists() else {}

missing = 0
for c in curricula:
    vids = [x for x in c["items"] if x["kind"] == "video"]
    for v in vids:
        k1 = f"{c["course_key"]}/{v["clean_filename"]}"
        k2 = v["clean_filename"]
        if not ((k1 in manifest and manifest[k1].get("claim_id")) or (k2 in manifest and manifest[k2].get("claim_id"))):
            missing += 1
print(missing)
')

if [ "$UNFINISHED" -eq "0" ]; then
    echo "$(date -u) - All courses completed (0 unmapped lectures remaining). Watchdog standing down." >> "$WATCHDOG_LOG"
    exit 0
fi

# 3. Pipeline not running and unfinished items remain -> Restart!
echo "$(date -u) - Pipeline stopped with $UNFINISHED unfinished lectures remaining. Relaunching in background..." >> "$WATCHDOG_LOG"
cd "$DIR"
nohup "$VENV" -u "$SCRIPT" >> "$LOG" 2>&1 &
echo "$(date -u) - Relaunched PID: $!" >> "$WATCHDOG_LOG"
