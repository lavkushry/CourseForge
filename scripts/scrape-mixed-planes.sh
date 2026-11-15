#!/usr/bin/env bash
# Sample API + media observe gauges during concurrent plane load.
# High-frequency default (250ms) so short Ranges show realistic occupancy peaks.
# Asserts both planes move and never leak provider/session secrets.
# NOT a capacity / 10k claim — report planes separately.
#
# Env:
#   INTERVAL_MS   sample period (default 250; clamp 50–5000)
#   SAMPLES       fixed sample count (ignored when DURATION_S set)
#   DURATION_S    wall-clock window; samples = ceil(DURATION_S*1000/INTERVAL_MS)
#   QUIET=1       log every 20th sample only (peaks still tracked)
#   OUT           jsonl path
set -euo pipefail

API_METRICS="${CF_API_METRICS_URL:-http://127.0.0.1:18190/metrics}"
MEDIA_METRICS="${CF_MEDIA_METRICS_URL:-http://127.0.0.1:18194/metrics}"
INTERVAL_MS="${INTERVAL_MS:-250}"
if (( INTERVAL_MS < 50 )); then INTERVAL_MS=50; fi
if (( INTERVAL_MS > 5000 )); then INTERVAL_MS=5000; fi
DURATION_S="${DURATION_S:-}"
if [[ -n "$DURATION_S" ]]; then
  SAMPLES=$(awk -v d="$DURATION_S" -v ms="$INTERVAL_MS" 'BEGIN{n=int((d*1000+ms-1)/ms); if(n<1)n=1; print n}')
else
  SAMPLES="${SAMPLES:-40}"
fi
OUT="${OUT:-/tmp/mixed-planes.jsonl}"
QUIET="${QUIET:-0}"
CURL_MAX="$(awk -v ms="$INTERVAL_MS" 'BEGIN{t=ms/1000*0.8; if(t<0.2)t=0.2; if(t>2)t=2; printf "%.2f", t}')"
: >"$OUT"

max_api_pulse=0
max_api_crit=0
max_api_http=0
max_media_xfer=0
max_media_crit=0
any_api=0
any_media=0
FAIL=0
misses=0

gauge() {
  local body="$1" name="$2"
  local line
  line=$(grep -E "^${name}( |\{)" <<<"$body" | head -1 || true)
  [[ -z "$line" ]] && { echo ""; return; }
  awk '{print $NF}' <<<"$line"
}

echo "mixed-plane scrape INTERVAL_MS=$INTERVAL_MS SAMPLES=$SAMPLES CURL_MAX=${CURL_MAX}s QUIET=$QUIET" >&2

for i in $(seq 1 "$SAMPLES"); do
  api_body=$(curl -fsS --max-time "$CURL_MAX" "$API_METRICS" 2>/dev/null || true)
  media_body=$(curl -fsS --max-time "$CURL_MAX" "$MEDIA_METRICS" 2>/dev/null || true)
  if [[ -z "$api_body" || -z "$media_body" ]]; then
    misses=$((misses + 1))
    # Soft miss: do not fail the whole run on a single timeout under high frequency.
    if (( misses > SAMPLES / 10 && misses > 5 )); then
      echo "scrape miss sample=$i (misses=$misses)" >&2
      FAIL=1
    fi
    sleep "$(awk -v ms="$INTERVAL_MS" 'BEGIN{printf "%.3f", ms/1000}')"
    continue
  fi
  for needle in 'odysee.com' 'Bearer ' 'claim_id=' 'ps_session'; do
    if grep -F "$needle" <<<"$api_body$media_body" >/dev/null; then
      echo "LEAK on metrics: $needle" >&2
      FAIL=1
    fi
  done

  ap=$(grep -F 'courseforge_admission_in_use{class="pulse"}' <<<"$api_body" | awk '{print $NF}' | head -1)
  ac=$(grep -F 'courseforge_admission_in_use{class="critical"}' <<<"$api_body" | awk '{print $NF}' | head -1)
  ah=$(gauge "$api_body" courseforge_http_active)
  mt=$(gauge "$media_body" courseforge_media_transfers_in_use)
  mc=$(grep -F 'courseforge_admission_in_use{class="critical"}' <<<"$media_body" | awk '{print $NF}' | head -1)
  ap=${ap:-0}
  ac=${ac:-0}
  ah=${ah:-0}
  mt=${mt:-0}
  mc=${mc:-0}

  ((ap > max_api_pulse)) && max_api_pulse=$ap
  ((ac > max_api_crit)) && max_api_crit=$ac
  ((ah > max_api_http)) && max_api_http=$ah
  ((mt > max_media_xfer)) && max_media_xfer=$mt
  ((mc > max_media_crit)) && max_media_crit=$mc
  ((ap + ac + ah > 0)) && any_api=1
  ((mt + mc > 0)) && any_media=1

  printf '{"sample":%s,"api_pulse":%s,"api_crit":%s,"api_http_active":%s,"media_xfer":%s,"media_crit":%s}\n' \
    "$i" "$ap" "$ac" "$ah" "$mt" "$mc" >>"$OUT"
  if [[ "$QUIET" != "1" ]] || (( i == 1 || i == SAMPLES || i % 20 == 0 || mt > 0 || ap > 0 )); then
    echo "sample $i api_pulse=$ap api_http=$ah media_xfer=$mt media_crit=$mc"
  fi
  sleep "$(awk -v ms="$INTERVAL_MS" 'BEGIN{printf "%.3f", ms/1000}')"
done

echo "PEAKS api_pulse=$max_api_pulse api_crit=$max_api_crit api_http_active=$max_api_http media_xfer=$max_media_xfer media_crit=$max_media_crit any_api=$any_api any_media=$any_media misses=$misses interval_ms=$INTERVAL_MS"
if [[ "$FAIL" -ne 0 ]]; then
  echo "mixed-plane ASSERT FAIL (leaks or scrape errors)" >&2
  exit 1
fi
if [[ "$any_api" -eq 0 || "$any_media" -eq 0 ]]; then
  echo "mixed-plane ASSERT FAIL (need both planes nonzero — not a blended 10k claim)" >&2
  exit 1
fi
echo "mixed-plane ASSERT PASS (both planes nonzero; report API and media separately; not 10k)"
