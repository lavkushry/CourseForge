/**
 * Rate-limit fairness probe (API plane, public catalog only).
 *
 * Demonstrates the Cloud-Agent 429 root cause: per-IP token buckets with all
 * k6 VUs sharing RemoteAddr 127.0.0.1. With CF_TRUST_PROXY=true and distinct
 * X-Forwarded-For per VU (and loadtest bypass OFF), 429s drop sharply.
 *
 * NOT a capacity-doc open-model campaign and NOT a 10k claim.
 *
 * Env:
 *   BASE_URL     default http://127.0.0.1:18191 (dedicated fairness API)
 *   VUS          default 20
 *   DURATION     default 15s per scenario
 *   MODE         shared|xff  (or run both scenarios via default options)
 *   RPS_HINT     informational only (expected CF_RATE_LIMIT_RPS on target)
 *
 * Target must have CF_TRUST_PROXY=true, CF_LOADTEST_BYPASS_TOKEN unset/empty,
 * and a tight CF_RATE_LIMIT_RPS/BURST so shared-IP pressure is visible.
 */
import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Rate } from "k6/metrics";

const BASE = __ENV.BASE_URL || "http://127.0.0.1:18191";
const VUS = Math.max(2, Number(__ENV.VUS || 20));
const DURATION = __ENV.DURATION || "15s";
const MODE = (__ENV.MODE || "").toLowerCase();

const status200 = new Counter("fairness_http_200");
const status429 = new Counter("fairness_http_429");
const other = new Counter("fairness_http_other");
const fail = new Rate("fairness_unexpected_fail");

function scenario(name, useXFF) {
  return {
    executor: "constant-vus",
    vus: VUS,
    duration: DURATION,
    gracefulStop: "5s",
    env: { FAIRNESS_XFF: useXFF ? "1" : "0" },
    tags: { fairness: name },
  };
}

export const options = {
  scenarios:
    MODE === "shared"
      ? { shared_ip: scenario("shared_ip", false) }
      : MODE === "xff"
        ? { distinct_xff: scenario("distinct_xff", true) }
        : {
            shared_ip: Object.assign(scenario("shared_ip", false), {
              startTime: "0s",
            }),
            distinct_xff: Object.assign(scenario("distinct_xff", true), {
              startTime: "18s",
            }),
          },
  thresholds: {
    // Hard errors only — 429 is the signal under test, not a fail.
    fairness_unexpected_fail: ["rate<0.02"],
  },
  summaryTrendStats: ["avg", "med", "p(95)", "p(99)", "max", "count"],
};

export function setup() {
  const live = http.get(`${BASE}/health/live`, { timeout: "5s" });
  if (live.status !== 200) {
    throw new Error(`fairness target ${BASE} not live (status ${live.status})`);
  }
  return { base: BASE, vus: VUS };
}

export default function () {
  const useXFF = (__ENV.FAIRNESS_XFF || "0") === "1";
  const headers = { Origin: BASE };
  if (useXFF) {
    // Distinct /24-ish synthetic clients; TrustProxy must honor first XFF hop.
    headers["X-Forwarded-For"] = `203.0.113.${(__VU % 250) + 1}`;
  }
  const res = http.get(`${BASE}/api/v1/public/courses?limit=5`, {
    headers,
    tags: {
      plane: "api",
      name: "public_courses",
      fairness: useXFF ? "distinct_xff" : "shared_ip",
    },
    timeout: "5s",
  });
  const tags = { fairness: useXFF ? "distinct_xff" : "shared_ip" };
  if (res.status === 200) {
    status200.add(1, tags);
  } else if (res.status === 429) {
    status429.add(1, tags);
  } else {
    other.add(1, tags);
    fail.add(1);
  }
  check(res, {
    "200 or 429": (r) => r.status === 200 || r.status === 429,
  });
  // ~5–7 req/s/VU: shared-IP exhausts a tight bucket; distinct XFF should not.
  sleep(0.12 + Math.random() * 0.06);
}
