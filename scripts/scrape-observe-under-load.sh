#!/usr/bin/env bash
# Sample observe gauges while a load harness runs. Assert values can move and
# never leak session/token/provider secrets. Not a capacity / 10k claim.
set -euo pipefail

API_METRICS="${CF_API_METRICS_URL:-http://127.0.0.1:18190/metrics}"
MEDIA_METRICS="${CF_MEDIA_METRICS_URL:-http://127.0.0.1:18194/metrics}"
# High-frequency occupancy sampling: prefer INTERVAL_MS=200–500 under short Ranges.
SAMPLES="${SAMPLES:-12}"
INTERVAL_MS="${INTERVAL_MS:-250}"
if (( INTERVAL_MS < 50 )); then INTERVAL_MS=50; fi
if (( INTERVAL_MS > 5000 )); then INTERVAL_MS=5000; fi
DURATION_S="${DURATION_S:-}"
if [[ -n "$DURATION_S" ]]; then
  SAMPLES=$(awk -v d="$DURATION_S" -v ms="$INTERVAL_MS" 'BEGIN{n=int((d*1000+ms-1)/ms); if(n<1)n=1; print n}')
fi
OUT="${OUT:-/tmp/observe-under-load.jsonl}"
: >"$OUT"
echo "observe-under-load INTERVAL_MS=$INTERVAL_MS SAMPLES=$SAMPLES" >&2

forbid_leaks() {
  local url="$1" body="$2"
  for needle in 'ps_session' 'odysee.com' 'Bearer ' 't=secret' 'claim_id='; do
    if grep -F "$needle" <<<"$body" >/dev/null; then
      echo "LEAK on $url: $needle" >&2
      return 1
    fi
  done
  return 0
}

gauge() {
  local body="$1" name="$2"
  # Exact line match for unlabeled gauges; first match for labeled.
  local line
  line=$(grep -E "^${name}( |\{)" <<<"$body" | head -1 || true)
  if [[ -z "$line" ]]; then
    echo ""
    return
  fi
  awk '{print $NF}' <<<"$line"
}

max_seen_media_in_use=0
max_seen_crit_in_use=0
any_nonzero=0
FAIL=0

for i in $(seq 1 "$SAMPLES"); do
  api_body=$(curl -fsS --max-time 3 "$API_METRICS" || true)
  media_body=$(curl -fsS --max-time 3 "$MEDIA_METRICS" || true)
  if [[ -z "$api_body" || -z "$media_body" ]]; then
    echo "scrape miss sample=$i" >&2
    FAIL=1
    sleep "$(awk -v ms="$INTERVAL_MS" 'BEGIN{printf "%.3f", ms/1000}')"
    continue
  fi
  forbid_leaks "$API_METRICS" "$api_body" || FAIL=1
  forbid_leaks "$MEDIA_METRICS" "$media_body" || FAIL=1

  tin=$(gauge "$media_body" 'courseforge_media_transfers_in_use')
  tcap=$(gauge "$media_body" 'courseforge_media_transfers_capacity')
  cin=$(grep -F 'courseforge_admission_in_use{class="critical"}' <<<"$media_body" | awk '{print $NF}' | head -1)
  ain=$(grep -F 'courseforge_admission_in_use{class="critical"}' <<<"$api_body" | awk '{print $NF}' | head -1)

  tin=${tin:-0}
  cin=${cin:-0}
  ain=${ain:-0}
  if (( tin > max_seen_media_in_use )); then max_seen_media_in_use=$tin; fi
  if (( cin > max_seen_crit_in_use )); then max_seen_crit_in_use=$cin; fi
  if (( ain > max_seen_crit_in_use )); then max_seen_crit_in_use=$ain; fi
  if (( tin > 0 || cin > 0 || ain > 0 )); then any_nonzero=1; fi

  printf '{"sample":%s,"media_transfers_in_use":%s,"media_transfers_capacity":%s,"media_critical_in_use":%s,"api_critical_in_use":%s}\n' \
    "$i" "$tin" "${tcap:-}" "$cin" "$ain" >>"$OUT"
  echo "sample $i media_in_use=$tin critical_media=$cin critical_api=$ain"
  sleep "$(awk -v ms="$INTERVAL_MS" 'BEGIN{printf "%.3f", ms/1000}')"
done

echo "max_media_transfers_in_use=$max_seen_media_in_use max_critical_in_use=$max_seen_crit_in_use any_nonzero=$any_nonzero"
if [[ "$FAIL" -ne 0 ]]; then
  echo "observe-under-load ASSERT FAIL (leaks or scrape errors)" >&2
  exit 1
fi
if [[ "$any_nonzero" -eq 0 ]]; then
  echo "observe-under-load ASSERT FAIL (gauges never left 0 — load may have missed scrape window)" >&2
  exit 1
fi
echo "observe-under-load ASSERT PASS"
