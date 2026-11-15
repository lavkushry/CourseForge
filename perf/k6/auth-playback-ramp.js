/**
 * Constrained local auth-playback ramp (API plane only).
 * Reuses setup/default from auth-playback-smoke.js (seeded accounts).
 * Not a capacity-doc campaign and not a 10k-learner claim.
 *
 * Stages: 2 → 4 → 5 VUs with short holds. Prefer a 2 vCPU pinned API for
 * constrained-box evidence (see perf/README.md); Cloud Agent host is best-effort.
 *
 * Env: same as auth-playback-smoke.js; set ACCOUNTS>=VUS_MAX (default 5).
 */
export { setup, default } from "./auth-playback-smoke.js";

const VUS_MAX = Number(__ENV.VUS_MAX || 5);

export const options = {
  scenarios: {
    auth_playback_ramp: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "10s", target: 2 },
        { duration: "15s", target: 2 },
        { duration: "10s", target: 4 },
        { duration: "15s", target: 4 },
        { duration: "10s", target: Math.min(VUS_MAX, 5) },
        { duration: "15s", target: Math.min(VUS_MAX, 5) },
        { duration: "10s", target: 0 },
      ],
      gracefulRampDown: "10s",
    },
  },
  thresholds: {
    api_auth_playback_fail: ["rate<0.02"],
    playback_open_duration: ["p(95)<2000"],
    playback_pulse_duration: ["p(95)<1000"],
  },
  summaryTrendStats: ["avg", "med", "p(95)", "p(99)", "max"],
};
