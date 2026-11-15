#!/usr/bin/env bash
# Assert loopback observe gauges on API (:18190) and media (:18194).
# Not a capacity claim — scrape contract only (no session/token labels).
set -euo pipefail

API_METRICS="${CF_API_METRICS_URL:-http://127.0.0.1:18190/metrics}"
MEDIA_METRICS="${CF_MEDIA_METRICS_URL:-http://127.0.0.1:18194/metrics}"
FAIL=0

need() {
  local url="$1" needle="$2" body="$3"
  if ! grep -F "$needle" <<<"$body" >/dev/null; then
    echo "MISSING on $url: $needle" >&2
    FAIL=1
  fi
}

forbid() {
  local url="$1" needle="$2" body="$3"
  if grep -F "$needle" <<<"$body" >/dev/null; then
    echo "LEAK on $url: $needle" >&2
    FAIL=1
  fi
}

echo "scraping $API_METRICS"
API_BODY=$(curl -fsS --max-time 5 "$API_METRICS")
need "$API_METRICS" 'courseforge_admission_in_use{class="critical"}' "$API_BODY"
need "$API_METRICS" 'courseforge_admission_capacity{class="pulse"}' "$API_BODY"
need "$API_METRICS" 'courseforge_admission_sheds_total{class="ai"}' "$API_BODY"
# API may or may not export media gauges (embedded vs external media mode).
if grep -F 'courseforge_media_transfers_capacity' <<<"$API_BODY" >/dev/null; then
  need "$API_METRICS" 'courseforge_media_transfers_capacity' "$API_BODY"
fi
forbid "$API_METRICS" 'ps_session' "$API_BODY"
forbid "$API_METRICS" 'odysee.com' "$API_BODY"
forbid "$API_METRICS" 'Bearer ' "$API_BODY"

echo "scraping $MEDIA_METRICS"
MEDIA_BODY=$(curl -fsS --max-time 5 "$MEDIA_METRICS")
need "$MEDIA_METRICS" 'courseforge_media_transfers_in_use' "$MEDIA_BODY"
need "$MEDIA_METRICS" 'courseforge_media_transfers_capacity' "$MEDIA_BODY"
need "$MEDIA_METRICS" 'courseforge_media_busy_sheds_total' "$MEDIA_BODY"
need "$MEDIA_METRICS" 'courseforge_media_no_source_total' "$MEDIA_BODY"
need "$MEDIA_METRICS" 'courseforge_media_provider_fail_total' "$MEDIA_BODY"
need "$MEDIA_METRICS" 'courseforge_media_circuit_open' "$MEDIA_BODY"
need "$MEDIA_METRICS" 'courseforge_admission_in_use{class="critical"}' "$MEDIA_BODY"
forbid "$MEDIA_METRICS" 'ps_session' "$MEDIA_BODY"
forbid "$MEDIA_METRICS" 'odysee.com' "$MEDIA_BODY"
forbid "$MEDIA_METRICS" 't=secret' "$MEDIA_BODY"

if [[ "$FAIL" -ne 0 ]]; then
  echo "observe scrape ASSERT FAIL" >&2
  exit 1
fi
echo "observe scrape ASSERT PASS"
echo "--- media gauge snapshot ---"
grep -E '^courseforge_media_|^courseforge_admission_' <<<"$MEDIA_BODY" | head -40
