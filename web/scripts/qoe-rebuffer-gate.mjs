/**
 * Fail-closed rebuffer gate over qoe-browser-cohort.mjs evidence.
 *
 * Capacity-doc full gate (GO_TYPESCRIPT_CAPACITY.md):
 *   - ratio = buffering after first frame / (playing + buffering)
 *   - exclude intentional pauses and seeks
 *   - p95 per-session rebuffer ratio < 1%
 *   - five-minute sessions; ≥100 sessions per profile
 *
 * This script runs a **stepped sample** by default (short steady, N≪100) and
 * always reports FULL_GATE vs that contract. Stepped PASS ≠ full capacity-doc PASS.
 *
 *   CHROME=... N=20 QOE_STEADY_MS=4000 QOE_OUT=... node scripts/qoe-rebuffer-gate.mjs
 *
 * Env:
 *   QOE_GATE_MODE=stepped|full     default stepped
 *   QOE_GATE_P95_EXSEEK            stepped default 0.05; full forces 0.01
 *   QOE_GATE_MIN_OK_RATIO          default 1.0 (fail-closed)
 *   QOE_GATE_MIN_N                 default N
 *   QOE_STEADY_MS / QOE_REBUFFER_HOLD_MS / N / CHROME / QOE_OUT — passed through
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cohort = path.join(__dirname, 'qoe-browser-cohort.mjs');

const mode = (process.env.QOE_GATE_MODE || 'stepped').toLowerCase();
const n = Math.max(1, Math.min(100, Number(process.env.N || (mode === 'full' ? 100 : 20))));
const outDir =
  process.env.QOE_OUT ||
  `/home/ubuntu/CourseForge/.ui-evidence/qoe-rebuffer-gate-${mode}-${Date.now()}`;
const steadyMs = Number(
  process.env.QOE_STEADY_MS || (mode === 'full' ? 300000 : 4000),
);
const holdMs = Number(process.env.QOE_REBUFFER_HOLD_MS || 1000);
const minOkRatio = Number(process.env.QOE_GATE_MIN_OK_RATIO || 1);
const minN = Number(process.env.QOE_GATE_MIN_N || n);
const fullP95 = 0.01;
const steppedP95 = Number(process.env.QOE_GATE_P95_EXSEEK || (mode === 'full' ? fullP95 : 0.05));
const gateP95 = mode === 'full' ? fullP95 : steppedP95;

const requiredSelectors = {
  email: '#email',
  password: '#password',
  submit: '#login-form button[type=submit]',
  play: '#featured-course .hero-play',
};

fs.mkdirSync(outDir, { recursive: true });

const delta = {
  capacityDoc: {
    sessions: 100,
    steadyMs: 300000,
    p95ExSeekMax: fullP95,
    excludeSeeks: true,
  },
  thisRun: {
    mode,
    sessions: n,
    steadyMs,
    holdMs,
    p95ExSeekMax: gateP95,
    excludeSeeks: true,
  },
  note:
    mode === 'full'
      ? 'Attempting capacity-doc shaped gate (still mediasim sample unless live provider proven).'
      : `STEPPED sample: N=${n} steady=${steadyMs}ms vs capacity-doc N≥100 steady=300000ms p95<${fullP95}. Stepped PASS does not claim full gate.`,
};

fs.writeFileSync(path.join(outDir, 'gate-contract.json'), JSON.stringify(delta, null, 2));

console.log('qoe-rebuffer-gate', JSON.stringify(delta.thisRun));
console.log('delta_vs_capacity_doc', delta.note);

const env = {
  ...process.env,
  N: String(n),
  QOE_OUT: outDir,
  QOE_STEADY_MS: String(steadyMs),
  QOE_REBUFFER_HOLD_MS: String(holdMs),
};
const run = spawnSync(process.execPath, [cohort], {
  env,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  // Long cohorts: allow up to ~3h wall for full-shaped attempts.
  timeout: mode === 'full' ? 3 * 60 * 60 * 1000 : 45 * 60 * 1000,
});
process.stdout.write(run.stdout || '');
process.stderr.write(run.stderr || '');

const summaryPath = path.join(outDir, 'summary.json');
const failures = [];

if (run.status !== 0 && run.status !== null) {
  failures.push(`cohort_exit_${run.status}`);
}
if (run.error) {
  failures.push(`cohort_spawn_${run.error.code || 'error'}`);
}
if (!fs.existsSync(summaryPath)) {
  failures.push('missing_summary_json');
}

let summary = null;
if (fs.existsSync(summaryPath)) {
  try {
    summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  } catch {
    failures.push('summary_json_parse');
  }
}

if (summary) {
  const sel = summary.selectors || {};
  for (const [k, needle] of Object.entries(requiredSelectors)) {
    const got = String(sel[k] || '');
    if (!got.includes(needle)) {
      failures.push(`selector_mismatch_${k}`);
    }
  }
  if (summary.nRequested !== n) {
    failures.push(`n_requested_${summary.nRequested}_ne_${n}`);
  }
  if (typeof summary.nOk !== 'number') {
    failures.push('missing_nOk');
  } else {
    if (summary.nOk < minN * minOkRatio) {
      failures.push(`ok_ratio_${summary.nOk}/${n}_below_${minOkRatio}`);
    }
    if (summary.nOk < minN) {
      failures.push(`nOk_${summary.nOk}_below_minN_${minN}`);
    }
  }
  const ratioEx = summary.rebuffer?.ratioExSeek;
  if (!ratioEx || typeof ratioEx.p95 !== 'number' || Number.isNaN(ratioEx.p95)) {
    failures.push('missing_ratioExSeek_p95');
  } else if (ratioEx.p95 > gateP95) {
    failures.push(`ratioExSeek_p95_${ratioEx.p95}_gt_gate_${gateP95}`);
  }
  // Every ok result must carry ex-seek fields (fail-closed on partial hooks).
  for (const r of summary.results || []) {
    if (!r.ok) continue;
    const rb = r.rebuffer || {};
    if (typeof rb.rebufferRatioExSeek !== 'number') {
      failures.push(`run_${r.run}_missing_rebufferRatioExSeek`);
    }
    if (typeof rb.waitingMsExSeek !== 'number' || typeof rb.playingMsExSeek !== 'number') {
      failures.push(`run_${r.run}_missing_exSeek_clocks`);
    }
  }
}

const ratioP95 = summary?.rebuffer?.ratioExSeek?.p95;
const fullGatePass =
  summary &&
  typeof ratioP95 === 'number' &&
  summary.nOk >= 100 &&
  steadyMs >= 300000 &&
  ratioP95 <= fullP95 &&
  failures.length === 0;

const verdict = {
  mode,
  steppedGate: {
    threshold: gateP95,
    pass: failures.length === 0 && mode === 'stepped',
  },
  fullCapacityDocGate: {
    threshold: fullP95,
    requiredN: 100,
    requiredSteadyMs: 300000,
    pass: !!fullGatePass,
    reason: fullGatePass
      ? 'met'
      : `need N≥100 + steady≥300000ms + p95≤${fullP95}; observed nOk=${summary?.nOk ?? 0} steadyMs=${steadyMs} p95=${ratioP95 ?? 'null'}`,
  },
  failures,
  summaryPath,
  delta: delta.note,
  plane: 'browser_qoe_mediasim_sample',
  notAClaim: 'not_10k_not_odysee_cdn_not_open_model',
};

fs.writeFileSync(path.join(outDir, 'gate-verdict.json'), JSON.stringify(verdict, null, 2));
console.log('GATE_VERDICT', JSON.stringify(verdict));

if (failures.length) {
  console.error('GATE_FAIL', failures.join(','));
  process.exit(1);
}
if (mode === 'full' && !fullGatePass) {
  console.error('GATE_FAIL full_capacity_doc_not_met');
  process.exit(1);
}
console.log(
  mode === 'stepped'
    ? 'GATE_PASS stepped_sample (FULL_GATE still open — see gate-verdict.json)'
    : 'GATE_PASS full_capacity_doc_shaped',
);
process.exit(0);
