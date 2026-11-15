#!/usr/bin/env bash
# Scrape CourseForge admission / media gauges.
# Prefer product loopback /metrics (WithLoopbackMetrics). Observe addrs remain
# available for pprof + duplicate scrape (CF_OBSERVABILITY_ADDR).
set -euo pipefail

API_METRICS="${API_METRICS:-http://127.0.0.1:18090/metrics}"
MEDIA_METRICS="${MEDIA_METRICS:-http://127.0.0.1:18094/metrics}"
API_OBS="${API_OBS:-http://127.0.0.1:18190/metrics}"
MEDIA_OBS="${MEDIA_OBS:-http://127.0.0.1:18194/metrics}"
OUT="${1:-/tmp/cf-admission-metrics.txt}"

scrape() {
  local title="$1" url="$2"
  echo "## ${title} (${url})"
  if curl -fsS -m 5 "$url" 2>/dev/null | grep -E 'courseforge_(admission_|media_|db_pool_|http_active|go_goroutines)'; then
    :
  else
    echo "(unavailable)"
  fi
  echo
}

{
  echo "# scraped $(date -Is)"
  scrape "API product" "$API_METRICS"
  scrape "Media product" "$MEDIA_METRICS"
  scrape "API observe" "$API_OBS"
  scrape "Media observe" "$MEDIA_OBS"
} | tee "$OUT"
