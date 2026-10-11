// The Lighthouse judge (T-A-330, FR-A-154, SC-A-003; baseline section 8 "a latency objective must
// survive its own measurement noise"; PD-27, A-52). Pure: it takes measurements and returns verdicts,
// it starts nothing and reads no file, so `judge.test.mjs` can feed it fixtures that must fail.
//
// What is judged on what:
//   - The FIRST measurement of a cell decides everything that is not noise: a wrong HTTP status, a
//     payload that is not the HTML shell, a redirect, a Lighthouse runtime error, a missing metric,
//     and the three category scores (Performance, Accessibility, Best Practices, each >= 95). A later
//     run never rescues any of these.
//   - Only the TIMING metrics are repeated, and only after the first run missed them: LCP below 2.0 s
//     and CLS at most 0.01 are judged on the cleanest of the (at most three) valid measurements, LCP
//     and CLS each on their own minimum. Every measurement is kept and the spread is reported.
//   - SEO is not gated (the app is `noindex` by design, stack-probe section 5): it is not even read.
//
// The sensitivity this gives up (named in the Phase A report): best-of-3 lets a regression smaller
// than the run-to-run spread of the runner pass, and the first-run score rule makes a rare noisy first
// run (a Performance of 94 where 99 is usual) a real failure. Raising a threshold is the owner's
// decision, never the agent's (PD-27).
//
// The DEFAULT instance (no PREVIEW_MODE) is the one the owner's decision of plan 14.3 / gate note G4
// OP-1 covers: on the mobile preset its largest text on the first screen only exists after the
// JavaScript ran, and the measured best LCP was 3.74 s. For that one combination the gate is the
// recorded reference plus 10 percent, never the live measurement (that would always pass), and a result
// between the target and the gate is `accepted-miss`: it passes the run, it is printed as a miss with
// its real numbers and it names the decision. Everything else keeps the target.

/** The targets of the spec (FR-A-154, plan section 14). */
export const TARGETS = Object.freeze({
  minScore: 95,
  lcpMs: 2000,
  cls: 0.01,
});

/**
 * The recorded reference of the default instance on the mobile preset (gate note G4, section 6 and
 * OP-1): the best LCP of any route measured there (3.74 s on `/`) and the lowest first-run
 * Performance (84 on `/`, run 3). The gate is the reference plus (or minus) 10 percent.
 */
export const DEFAULT_INSTANCE_REFERENCE = Object.freeze({
  lcpMs: 3740,
  performance: 84,
  tolerance: 0.1,
});

/** LCP gate of the default instance, mobile preset: 4,114 ms. */
export const DEFAULT_MOBILE_LCP_GATE_MS = Math.round(
  DEFAULT_INSTANCE_REFERENCE.lcpMs * (1 + DEFAULT_INSTANCE_REFERENCE.tolerance),
);
/** Performance floor of the default instance, mobile preset: 75.6. */
export const DEFAULT_MOBILE_PERFORMANCE_FLOOR =
  DEFAULT_INSTANCE_REFERENCE.performance * (1 - DEFAULT_INSTANCE_REFERENCE.tolerance);

/** Number of measurements per cell at most (one, plus two repeats after a timing miss). */
export const MAX_RUNS = 3;

/**
 * @typedef {object} Measurement
 * @property {number} run                1-based
 * @property {number} status             HTTP status of the document
 * @property {string} mimeType           of the document
 * @property {string} finalPath          path Lighthouse ended on
 * @property {string|null} runtimeError  Lighthouse's own runtime error code, or null
 * @property {{performance:number, accessibility:number, bestPractices:number}} scores  0 to 100
 * @property {number} lcpMs
 * @property {number} cls
 * @property {number} [fcpMs]
 * @property {number} [tbtMs]
 *
 * @typedef {object} Cell
 * @property {'preview'|'default'} instance
 * @property {'mobile'|'desktop'} preset
 * @property {string} route
 * @property {number} [expectedStatus]   default 200
 * @property {Measurement[]} measurements  in run order, all of them
 */

/** Is this the one combination the plan 14.3 decision covers? */
export function usesDefaultInstanceGate(cell) {
  return cell.instance === 'default' && cell.preset === 'mobile';
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Everything that is decided on the first measurement and cannot be repeated away: the answer was the
 * HTML shell for this very path, Lighthouse ran without error, and the metrics exist.
 * @returns {string[]} reasons it is not intact (empty: intact)
 */
export function integrityProblems(cell, measurement) {
  const problems = [];
  const expected = cell.expectedStatus ?? 200;
  if (measurement.status !== expected) {
    problems.push(`HTTP status ${String(measurement.status)}, expected ${String(expected)}`);
  }
  if (!/^text\/html\b/i.test(measurement.mimeType ?? '')) {
    problems.push(`payload is ${measurement.mimeType || 'unknown'}, expected text/html`);
  }
  if (measurement.finalPath !== cell.route) {
    problems.push(`ended on ${String(measurement.finalPath)} instead of ${cell.route}`);
  }
  if (measurement.runtimeError) {
    problems.push(`Lighthouse runtime error ${String(measurement.runtimeError)}`);
  }
  const scores = measurement.scores ?? {};
  for (const key of ['performance', 'accessibility', 'bestPractices']) {
    if (!finite(scores[key])) problems.push(`no ${key} score`);
  }
  if (!finite(measurement.lcpMs)) problems.push('no LCP');
  if (!finite(measurement.cls)) problems.push('no CLS');
  return problems;
}

function lcpLimit(cell) {
  return usesDefaultInstanceGate(cell) ? DEFAULT_MOBILE_LCP_GATE_MS : TARGETS.lcpMs;
}

function performanceFloor(cell) {
  return usesDefaultInstanceGate(cell) ? DEFAULT_MOBILE_PERFORMANCE_FLOOR : TARGETS.minScore;
}

/** The category scores that miss, on one measurement. */
function categoryProblems(cell, measurement) {
  const problems = [];
  const { performance, accessibility, bestPractices } = measurement.scores;
  if (performance < performanceFloor(cell)) {
    problems.push(`Performance ${String(performance)} < ${String(performanceFloor(cell))}`);
  }
  if (accessibility < TARGETS.minScore) {
    problems.push(`Accessibility ${String(accessibility)} < ${String(TARGETS.minScore)}`);
  }
  if (bestPractices < TARGETS.minScore) {
    problems.push(`Best Practices ${String(bestPractices)} < ${String(TARGETS.minScore)}`);
  }
  return problems;
}

/** Does this measurement meet the timing targets (the real ones, not the gate)? */
function meetsTimingTarget(measurement) {
  return measurement.lcpMs < TARGETS.lcpMs && measurement.cls <= TARGETS.cls;
}

/**
 * Should the runner measure this cell again? Only when the measurement taken last was intact, its
 * category scores pass and ONLY the timing missed (baseline section 8), and fewer than MAX_RUNS exist.
 * `always` is for collecting the spread of a whole pass.
 */
export function needsRepeat(cell, { always = false } = {}) {
  const runs = cell.measurements;
  if (runs.length === 0) return true;
  if (runs.length >= MAX_RUNS) return false;
  const first = runs[0];
  if (integrityProblems(cell, first).length > 0 || categoryProblems(cell, first).length > 0) {
    return false;
  }
  if (always) return true;
  return runs.every((m) => !meetsTimingTarget(m));
}

function spreadOf(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return { min: sorted[0], max: sorted[sorted.length - 1], median, n: sorted.length };
}

/**
 * Judges one cell.
 * @param {Cell} cell
 * @returns {{verdict:'pass'|'pass-on-retry'|'accepted-miss'|'fail', reasons:string[], notes:string[],
 *   best:{lcpMs:number, cls:number}|null, spread:object|null}}
 */
export function judgeCell(cell) {
  const runs = cell.measurements ?? [];
  if (runs.length === 0) {
    return { verdict: 'fail', reasons: ['no measurement'], notes: [], best: null, spread: null };
  }
  const first = runs[0];
  const fixed = [...integrityProblems(cell, first).map((p) => `${p} (first measurement)`)];
  if (fixed.length === 0) {
    fixed.push(...categoryProblems(cell, first).map((p) => `${p} (first measurement)`));
  }
  const valid = runs.filter((m) => integrityProblems(cell, m).length === 0);
  const spread =
    valid.length === 0
      ? null
      : {
          lcpMs: spreadOf(valid.map((m) => m.lcpMs)),
          performance: spreadOf(valid.map((m) => m.scores.performance)),
          cls: spreadOf(valid.map((m) => m.cls)),
        };
  if (fixed.length > 0 || valid.length === 0) {
    return {
      verdict: 'fail',
      reasons: fixed.length > 0 ? fixed : ['no valid measurement'],
      notes: [],
      best: null,
      spread,
    };
  }

  const best = {
    lcpMs: Math.min(...valid.map((m) => m.lcpMs)),
    cls: Math.min(...valid.map((m) => m.cls)),
  };
  const notes = [];
  const reasons = [];
  const lcpOk = best.lcpMs < TARGETS.lcpMs;
  const clsOk = best.cls <= TARGETS.cls;
  if (!clsOk) {
    reasons.push(
      `CLS ${best.cls.toFixed(3)} > ${String(TARGETS.cls)} (best of ${String(valid.length)})`,
    );
  }
  let verdict = 'pass';
  if (!lcpOk) {
    const limit = lcpLimit(cell);
    if (best.lcpMs < limit && usesDefaultInstanceGate(cell)) {
      verdict = 'accepted-miss';
      notes.push(
        `LCP ${(best.lcpMs / 1000).toFixed(2)} s misses the ${(TARGETS.lcpMs / 1000).toFixed(1)} s target; ` +
          `accepted under the plan 14.3 rule (gate ${(limit / 1000).toFixed(2)} s = recorded ` +
          `${(DEFAULT_INSTANCE_REFERENCE.lcpMs / 1000).toFixed(2)} s + 10 %, gate note G4 OP-1)`,
      );
    } else {
      reasons.push(
        `LCP ${(best.lcpMs / 1000).toFixed(2)} s >= ${(limit / 1000).toFixed(2)} s (best of ${String(valid.length)})`,
      );
    }
  }
  if (reasons.length > 0) return { verdict: 'fail', reasons, notes, best, spread };

  if (verdict === 'pass' && !meetsTimingTarget(valid[0]) && valid.length > 1) {
    verdict = 'pass-on-retry';
    notes.push(
      `the first run missed the timing target (LCP ${(first.lcpMs / 1000).toFixed(2)} s, CLS ${first.cls.toFixed(3)}); ` +
        `a later run met it (best LCP ${(best.lcpMs / 1000).toFixed(2)} s)`,
    );
  }
  if (usesDefaultInstanceGate(cell) && first.scores.performance < TARGETS.minScore) {
    notes.push(
      `Performance ${String(first.scores.performance)} is below ${String(TARGETS.minScore)}: accepted down to ` +
        `${DEFAULT_MOBILE_PERFORMANCE_FLOOR.toFixed(1)} (recorded ${String(DEFAULT_INSTANCE_REFERENCE.performance)} - 10 %)`,
    );
    if (verdict === 'pass') verdict = 'accepted-miss';
  }
  return { verdict, reasons, notes, best, spread };
}

/**
 * Judges every cell.
 * @param {Cell[]} cells
 */
export function judge(cells) {
  const results = cells.map((cell) => ({
    instance: cell.instance,
    preset: cell.preset,
    route: cell.route,
    runs: cell.measurements.length,
    ...judgeCell(cell),
  }));
  const failed = results.filter((r) => r.verdict === 'fail');
  return {
    pass: results.length > 0 && failed.length === 0,
    failed: failed.length,
    results,
  };
}

const seconds = (ms) => (ms / 1000).toFixed(2);

/** The table of one judged pass, every measurement of every cell on its own line. Plain text. */
export function formatReport(cells, verdicts) {
  const lines = [];
  lines.push(
    [
      'instance',
      'preset',
      'route',
      'run',
      'perf',
      'a11y',
      'bp',
      'LCP s',
      'CLS',
      'TBT ms',
      'status',
    ].join(' | '),
  );
  cells.forEach((cell, index) => {
    const result = verdicts.results[index];
    cell.measurements.forEach((m, i) => {
      const last = i === cell.measurements.length - 1;
      lines.push(
        [
          cell.instance,
          cell.preset,
          cell.route,
          String(m.run),
          String(m.scores.performance),
          String(m.scores.accessibility),
          String(m.scores.bestPractices),
          finite(m.lcpMs) ? seconds(m.lcpMs) : '-',
          finite(m.cls) ? m.cls.toFixed(3) : '-',
          finite(m.tbtMs) ? String(Math.round(m.tbtMs)) : '-',
          last ? result.verdict.toUpperCase() : '',
        ].join(' | '),
      );
    });
    if (result.spread && cell.measurements.length > 1) {
      const s = result.spread;
      lines.push(
        `    spread over ${String(s.lcpMs.n)} runs: LCP ${seconds(s.lcpMs.min)} to ${seconds(s.lcpMs.max)} s ` +
          `(median ${seconds(s.lcpMs.median)}), Performance ${String(s.performance.min)} to ${String(s.performance.max)}`,
      );
    }
    for (const reason of result.reasons) lines.push(`    FAIL: ${reason}`);
    for (const note of result.notes) lines.push(`    NOTE: ${note}`);
  });
  const counts = {};
  for (const r of verdicts.results) counts[r.verdict] = (counts[r.verdict] ?? 0) + 1;
  lines.push(
    `cells: ${String(verdicts.results.length)} (${Object.entries(counts)
      .map(([k, v]) => `${k} ${String(v)}`)
      .join(', ')}); ${verdicts.pass ? 'PASS' : 'FAIL'}`,
  );
  return lines.join('\n');
}
