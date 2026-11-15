import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Trend, Counter } from "k6/metrics";

/**
 * Authenticated API-plane smoke using seeded synthetic accounts (capacity-doc style).
 * setup() registers + enrolls accounts sequentially (avoids password_busy storms);
 * each VU logs in once (staggered), then re-applies the session cookie every
 * iteration (k6's jar does not reliably keep cookies across iterations here).
 *
 * Lease model (default sticky): one playback lease per account/VU. Open once
 * (take_over), pulse across iterations, release only when reclaiming after
 * 409/403 or in LEASE_MODE=churn. Avoids multi-open-per-account storms that
 * displace in-flight pulses under ramping VUs.
 *
 * Plane: API only. Not a 10k-learner claim.
 *
 * Env:
 *   BASE_URL, COURSE_ID, LESSON_ID (required)
 *   VUS (default 5), DURATION (default 20s), VUS_MAX (openish peak; seeds accounts)
 *   LOADTEST_TOKEN — X-CourseForge-Loadtest when CF_LOADTEST_BYPASS_TOKEN is set
 *   ACCOUNTS — seeded users (default = max(VUS, VUS_MAX))
 *   LEASE_MODE — sticky (default) | churn (open+release every iteration)
 *
 * Requires CF_REGISTRATION_MODE=open.
 */
const BASE = __ENV.BASE_URL || "http://127.0.0.1:18090";
const COURSE_ID = __ENV.COURSE_ID || "";
const LESSON_ID = __ENV.LESSON_ID || "";
const VUS = Number(__ENV.VUS || 5);
const VUS_MAX = Number(__ENV.VUS_MAX || 0);
const DURATION = __ENV.DURATION || "20s";
const LOADTEST_TOKEN = __ENV.LOADTEST_TOKEN || "";
const ACCOUNT_COUNT = Number(
  __ENV.ACCOUNTS || Math.max(VUS, VUS_MAX > 0 ? VUS_MAX : 0, 1)
);
const LEASE_MODE = (__ENV.LEASE_MODE || "sticky").toLowerCase();

function commonHeaders(extra) {
  const h = Object.assign({ Origin: BASE }, extra || {});
  if (LOADTEST_TOKEN) {
    h["X-CourseForge-Loadtest"] = LOADTEST_TOKEN;
  }
  return h;
}

const apiFail = new Rate("api_auth_playback_fail");
const openDur = new Trend("playback_open_duration", true);
const pulseDur = new Trend("playback_pulse_duration", true);
const opens = new Counter("playback_opens");
const pulses = new Counter("playback_pulses");
const logins = new Counter("playback_logins");
const openStatus = new Counter("playback_open_status");
const pulseStatus = new Counter("playback_pulse_status");
const releaseStatus = new Counter("playback_release_status");

export const options = {
  scenarios: {
    auth_playback_smoke: {
      executor: "constant-vus",
      vus: VUS,
      duration: DURATION,
      gracefulStop: "10s",
    },
  },
  thresholds: {
    api_auth_playback_fail: ["rate<0.01"],
    playback_open_duration: ["p(95)<2000"],
    playback_pulse_duration: ["p(95)<1000"],
  },
  summaryTrendStats: ["avg", "med", "p(95)", "p(99)", "max"],
};

// Per-VU session (module state is per-VU in k6). Cookie must be re-applied each
// iteration — observed jar reset between iterations on this k6 build.
let vuSession = null; // { csrf, cookie }
let vuPlaybackId = null;
let vuPulseSeq = 0;

export function setup() {
  if (!COURSE_ID || !LESSON_ID) {
    throw new Error("COURSE_ID and LESSON_ID are required for auth-playback-smoke");
  }
  const opts = http.get(`${BASE}/api/v1/public/account-options`, {
    headers: commonHeaders(),
  });
  const body = opts.json();
  if (!body || body.registration_mode !== "open" || !body.registration_enabled) {
    throw new Error(
      `registration must be open for this smoke (got ${JSON.stringify(body)})`
    );
  }

  const accounts = [];
  // Resolve at setup-time so openish can pass VUS_MAX/ACCOUNTS without relying
  // solely on module-init defaults from the smoke entrypoint.
  const n = Math.max(
    ACCOUNT_COUNT,
    VUS,
    VUS_MAX,
    Number(__ENV.ACCOUNTS || 0),
    Number(__ENV.VUS || 0),
    Number(__ENV.VUS_MAX || 0),
    1
  );
  const batch = Date.now();
  for (let i = 0; i < n; i++) {
    const email = `k6_seed_${batch}_${i}@example.com`;
    const password = "K6PlaybackPass123!";
    let reg;
    let csrf = "";
    for (let attempt = 0; attempt < 5; attempt++) {
      reg = http.post(
        `${BASE}/api/v1/auth/register`,
        JSON.stringify({ email, password, name: `k6-seed-${i}` }),
        {
          headers: commonHeaders({ "Content-Type": "application/json" }),
          tags: { plane: "api", name: "seed_register" },
          timeout: "15s",
        }
      );
      if (reg.status === 201 || reg.status === 200) {
        try {
          csrf = reg.json("csrf_token") || "";
        } catch (_) {
          csrf = "";
        }
        if (csrf) break;
      }
      sleep(0.4 + attempt * 0.3);
    }
    if (!csrf) {
      throw new Error(`seed register failed for ${email}: status=${reg && reg.status}`);
    }
    const enroll = http.post(
      `${BASE}/api/v1/courses/${encodeURIComponent(COURSE_ID)}/enroll`,
      "{}",
      {
        headers: commonHeaders({
          "Content-Type": "application/json",
          "X-CSRF-Token": csrf,
        }),
        tags: { plane: "api", name: "seed_enroll" },
        timeout: "10s",
      }
    );
    if (enroll.status !== 201 && enroll.status !== 200) {
      throw new Error(`seed enroll failed: ${enroll.status} ${enroll.body}`);
    }
    http.post(`${BASE}/api/v1/auth/logout`, null, {
      headers: commonHeaders({ "X-CSRF-Token": csrf }),
      tags: { plane: "api", name: "seed_logout" },
      timeout: "5s",
    });
    accounts.push({ email, password });
    sleep(0.15);
  }
  return { courseId: COURSE_ID, lessonId: LESSON_ID, accounts };
}

function extractSessionCookie(res) {
  // Prefer jar, then Set-Cookie header.
  const jar = http.cookieJar().cookiesForURL(BASE);
  if (jar && jar.cf_session && jar.cf_session.length) {
    return jar.cf_session[0];
  }
  const raw = res.headers["Set-Cookie"] || res.headers["set-cookie"] || "";
  const m = String(raw).match(/cf_session=([^;]+)/);
  return m ? m[1] : "";
}

function applySession(session) {
  if (!session || !session.cookie) return;
  http.cookieJar().set(BASE, "cf_session", session.cookie, {
    domain: "127.0.0.1",
    path: "/",
  });
}

function ensureSession(account) {
  if (vuSession && vuSession.csrf && vuSession.cookie) {
    applySession(vuSession);
    return vuSession;
  }
  // Stagger first login so PasswordConcurrency=2 is not stampeded at t=0.
  if (__ITER === 0) {
    sleep((__VU - 1) * 0.35);
  }
  let login;
  let ok = false;
  let csrf = "";
  let cookie = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    login = http.post(
      `${BASE}/api/v1/auth/login`,
      JSON.stringify({ email: account.email, password: account.password }),
      {
        headers: commonHeaders({ "Content-Type": "application/json" }),
        tags: { plane: "api", name: "login" },
        timeout: "15s",
      }
    );
    ok = login.status === 200;
    if (ok) {
      try {
        csrf = login.json("csrf_token") || "";
      } catch (_) {
        ok = false;
      }
      cookie = extractSessionCookie(login);
      ok = ok && csrf !== "" && cookie !== "";
    }
    if (ok) break;
    sleep(0.5 + attempt * 0.4);
  }
  apiFail.add(!ok);
  check(login, { "login 200": () => ok });
  if (!ok) {
    return null;
  }
  logins.add(1);
  vuSession = { csrf, cookie };
  applySession(vuSession);
  return vuSession;
}

function authHeadersFor(session) {
  return commonHeaders({
    "Content-Type": "application/json",
    "X-CSRF-Token": session.csrf,
    Cookie: `cf_session=${session.cookie}`,
  });
}

function openPlayback(session, lessonId) {
  let open;
  let openOK = false;
  let sessionId = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    open = http.post(
      `${BASE}/api/v1/playback/sessions`,
      JSON.stringify({ lesson_id: lessonId, take_over: true }),
      {
        headers: authHeadersFor(session),
        tags: { plane: "api", name: "playback_open" },
        timeout: "10s",
      }
    );
    openDur.add(open.timings.duration);
    openStatus.add(1, { status: String(open.status) });
    openOK = open.status === 201;
    if (openOK) {
      try {
        sessionId = open.json("id") || "";
        openOK = sessionId !== "";
      } catch (_) {
        openOK = false;
      }
    }
    if (open.status === 401 || open.status === 403) {
      vuSession = null;
      break;
    }
    if (open.status === 429 || open.status === 503) {
      const ra = Number(open.headers["Retry-After"] || open.headers["retry-after"] || 1);
      sleep(Math.max(0.2, ra) + attempt * 0.25);
      continue;
    }
    break;
  }
  apiFail.add(!openOK);
  check(open, { "open 201": () => openOK });
  if (openOK) {
    opens.add(1);
    vuPlaybackId = sessionId;
    vuPulseSeq = 0;
  }
  return openOK ? sessionId : "";
}

function releasePlayback(session, sessionId) {
  if (!sessionId) return true;
  let release;
  let releaseOK = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    release = http.post(
      `${BASE}/api/v1/playback/sessions/${sessionId}/release`,
      JSON.stringify({}),
      {
        headers: authHeadersFor(session),
        tags: { plane: "api", name: "playback_release" },
        timeout: "10s",
      }
    );
    releaseStatus.add(1, { status: String(release.status) });
    releaseOK = release.status === 200;
    if (releaseOK || (release.status !== 429 && release.status !== 503)) break;
    sleep(0.2 + attempt * 0.2);
  }
  apiFail.add(!releaseOK);
  check(release, { "release 200": () => releaseOK });
  if (vuPlaybackId === sessionId) {
    vuPlaybackId = null;
    vuPulseSeq = 0;
  }
  return releaseOK;
}

function pulsePlayback(session, sessionId, count) {
  const authHeaders = authHeadersFor(session);
  let allOK = true;
  let lostLease = false;
  for (let i = 0; i < count; i++) {
    vuPulseSeq += 1;
    const seq = vuPulseSeq;
    let pulse;
    let pulseOK = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      pulse = http.post(
        `${BASE}/api/v1/playback/sessions/${sessionId}/pulse`,
        JSON.stringify({
          sequence: seq,
          kind: "heartbeat",
          position: seq * 2,
          elapsed_seconds: 2,
          playback_rate: 1,
          playing: true,
          visible: true,
        }),
        {
          headers: authHeaders,
          tags: { plane: "api", name: "playback_pulse" },
          timeout: "10s",
        }
      );
      pulseDur.add(pulse.timings.duration);
      pulseStatus.add(1, { status: String(pulse.status) });
      pulseOK = pulse.status === 200;
      if (pulse.status === 409 || pulse.status === 403) {
        lostLease = true;
        break;
      }
      if (pulseOK || (pulse.status !== 429 && pulse.status !== 503)) break;
      sleep(0.2 + attempt * 0.2);
    }
    apiFail.add(!pulseOK);
    check(pulse, { "pulse 200": () => pulseOK });
    if (pulseOK) pulses.add(1);
    else allOK = false;
    if (lostLease) {
      vuPlaybackId = null;
      vuPulseSeq = 0;
      break;
    }
    sleep(0.05);
  }
  return allOK && !lostLease;
}

export default function (data) {
  const account = data.accounts[(__VU - 1) % data.accounts.length];
  const session = ensureSession(account);
  if (!session) {
    sleep(0.5);
    return;
  }

  const churn = LEASE_MODE === "churn";
  let sessionId = churn ? "" : vuPlaybackId;

  if (!sessionId) {
    // Deliberate take_over so a stale account lease cannot block the VU.
    sessionId = openPlayback(session, data.lessonId);
    if (!sessionId) {
      sleep(0.25);
      return;
    }
  }

  pulsePlayback(session, sessionId, 3);

  if (churn) {
    // Release before the next open so the account holds one lease at a time.
    releasePlayback(session, sessionId);
  }

  sleep(0.08 + Math.random() * 0.12);
}
