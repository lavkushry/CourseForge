#!/usr/bin/env bash
# Cursor-owned Muse verify harness. Muse never claims pass/fail — this script does.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="${ROOT}/tmp"
SUMMARY_JSON="${TMP_DIR}/muse_verify_last.json"
SUMMARY_TXT="${TMP_DIR}/muse_verify_last.txt"
GATES_JSONL="${TMP_DIR}/muse_verify_gates.jsonl"

NODE_BIN="${NODE_BIN:-/home/ubuntu/.nvm/versions/node/v22.23.3/bin}"
# Prefer /usr/local/bin/go when present (AGENTS.md); fall back to PATH (this host: /usr/bin/go 1.26.x).
if [[ -z "${GO_BIN:-}" ]]; then
  if [[ -x /usr/local/bin/go ]]; then
    GO_BIN=/usr/local/bin/go
  else
    GO_BIN="$(command -v go || true)"
  fi
fi
PY_BIN="${PY_BIN:-/home/ubuntu/Resume/.venv/bin/python3}"

# Postgres: Cloud Agent often uses native :5432; this host maps compose to :15439.
if [[ -z "${CF_TEST_DATABASE_URL:-}" ]]; then
  pick_db_url() {
    local port="$1"
    if (echo >/dev/tcp/127.0.0.1/"$port") >/dev/null 2>&1; then
      echo "postgresql://courseforge:local_rewrite_only@127.0.0.1:${port}/courseforge_rewrite?sslmode=disable"
      return 0
    fi
    return 1
  }
  if ! CF_TEST_DATABASE_URL="$(pick_db_url 5432)"; then
    if ! CF_TEST_DATABASE_URL="$(pick_db_url 15439)"; then
      CF_TEST_DATABASE_URL="postgresql://courseforge:local_rewrite_only@127.0.0.1:5432/courseforge_rewrite?sslmode=disable"
    fi
  fi
fi
export CF_TEST_DATABASE_URL

RUN_GO=0
RUN_WEB=0
RUN_WORKER=0
RUN_E2E=0

usage() {
  cat <<'EOF'
Usage: ./scripts/muse_verify.sh [--go] [--web] [--worker] [--e2e] [--all]

  --go       Go build + career/migrations/cmd tests
  --web      web typecheck/build (npm run build)
  --worker   career_worker pytest
  --e2e      tests/career_e2e/runner.py
  --all      all of the above

With no flags, runs --all.
Writes tmp/muse_verify_last.json and tmp/muse_verify_last.txt
EOF
}

if [[ $# -eq 0 ]]; then
  RUN_GO=1
  RUN_WEB=1
  RUN_WORKER=1
  RUN_E2E=1
else
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --go) RUN_GO=1 ;;
      --web) RUN_WEB=1 ;;
      --worker) RUN_WORKER=1 ;;
      --e2e) RUN_E2E=1 ;;
      --all)
        RUN_GO=1
        RUN_WEB=1
        RUN_WORKER=1
        RUN_E2E=1
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        echo "Unknown flag: $1" >&2
        usage >&2
        exit 2
        ;;
    esac
    shift
  done
fi

mkdir -p "${TMP_DIR}" "${ROOT}/bin"
: >"${SUMMARY_TXT}"
: >"${GATES_JSONL}"

STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
OVERALL=0
PASSED_COUNT=0
FAILED_COUNT=0

append_txt() {
  printf '%s\n' "$1" | tee -a "${SUMMARY_TXT}"
}

record_gate() {
  local name="$1" status="$2" detail="$3" passed="$4" failed="$5"
  python3 -c 'import json,sys; print(json.dumps({"name":sys.argv[1],"status":sys.argv[2],"detail":sys.argv[3],"passed":int(sys.argv[4]),"failed":int(sys.argv[5])}))' \
    "$name" "$status" "$detail" "$passed" "$failed" >>"${GATES_JSONL}"
  append_txt "[$status] $name  passed=$passed failed=$failed"
  if [[ -n "$detail" ]]; then
    append_txt "  $detail"
  fi
  if [[ "$status" != "pass" ]]; then
    OVERALL=1
  fi
}

parse_pytest_counts() {
  local out="$1"
  PASSED_COUNT=0
  FAILED_COUNT=0
  local p f e
  p="$(printf '%s' "$out" | grep -oE '[0-9]+ passed' | tail -n1 | grep -oE '[0-9]+' || true)"
  f="$(printf '%s' "$out" | grep -oE '[0-9]+ failed' | tail -n1 | grep -oE '[0-9]+' || true)"
  e="$(printf '%s' "$out" | grep -oE '[0-9]+ error' | tail -n1 | grep -oE '[0-9]+' || true)"
  [[ -n "$p" ]] && PASSED_COUNT="$p"
  [[ -n "$f" ]] && FAILED_COUNT="$f"
  if [[ -n "$e" ]]; then
    FAILED_COUNT=$((FAILED_COUNT + e))
  fi
}

run_go() {
  append_txt "== go =="
  if [[ ! -x "$GO_BIN" ]]; then
    record_gate "go" "fail" "missing $GO_BIN" 0 1
    return
  fi
  export PATH="$(dirname "$GO_BIN"):${PATH}"
  export CF_TEST_DATABASE_URL
  export GOCACHE="${GOCACHE:-/tmp/go-build-cache-muse-verify}"
  local out rc=0
  set +e
  out="$(
    cd "${ROOT}/backend" && \
      "$GO_BIN" build -o "${ROOT}/bin/courseforge-api-muse-verify" ./cmd/api && \
      "$GO_BIN" test ./internal/career/... ./internal/store/migrations/... ./cmd/api/...
  )"
  rc=$?
  set -e
  printf '%s\n' "$out" >>"${SUMMARY_TXT}"
  parse_pytest_counts "$out"
  if [[ "$PASSED_COUNT" -eq 0 && "$FAILED_COUNT" -eq 0 ]]; then
    local oks fails
    oks="$(printf '%s' "$out" | grep -cE '^ok\s' || true)"
    fails="$(printf '%s' "$out" | grep -cE '^FAIL\s' || true)"
    PASSED_COUNT="$oks"
    FAILED_COUNT="$fails"
  fi
  if [[ $rc -eq 0 ]]; then
    record_gate "go" "pass" "build+test ok" "$PASSED_COUNT" 0
  else
    record_gate "go" "fail" "go exit=$rc" "$PASSED_COUNT" "$FAILED_COUNT"
  fi
}

run_web() {
  append_txt "== web =="
  export PATH="${NODE_BIN}:${PATH}"
  if ! command -v npm >/dev/null 2>&1; then
    record_gate "web" "fail" "npm not on PATH (need Node 22.23.3 bin first)" 0 1
    return
  fi
  local out rc=0
  set +e
  out="$(cd "${ROOT}/web" && npm run build 2>&1)"
  rc=$?
  set -e
  printf '%s\n' "$out" >>"${SUMMARY_TXT}"
  if [[ $rc -eq 0 ]]; then
    record_gate "web" "pass" "npm run build ok" 1 0
  else
    record_gate "web" "fail" "npm run build exit=$rc" 0 1
  fi
}

run_worker() {
  append_txt "== worker =="
  if [[ ! -x "$PY_BIN" ]]; then
    record_gate "worker" "fail" "missing $PY_BIN" 0 1
    return
  fi
  local out rc=0
  set +e
  out="$(cd "${ROOT}" && "$PY_BIN" -m pytest -q services/career_worker/tests/ 2>&1)"
  rc=$?
  set -e
  printf '%s\n' "$out" >>"${SUMMARY_TXT}"
  parse_pytest_counts "$out"
  if [[ $rc -eq 0 ]]; then
    record_gate "worker" "pass" "pytest ok" "$PASSED_COUNT" "$FAILED_COUNT"
  else
    if [[ "$FAILED_COUNT" -eq 0 ]]; then
      FAILED_COUNT=1
    fi
    record_gate "worker" "fail" "pytest exit=$rc" "$PASSED_COUNT" "$FAILED_COUNT"
  fi
}

run_e2e() {
  append_txt "== e2e =="
  if [[ ! -x "$PY_BIN" ]]; then
    record_gate "e2e" "fail" "missing $PY_BIN" 0 1
    return
  fi
  local out rc=0
  set +e
  out="$(cd "${ROOT}" && "$PY_BIN" tests/career_e2e/runner.py 2>&1)"
  rc=$?
  set -e
  printf '%s\n' "$out" >>"${SUMMARY_TXT}"
  parse_pytest_counts "$out"
  local total_line
  total_line="$(printf '%s' "$out" | grep -E 'TOTAL|passed|failed' | tail -n5 | tr '\n' ' ' || true)"
  # Prefer runner TOTAL line: "TOTAL <passed> <failed> <duration>"
  local total_passed total_failed
  total_passed="$(printf '%s\n' "$out" | sed -nE 's/.*TOTAL[[:space:]]+([0-9]+)[[:space:]]+([0-9]+).*/\1/p' | tail -n1 || true)"
  total_failed="$(printf '%s\n' "$out" | sed -nE 's/.*TOTAL[[:space:]]+([0-9]+)[[:space:]]+([0-9]+).*/\2/p' | tail -n1 || true)"
  if [[ -n "$total_passed" ]]; then PASSED_COUNT="$total_passed"; fi
  if [[ -n "$total_failed" ]]; then FAILED_COUNT="$total_failed"; fi
  if [[ $rc -eq 0 ]]; then
    record_gate "e2e" "pass" "runner ok; ${total_line}" "$PASSED_COUNT" "$FAILED_COUNT"
  else
    if [[ "$FAILED_COUNT" -eq 0 ]]; then
      FAILED_COUNT=1
    fi
    record_gate "e2e" "fail" "runner exit=$rc; ${total_line}" "$PASSED_COUNT" "$FAILED_COUNT"
  fi
}

append_txt "muse_verify start ${STARTED_AT}"
append_txt "root=${ROOT}"

if [[ "$RUN_GO" -eq 1 ]]; then run_go; fi
if [[ "$RUN_WEB" -eq 1 ]]; then run_web; fi
if [[ "$RUN_WORKER" -eq 1 ]]; then run_worker; fi
if [[ "$RUN_E2E" -eq 1 ]]; then run_e2e; fi

FINISHED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
OVERALL_STATUS="pass"
if [[ "$OVERALL" -ne 0 ]]; then
  OVERALL_STATUS="fail"
fi

python3 - "$SUMMARY_JSON" "$STARTED_AT" "$FINISHED_AT" "$OVERALL_STATUS" "$GATES_JSONL" <<'PY'
import json, sys
out_path, started, finished, overall, gates_path = sys.argv[1:6]
gates = []
with open(gates_path, encoding="utf-8") as f:
    for line in f:
        line = line.strip()
        if line:
            gates.append(json.loads(line))
doc = {
    "started_at": started,
    "finished_at": finished,
    "overall": overall,
    "gates": gates,
    "note": "Cursor-owned Muse harness. Do not invent 382/382; use these counts.",
}
with open(out_path, "w", encoding="utf-8") as f:
    json.dump(doc, f, indent=2)
    f.write("\n")
PY

append_txt "muse_verify finished ${FINISHED_AT} overall=${OVERALL_STATUS}"
append_txt "summary_json=${SUMMARY_JSON}"

echo
echo "Overall: ${OVERALL_STATUS}"
echo "Wrote ${SUMMARY_JSON}"
exit "${OVERALL}"
