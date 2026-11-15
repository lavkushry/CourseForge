import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Trend, Counter } from "k6/metrics";

/**
 * Media-simulator plane only (cmd/mediasim). Not live Odysee, not API/AI.
 *
 * Env:
 *   MEDIA_URL  default http://127.0.0.1:18092
 *   VUS        default 10
 *   DURATION   default 20s
 */
const BASE = __ENV.MEDIA_URL || "http://127.0.0.1:18092";
const VUS = Number(__ENV.VUS || 10);
const DURATION = __ENV.DURATION || "20s";

const mediaFail = new Rate("media_sim_fail");
const mediaDur = new Trend("media_sim_duration", true);
const range206 = new Counter("media_sim_range_206");
const throttle429 = new Counter("media_sim_throttle_429");

export const options = {
  scenarios: {
    mediasim_smoke: {
      executor: "constant-vus",
      vus: VUS,
      duration: DURATION,
      gracefulStop: "5s",
    },
  },
  thresholds: {
    media_sim_fail: ["rate<0.02"],
    http_req_duration: ["p(95)<1000"],
  },
  summaryTrendStats: ["avg", "med", "p(95)", "p(99)", "max"],
};

export default function () {
  const roll = Math.random();
  if (roll < 0.1) {
    const res = http.get(`${BASE}/healthz`, { tags: { plane: "media_sim", name: "healthz" }, timeout: "3s" });
    const ok = res.status === 200;
    mediaFail.add(!ok);
    mediaDur.add(res.timings.duration);
    check(res, { "healthz 200": () => ok });
  } else if (roll < 0.25) {
    const res = http.get(`${BASE}/fault/rate-limit`, {
      tags: { plane: "media_sim", name: "throttle" },
      timeout: "3s",
    });
    const ok = res.status === 429 && (res.headers["Retry-After"] || res.headers["retry-after"]);
    if (ok) throttle429.add(1);
    mediaFail.add(!ok);
    mediaDur.add(res.timings.duration);
    check(res, { "throttle 429": () => ok });
  } else {
    const res = http.get(`${BASE}/media.mp4`, {
      headers: { Range: "bytes=0-1023" },
      tags: { plane: "media_sim", name: "range" },
      timeout: "5s",
    });
    const ok = res.status === 206 || res.status === 200;
    if (res.status === 206) range206.add(1);
    mediaFail.add(!ok);
    mediaDur.add(res.timings.duration);
    check(res, { "range 206/200": () => ok });
  }
  sleep(0.02 + Math.random() * 0.08);
}
