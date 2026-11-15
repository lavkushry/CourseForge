/**
 * Stepped auth-playback ramp (API plane only) — Cloud-feasible "open-model-ish".
 * Reuses setup/default from auth-playback-smoke.js (seeded accounts).
 *
 * NOT a capacity-doc open-model campaign and NOT a 10k-learner claim.
 * Local evidence only on the shared Cloud Agent host (no durable cgroup pin).
 *
 * Lease: sticky by default (one lease per account/VU; take_over on first open;
 * release only after 409/403 reclaim). Set LEASE_MODE=churn for open+release
 * every iteration. Seed ACCOUNTS >= VUS_MAX (setup refuses to start otherwise).
 *
 * Stages (default): 5 → 10 → 20 → 40 VUs with short holds (~2.5 min total).
 *
 * Env: same as auth-playback-smoke.js
 *   VUS_MAX   peak VUs (default 40)
 *   ACCOUNTS  seeded users (default = VUS_MAX when set; else set explicitly)
 *   LEASE_MODE sticky|churn (default sticky)
 */
import { setup as smokeSetup } from "./auth-playback-smoke.js";
export { default } from "./auth-playback-smoke.js";

const VUS_MAX = Math.max(5, Number(__ENV.VUS_MAX || 40));

export function setup() {
  const data = smokeSetup();
  if (!data.accounts || data.accounts.length < VUS_MAX) {
    throw new Error(
      `openish needs >=${VUS_MAX} seeded accounts (got ${
        data.accounts ? data.accounts.length : 0
      }); set ACCOUNTS=${VUS_MAX} or VUS_MAX=${VUS_MAX}`
    );
  }
  return data;
}

function cap(n) {
  return Math.min(n, VUS_MAX);
}

export const options = {
  scenarios: {
    auth_playback_openish: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "15s", target: cap(5) },
        { duration: "20s", target: cap(5) },
        { duration: "15s", target: cap(10) },
        { duration: "20s", target: cap(10) },
        { duration: "15s", target: cap(20) },
        { duration: "25s", target: cap(20) },
        { duration: "15s", target: cap(40) },
        { duration: "30s", target: cap(40) },
        { duration: "15s", target: 0 },
      ],
      gracefulRampDown: "15s",
    },
  },
  thresholds: {
    // Slightly looser than smoke — stepped saturation is expected; still fail hard errors.
    api_auth_playback_fail: ["rate<0.05"],
    playback_open_duration: ["p(95)<3000"],
    playback_pulse_duration: ["p(95)<2000"],
  },
  summaryTrendStats: ["avg", "med", "p(95)", "p(99)", "max", "count"],
};
