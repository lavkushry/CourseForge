#!/usr/bin/env bash
# CourseForge AI Transcription & Chapter Split Progress Viewer

PROGRESS_FILE="/home/ubuntu/CourseForge/data/transcription_progress.json"

if [ ! -f "$PROGRESS_FILE" ]; then
    echo "No active transcription progress file found at $PROGRESS_FILE."
    exit 1
fi

TOTAL=$(jq -r '.total_lessons // 3870' "$PROGRESS_FILE")
COMPLETED=$(jq -r '.completed_lessons // 0' "$PROGRESS_FILE")
REMAINING=$(jq -r '.remaining_lessons // 0' "$PROGRESS_FILE")
PERCENT=$(jq -r '.percent_complete // 0' "$PROGRESS_FILE")
ETA=$(jq -r '.eta_formatted // "calculating..."' "$PROGRESS_FILE")
SPEED=$(jq -r '.seconds_per_lesson // 0' "$PROGRESS_FILE")
STATUS=$(jq -r '.status // "unknown"' "$PROGRESS_FILE")
CURRENT_TITLE=$(jq -r '.current_lesson_title // "N/A"' "$PROGRESS_FILE")
CURRENT_ID=$(jq -r '.current_lesson_id // "N/A"' "$PROGRESS_FILE")
UPDATED=$(jq -r '.last_updated // "N/A"' "$PROGRESS_FILE")

BAR_WIDTH=40
FILLED=$(awk -v p="$PERCENT" -v w="$BAR_WIDTH" 'BEGIN { printf "%d", (p / 100) * w }')
EMPTY=$((BAR_WIDTH - FILLED))
BAR=""
for ((i=0; i<FILLED; i++)); do BAR="${BAR}█"; done
for ((i=0; i<EMPTY; i++)); do BAR="${BAR}░"; done

echo "================================================================================"
echo "          COURSEFORGE BACKGROUND AI VIDEO CLASSIFICATION & SPLIT PIPELINE        "
echo "================================================================================"
echo " Status             : [${STATUS^^}]"
echo " Progress           : [${BAR}] ${PERCENT}%"
echo " Processed Lessons  : ${COMPLETED} / ${TOTAL} (Remaining: ${REMAINING})"
echo " Processing Speed   : ${SPEED}s per lecture"
echo " Estimated Time Left: ${ETA}"
echo "--------------------------------------------------------------------------------"
echo " Current Lesson     : ${CURRENT_TITLE}"
echo " Lesson ID          : ${CURRENT_ID}"
echo " Last Heartbeat     : ${UPDATED}"
echo "================================================================================"
