#!/usr/bin/env bash
# Poll admission/media gauges during a load run. Prefers product loopback /metrics.
set -euo pipefail

API_METRICS="${API_METRICS:-http://127.0.0.1:18090/metrics}"
MEDIA_METRICS="${MEDIA_METRICS:-http://127.0.0.1:18094/metrics}"
INTERVAL_MS="${INTERVAL_MS:-500}"
DURATION_S="${DURATION_S:-90}"
OUT="${1:-/tmp/cf-admission-under-load.tsv}"

echo -e "ts_ms\tsource\tmetric\tlabels\tvalue" > "$OUT"
end_ms=$(( $(date +%s%3N) + DURATION_S * 1000 ))
while (( $(date +%s%3N) < end_ms )); do
  now=$(date +%s%3N)
  for src_url_pair in "api|${API_METRICS}" "media|${MEDIA_METRICS}"; do
    src=${src_url_pair%%|*}
    url=${src_url_pair#*|}
    body=$(curl -fsS -m 2 "$url" 2>/dev/null || true)
    [[ -z "$body" ]] && continue
    printf '%s\n' "$body" | awk -v ts="$now" -v src="$src" '
      /^courseforge_(admission_|media_transfers_|media_busy_|media_no_source|media_provider_|media_circuit_)/ && $1 !~ /^#/ {
        metric=$1; val=$2
        labels=""
        if (match(metric, /\{.*\}/)) {
          labels=substr(metric, RSTART+1, RLENGTH-2)
          metric=substr(metric, 1, RSTART-1)
        }
        printf "%s\t%s\t%s\t%s\t%s\n", ts, src, metric, labels, val
      }'
  done >> "$OUT"
  # bash sleep fractional
  python3 - <<PY
import time; time.sleep(${INTERVAL_MS}/1000.0)
PY
done
echo "wrote $OUT"
