#!/usr/bin/env bash
# Start a short-lived loopback Prometheus with explicit TSDB retention, scrape
# API+media observe planes, archive a snapshot note. NOT a 10k / open-model claim.
#
# Env:
#   PROM_BIN       path to prometheus binary (default: discover under /tmp)
#   LISTEN         default 127.0.0.1:19090
#   RETENTION      default 6h
#   SCRAPE_SECS    how long to leave Prometheus up (default 45)
#   OUT_DIR        evidence dir
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROM_BIN="${PROM_BIN:-}"
if [[ -z "$PROM_BIN" ]]; then
  if [[ -x /tmp/prometheus-2.55.1.linux-arm64/prometheus ]]; then
    PROM_BIN=/tmp/prometheus-2.55.1.linux-arm64/prometheus
  elif command -v prometheus >/dev/null 2>&1; then
    PROM_BIN="$(command -v prometheus)"
  else
    echo "prometheus binary not found" >&2
    exit 2
  fi
fi
LISTEN="${LISTEN:-127.0.0.1:19090}"
RETENTION="${RETENTION:-6h}"
SCRAPE_SECS="${SCRAPE_SECS:-45}"
OUT_DIR="${OUT_DIR:-$ROOT/.ui-evidence/durable-observe-$(date +%Y%m%d-%H%M%S)}"
TSDB="$OUT_DIR/tsdb"
mkdir -p "$TSDB"

# Cgroup honesty probe (do not fake pin).
CGROUP_NOTE="$OUT_DIR/cgroup-probe.txt"
{
  echo "ts=$(date -Is)"
  echo "uid=$(id -u) user=$(id -un)"
  if [[ -w /sys/fs/cgroup ]]; then
    echo "cgroup_fs=writable"
  else
    echo "cgroup_fs=not_writable"
  fi
  if command -v cgcreate >/dev/null 2>&1; then
    echo "cgcreate=present"
    cgcreate -g cpu:/courseforge-probe 2>"$OUT_DIR/cgcreate.err" && echo "cgcreate=ok" || echo "cgcreate=denied"
    cgdelete -g cpu:/courseforge-probe 2>/dev/null || true
  else
    echo "cgcreate=absent"
  fi
  API_PID="$(ss -ltnp 2>/dev/null | grep ':18190' | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -1 || true)"
  echo "api_observe_pid=${API_PID:-none}"
  if [[ -n "${API_PID:-}" ]]; then
    tr '\0' ' ' < "/proc/$API_PID/cgroup" 2>/dev/null | head -c 500 || true
    echo
    echo -n "taskset_affinity="
    taskset -p "$API_PID" 2>/dev/null || echo unavailable
  fi
  echo "honesty=affinity_is_not_cgroup_cpu.max; no durable API cpu.max in this environment"
} >"$CGROUP_NOTE"

CFG="$ROOT/deploy/prometheus/prometheus.yml"
"$PROM_BIN" \
  --config.file="$CFG" \
  --storage.tsdb.path="$TSDB" \
  --storage.tsdb.retention.time="$RETENTION" \
  --web.listen-address="$LISTEN" \
  --web.enable-lifecycle \
  >"$OUT_DIR/prometheus.log" 2>&1 &
PROM_PID=$!
echo "$PROM_PID" >"$OUT_DIR/prometheus.pid"

cleanup() {
  if kill -0 "$PROM_PID" 2>/dev/null; then
    curl -fsS -X POST "http://$LISTEN/-/quit" >/dev/null 2>&1 || kill "$PROM_PID" 2>/dev/null || true
    wait "$PROM_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

for i in $(seq 1 40); do
  curl -fsS "http://$LISTEN/-/ready" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -fsS "http://$LISTEN/-/ready" >/dev/null

# Wait for at least one scrape interval (config=15s) plus buffer.
sleep "$SCRAPE_SECS"

API_UP=$(curl -fsS "http://$LISTEN/api/v1/query?query=up%7Bjob%3D%22courseforge-api-observe%22%7D" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["data"]["result"][0]["value"][1] if d.get("data",{}).get("result") else "missing")')
MEDIA_UP=$(curl -fsS "http://$LISTEN/api/v1/query?query=up%7Bjob%3D%22courseforge-media-observe%22%7D" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["data"]["result"][0]["value"][1] if d.get("data",{}).get("result") else "missing")')
XFER=$(curl -fsS "http://$LISTEN/api/v1/query?query=courseforge_media_transfers_capacity" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["data"]["result"][0]["value"][1] if d.get("data",{}).get("result") else "missing")')

python3 - <<PY
import json
from pathlib import Path
out = Path("$OUT_DIR")
verdict = {
  "plane": "observe_durable_sample",
  "prometheus": {"listen": "$LISTEN", "retention": "$RETENTION", "scrape_secs": int("$SCRAPE_SECS"), "pid": int("$PROM_PID")},
  "targets": {"api_observe_up": "$API_UP", "media_observe_up": "$MEDIA_UP", "media_transfers_capacity": "$XFER"},
  "tsdb": str(out / "tsdb"),
  "cgroup_probe": str(out / "cgroup-probe.txt"),
  "note": "TSDB retained under evidence dir for retention=$RETENTION; loopback only; not capacity-doc open-model / not 10k",
  "pass": "$API_UP" == "1" and "$MEDIA_UP" == "1",
}
(out / "durable-observe-verdict.json").write_text(json.dumps(verdict, indent=2) + "\n")
print("DURABLE_OBSERVE", json.dumps(verdict))
raise SystemExit(0 if verdict["pass"] else 1)
PY
