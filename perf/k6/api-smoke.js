import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Trend } from "k6/metrics";

/**
 * API-plane smoke only (health + public catalog). Not a 10k-learner claim.
 * Does not hit media delivery or AI jobs — report separately.
 *
 * Env:
 *   BASE_URL   default http://127.0.0.1:18090
 *   VUS        default 20
 *   DURATION   default 30s
 */
const BASE = __ENV.BASE_URL || "http://127.0.0.1:18090";
const VUS = Number(__ENV.VUS || 20);
const DURATION = __ENV.DURATION || "30s";

const apiFail = new Rate("api_plane_fail");
const apiDur = new Trend("api_plane_duration", true);

export const options = {
  scenarios: {
    api_smoke: {
      executor: "constant-vus",
      vus: VUS,
      duration: DURATION,
      gracefulStop: "5s",
    },
  },
  thresholds: {
    api_plane_fail: ["rate<0.01"],
    http_req_duration: ["p(95)<500", "p(99)<1000"],
  },
  summaryTrendStats: ["avg", "med", "p(95)", "p(99)", "max"],
};

export default function () {
  const urls = [
    `${BASE}/health/live`,
    `${BASE}/health/ready`,
    `${BASE}/api/v1/public/courses?limit=20`,
  ];
  const url = urls[Math.floor(Math.random() * urls.length)];
  const res = http.get(url, {
    tags: { plane: "api", name: url.includes("/health/") ? "health" : "catalog" },
    timeout: "5s",
  });
  const ok = res.status >= 200 && res.status < 400;
  apiFail.add(!ok);
  apiDur.add(res.timings.duration);
  check(res, { "api 2xx/3xx": () => ok });
  sleep(0.05 + Math.random() * 0.15);
}
