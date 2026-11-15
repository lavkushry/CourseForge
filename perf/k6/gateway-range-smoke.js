import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Trend, Counter } from "k6/metrics";

/**
 * Media-plane smoke through the live gateway (:18094) with sticky auth leases
 * from the API (:18090). Pulses the lease before each Range (leases expire ~40s
 * without pulse — otherwise long-hold runs surface 409 playback_conflict).
 * Upstream should be mediasim via CF_MEDIA_SIMULATOR_URL (FORCE/DEV only for the
 * proof window). Not Odysee; not a 10k claim.
 *
 * Env:
 *   API_URL      default http://127.0.0.1:18090
 *   MEDIA_URL    default http://127.0.0.1:18094
 *   COURSE_ID, LESSON_ID (required)
 *   LOADTEST_TOKEN — optional X-CourseForge-Loadtest for API rate-limit bypass
 *   VUS (default 5), DURATION (default 30s), ACCOUNTS (default = VUS)
 */
const API = __ENV.API_URL || "http://127.0.0.1:18090";
const MEDIA = __ENV.MEDIA_URL || "http://127.0.0.1:18094";
const COURSE_ID = __ENV.COURSE_ID || "";
const LESSON_ID = __ENV.LESSON_ID || "";
const VUS = Number(__ENV.VUS || 5);
const DURATION = __ENV.DURATION || "30s";
const LOADTEST_TOKEN = __ENV.LOADTEST_TOKEN || "";
const ACCOUNT_COUNT = Number(__ENV.ACCOUNTS || VUS);

const fail = new Rate("gateway_range_fail");
const rangeDur = new Trend("gateway_range_duration", true);
const rangeOK = new Counter("gateway_range_ok");
const bytesRecv = new Counter("gateway_range_bytes");
const opens = new Counter("gateway_lease_opens");
// Status histogram for diagnosing non-2xx under long-hold (403/409/416/0/…).
// Separate counters (not tags) so the text summary always shows buckets.
const rangeStatus206 = new Counter("gateway_range_status_206");
const rangeStatus200 = new Counter("gateway_range_status_200");
const rangeStatus403 = new Counter("gateway_range_status_403");
const rangeStatus409 = new Counter("gateway_range_status_409");
const rangeStatus416 = new Counter("gateway_range_status_416");
const rangeStatus503 = new Counter("gateway_range_status_503");
const rangeStatusOther = new Counter("gateway_range_status_other");
const rangeStatusTimeout = new Counter("gateway_range_status_timeout");
const rangeStatusNetErr = new Counter("gateway_range_status_net_err");

export const options = {
  scenarios: {
    gateway_range: {
      executor: "constant-vus",
      vus: VUS,
      duration: DURATION,
      gracefulStop: "10s",
    },
  },
  thresholds: {
    gateway_range_fail: ["rate<0.05"],
    gateway_range_duration: ["p(95)<2000"],
  },
  summaryTrendStats: ["avg", "med", "p(95)", "p(99)", "max", "count"],
};

let vuSession = null; // { csrf, cookie }
let mediaURL = null; // absolute URL on MEDIA host
let playbackId = null; // sticky lease id — must pulse or lease expires (~40s)
let pulseSeq = 0;

function headers(extra) {
  const h = Object.assign({ Origin: API }, extra || {});
  if (LOADTEST_TOKEN) h["X-CourseForge-Loadtest"] = LOADTEST_TOKEN;
  return h;
}

function extractCookie(res) {
  const jar = http.cookieJar().cookiesForURL(API);
  if (jar && jar.cf_session && jar.cf_session.length) return jar.cf_session[0];
  const raw = res.headers["Set-Cookie"] || res.headers["set-cookie"] || "";
  const m = String(raw).match(/cf_session=([^;]+)/);
  return m ? m[1] : "";
}

function applyCookie(cookie) {
  if (!cookie) return;
  http.cookieJar().set(API, "cf_session", cookie, { domain: "127.0.0.1", path: "/" });
  http.cookieJar().set(MEDIA, "cf_session", cookie, { domain: "127.0.0.1", path: "/" });
}

export function setup() {
  if (!COURSE_ID || !LESSON_ID) {
    throw new Error("COURSE_ID and LESSON_ID required for gateway-range-smoke");
  }
  const accounts = [];
  const n = Math.max(ACCOUNT_COUNT, VUS);
  const batch = Date.now();
  for (let i = 0; i < n; i++) {
    const email = `k6_gw_${batch}_${i}@example.com`;
    const password = "K6GatewayRangePass123!";
    let reg;
    let csrf = "";
    for (let attempt = 0; attempt < 5; attempt++) {
      reg = http.post(
        `${API}/api/v1/auth/register`,
        JSON.stringify({ email, password, name: `gw-${i}` }),
        {
          headers: headers({ "Content-Type": "application/json" }),
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
      sleep(0.3 + attempt * 0.2);
    }
    if (!csrf) {
      throw new Error(`seed register failed status=${reg && reg.status}`);
    }
    const enroll = http.post(
      `${API}/api/v1/courses/${encodeURIComponent(COURSE_ID)}/enroll`,
      "{}",
      {
        headers: headers({
          "Content-Type": "application/json",
          "X-CSRF-Token": csrf,
        }),
        tags: { plane: "api", name: "seed_enroll" },
        timeout: "10s",
      }
    );
    if (enroll.status !== 201 && enroll.status !== 200) {
      throw new Error(`seed enroll ${enroll.status} ${enroll.body}`);
    }
    http.post(`${API}/api/v1/auth/logout`, null, {
      headers: headers({ "X-CSRF-Token": csrf }),
      tags: { plane: "api", name: "seed_logout" },
      timeout: "5s",
    });
    accounts.push({ email, password });
    sleep(0.1);
  }
  return { lessonId: LESSON_ID, accounts };
}

function ensureSession(account) {
  if (vuSession && vuSession.csrf && vuSession.cookie) {
    applyCookie(vuSession.cookie);
    return vuSession;
  }
  if (__ITER === 0) sleep((__VU - 1) * 0.25);
  let login;
  let ok = false;
  let csrf = "";
  let cookie = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    login = http.post(
      `${API}/api/v1/auth/login`,
      JSON.stringify({ email: account.email, password: account.password }),
      {
        headers: headers({ "Content-Type": "application/json" }),
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
      cookie = extractCookie(login);
      ok = ok && csrf !== "" && cookie !== "";
    }
    if (ok) break;
    sleep(0.4 + attempt * 0.3);
  }
  fail.add(!ok);
  check(login, { "login 200": () => ok });
  if (!ok) return null;
  vuSession = { csrf, cookie };
  applyCookie(cookie);
  return vuSession;
}

function ensureLease(session, lessonId) {
  if (mediaURL && playbackId) return mediaURL;
  const open = http.post(
    `${API}/api/v1/playback/sessions`,
    JSON.stringify({ lesson_id: lessonId, take_over: true }),
    {
      headers: headers({
        "Content-Type": "application/json",
        "X-CSRF-Token": session.csrf,
        Cookie: `cf_session=${session.cookie}`,
      }),
      tags: { plane: "api", name: "playback_open" },
      timeout: "10s",
    }
  );
  let path = "";
  let id = "";
  let ok = open.status === 201;
  if (ok) {
    try {
      path = open.json("media_url") || "";
      id = open.json("id") || "";
      ok = path !== "" && id !== "";
    } catch (_) {
      ok = false;
    }
  }
  fail.add(!ok);
  check(open, { "open 201": () => ok });
  if (!ok) {
    if (open.status === 401 || open.status === 403) vuSession = null;
    mediaURL = null;
    playbackId = null;
    return null;
  }
  opens.add(1);
  playbackId = id;
  pulseSeq = 0;
  if (path.startsWith("http")) {
    mediaURL = path;
  } else {
    mediaURL = `${MEDIA}${path}`;
  }
  return mediaURL;
}

// Leases expire ~40s without pulse; long-hold Ranges exceed that window.
function keepLeaseAlive(session) {
  if (!playbackId) return false;
  pulseSeq += 1;
  const pulse = http.post(
    `${API}/api/v1/playback/sessions/${playbackId}/pulse`,
    JSON.stringify({
      sequence: pulseSeq,
      kind: "heartbeat",
      position: pulseSeq * 2,
      elapsed_seconds: 2,
      playback_rate: 1,
      playing: true,
      visible: true,
    }),
    {
      headers: headers({
        "Content-Type": "application/json",
        "X-CSRF-Token": session.csrf,
        Cookie: `cf_session=${session.cookie}`,
      }),
      tags: { plane: "api", name: "playback_pulse" },
      timeout: "10s",
    }
  );
  if (pulse.status === 200) return true;
  if (pulse.status === 403 || pulse.status === 409) {
    mediaURL = null;
    playbackId = null;
    pulseSeq = 0;
  }
  return false;
}

function clearLease() {
  mediaURL = null;
  playbackId = null;
  pulseSeq = 0;
}

export default function (data) {
  const account = data.accounts[(__VU - 1) % data.accounts.length];
  const session = ensureSession(account);
  if (!session) {
    sleep(0.4);
    return;
  }
  const url = ensureLease(session, data.lessonId);
  if (!url) {
    sleep(0.3);
    return;
  }
  // Refresh lease before each Range so long-hold transfers outlive the 40s TTL.
  if (!keepLeaseAlive(session)) {
    sleep(0.2);
    return;
  }

  // Keep Ranges inside the mediasim object (default assumes ≥~8 MiB fixture).
  // Override RANGE_MAX_START / RANGE_CHUNK for smaller fixtures.
  // Large RANGE_CHUNK (+ low SLEEP_MS) raises transfers_in_use under overlap.
  const maxStart = Number(__ENV.RANGE_MAX_START || 6_000_000);
  const chunk = Number(__ENV.RANGE_CHUNK || 65535);
  const timeout = __ENV.RANGE_TIMEOUT || "30s";
  const sleepMs = Number(__ENV.SLEEP_MS || 50);
  const start = Math.floor(Math.random() * Math.max(1, maxStart));
  const end = start + chunk;
  const res = http.get(url, {
    headers: {
      Origin: API,
      Range: `bytes=${start}-${end}`,
      Cookie: `cf_session=${session.cookie}`,
    },
    tags: { plane: "media_gateway", name: "range" },
    timeout,
  });
  rangeDur.add(res.timings.duration);
  const status = res.status;
  const err = res.error || "";
  if (status === 206) rangeStatus206.add(1);
  else if (status === 200) rangeStatus200.add(1);
  else if (status === 403) {
    rangeStatus403.add(1);
    if (__VU <= 2) {
      console.warn(`range 403 body=${String(res.body || "").slice(0, 160)} hdr=${res.headers["X-CourseForge-Media"] || ""}`);
    }
  } else if (status === 409) {
    rangeStatus409.add(1);
    if (__VU <= 2) {
      console.warn(`range 409 body=${String(res.body || "").slice(0, 160)}`);
    }
  } else if (status === 416) rangeStatus416.add(1);
  else if (status === 503) rangeStatus503.add(1);
  else if (status === 0) {
    if (String(err).toLowerCase().indexOf("timeout") >= 0) rangeStatusTimeout.add(1);
    else rangeStatusNetErr.add(1);
  } else {
    rangeStatusOther.add(1);
    // One-line sample for unexpected codes (first few VUs only).
    if (__VU <= 3 && __ITER < 3) {
      console.warn(
        `range unexpected status=${status} err=${err} body=${String(res.body || "").slice(0, 120)}`
      );
    }
  }
  // 416 beyond EOF is a client fixture-size miss, not a gateway plane fault.
  const ok = status === 206 || status === 200;
  if (ok) {
    rangeOK.add(1);
    bytesRecv.add(res.body ? res.body.length : 0);
  } else if (status === 403 || status === 409) {
    // Lease lost — reopen next iteration.
    clearLease();
  } else if (status === 0 || status >= 500) {
    // Drop sticky media URL on hard transport/upstream faults so the next
    // iteration re-opens a lease rather than hammering a dead path.
    clearLease();
  }
  const planeFail = !(ok || status === 416);
  fail.add(planeFail);
  check(res, {
    "range 206/200": () => ok,
    "range not 5xx": () => status > 0 && status < 500,
  });
  if (sleepMs > 0) {
    sleep(sleepMs / 1000 + Math.random() * (sleepMs / 2000));
  }
}
