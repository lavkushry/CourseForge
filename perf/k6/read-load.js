import http from "k6/http";
import { check, sleep } from "k6";

/**
 * Public/read ramp toward MAX_VUS concurrent virtual users.
 * Defaults target a local constrained API (see ../README.md).
 *
 * Env:
 *   BASE_URL   default http://127.0.0.1:8080
 *   MAX_VUS    default 10000
 *   COURSE_ID  optional published course id/slug for detail hits
 */
const BASE = __ENV.BASE_URL || "http://127.0.0.1:8080";
const MAX_VUS = Number(__ENV.MAX_VUS || 10000);
const COURSE_ID = __ENV.COURSE_ID || "";

export const options = {
  scenarios: {
    read_ramp: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "1m", target: Math.min(100, MAX_VUS) },
        { duration: "2m", target: Math.min(1000, MAX_VUS) },
        { duration: "3m", target: Math.min(5000, MAX_VUS) },
        { duration: "5m", target: MAX_VUS },
        { duration: "5m", target: MAX_VUS },
        { duration: "2m", target: 0 },
      ],
      gracefulRampDown: "30s",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<500"],
  },
};

function pick(paths) {
  return paths[Math.floor(Math.random() * paths.length)];
}

export default function () {
  const detail =
    COURSE_ID !== ""
      ? `${BASE}/api/v1/public/courses/${COURSE_ID}`
      : `${BASE}/api/v1/public/courses?limit=20`;

  const url = pick([
    `${BASE}/health/live`,
    `${BASE}/health/ready`,
    `${BASE}/api/v1/public/courses?limit=20`,
    detail,
  ]);

  const res = http.get(url, {
    tags: { name: url.includes("/health/") ? "health" : "catalog" },
    timeout: "10s",
  });

  check(res, {
    "status is 2xx/3xx": (r) => r.status >= 200 && r.status < 400,
  });

  sleep(0.1 + Math.random() * 0.4);
}
