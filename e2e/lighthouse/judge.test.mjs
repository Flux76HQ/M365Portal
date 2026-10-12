// Unit tests of the Lighthouse judge (T-A-330). Run with `node --test` (the e2e package's test:unit).
// The negative fixtures are the point: a judge that cannot fail is worth nothing (baseline section 2).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_MOBILE_LCP_GATE_MS,
  DEFAULT_MOBILE_PERFORMANCE_FLOOR,
  formatReport,
  judge,
  judgeCell,
  needsRepeat,
} from './judge.mjs';

function run(overrides = {}, n = 1) {
  const { scores, ...rest } = overrides;
  return {
    run: n,
    status: 200,
    mimeType: 'text/html',
    finalPath: '/users',
    runtimeError: null,
    scores: { performance: 99, accessibility: 100, bestPractices: 100, ...scores },
    lcpMs: 1400,
    cls: 0,
    fcpMs: 800,
    tbtMs: 80,
    ...rest,
  };
}

function cell(measurements, overrides = {}) {
  return {
    instance: 'preview',
    preset: 'mobile',
    route: '/users',
    measurements,
    ...overrides,
  };
}

test('a clean first run passes', () => {
  const result = judgeCell(cell([run()]));
  assert.equal(result.verdict, 'pass');
  assert.deepEqual(result.reasons, []);
});

test('the gate constants are the recorded reference plus 10 percent', () => {
  assert.equal(DEFAULT_MOBILE_LCP_GATE_MS, 4114);
  assert.ok(Math.abs(DEFAULT_MOBILE_PERFORMANCE_FLOOR - 75.6) < 1e-9);
});

test('the three category scores are judged on the first run, each at 95 or more', () => {
  assert.equal(judgeCell(cell([run({ scores: { performance: 95 } })])).verdict, 'pass');
  for (const key of ['performance', 'accessibility', 'bestPractices']) {
    const result = judgeCell(cell([run({ scores: { [key]: 94 } })]));
    assert.equal(result.verdict, 'fail', key);
    assert.match(result.reasons.join(), /first measurement/, key);
  }
});

test('NEGATIVE: a score below 95 on the first run fails even when the later runs pass', () => {
  const result = judgeCell(
    cell([run({ scores: { performance: 94 }, lcpMs: 1500 }), run({}, 2), run({}, 3)]),
  );
  assert.equal(result.verdict, 'fail');
  assert.match(result.reasons[0], /Performance 94/);
});

test('NEGATIVE: Accessibility and Best Practices misses fail on their own', () => {
  assert.equal(judgeCell(cell([run({ scores: { accessibility: 90 } })])).verdict, 'fail');
  assert.equal(judgeCell(cell([run({ scores: { bestPractices: 90 } })])).verdict, 'fail');
});

test('a timing miss on the first run that a later run meets passes and says so', () => {
  const result = judgeCell(cell([run({ lcpMs: 2300 }), run({ lcpMs: 1500 }, 2)]));
  assert.equal(result.verdict, 'pass-on-retry');
  assert.match(result.notes.join(), /first run missed/);
  assert.equal(result.best.lcpMs, 1500);
});

test('NEGATIVE: a timing miss on all three runs fails, with the best of the three named', () => {
  const result = judgeCell(
    cell([run({ lcpMs: 2300 }), run({ lcpMs: 2100 }, 2), run({ lcpMs: 2600 }, 3)]),
  );
  assert.equal(result.verdict, 'fail');
  assert.match(result.reasons[0], /LCP 2\.10 s/);
  assert.match(result.reasons[0], /best of 3/);
});

test('LCP is strictly below 2.0 s: exactly 2.0 s fails', () => {
  assert.equal(judgeCell(cell([run({ lcpMs: 1999 })])).verdict, 'pass');
  assert.equal(judgeCell(cell([run({ lcpMs: 2000 })])).verdict, 'fail');
});

test('CLS is at most 0.01 on the best of the runs; 0.011 on every run fails', () => {
  assert.equal(judgeCell(cell([run({ cls: 0.01 })])).verdict, 'pass');
  assert.equal(judgeCell(cell([run({ cls: 0.045 }), run({ cls: 0 }, 2)])).verdict, 'pass-on-retry');
  const bad = judgeCell(cell([run({ cls: 0.011 }), run({ cls: 0.02 }, 2), run({ cls: 0.03 }, 3)]));
  assert.equal(bad.verdict, 'fail');
  assert.match(bad.reasons[0], /CLS 0\.011/);
});

test('NEGATIVE: a wrong status is decided on the first measurement and never rescued', () => {
  const result = judgeCell(cell([run({ status: 404 }), run({}, 2), run({}, 3)]));
  assert.equal(result.verdict, 'fail');
  assert.match(result.reasons[0], /HTTP status 404, expected 200/);
  assert.match(result.reasons[0], /first measurement/);
});

test('an expected non-200 status is honoured', () => {
  const result = judgeCell(cell([run({ status: 404 })], { expectedStatus: 404 }));
  assert.equal(result.verdict, 'pass');
});

test('NEGATIVE: a payload that is not HTML, a redirect, a runtime error and a missing metric fail', () => {
  const cases = [
    [{ mimeType: 'application/problem+json' }, /payload is application\/problem\+json/],
    [{ finalPath: '/no-access' }, /ended on \/no-access instead of \/users/],
    [{ runtimeError: 'NO_FCP' }, /runtime error NO_FCP/],
    [{ lcpMs: undefined }, /no LCP/],
    [{ cls: Number.NaN }, /no CLS/],
    [{ scores: { performance: undefined } }, /no performance score/],
  ];
  for (const [overrides, pattern] of cases) {
    const result = judgeCell(cell([run(overrides), run({}, 2)]));
    assert.equal(result.verdict, 'fail', JSON.stringify(overrides));
    assert.match(result.reasons.join(), pattern);
  }
});

test('NEGATIVE: a later run with a wrong status does not count as the cleanest run', () => {
  const result = judgeCell(cell([run({ lcpMs: 2300 }), run({ status: 500, lcpMs: 900 }, 2)]));
  assert.equal(result.verdict, 'fail');
  assert.equal(result.best.lcpMs, 2300);
});

test('NEGATIVE: no measurement fails', () => {
  assert.equal(judgeCell(cell([])).verdict, 'fail');
  assert.equal(judge([]).pass, false);
});

test('the default instance on the mobile preset: the plan 14.3 rule', () => {
  const base = { instance: 'default', preset: 'mobile' };
  // Best 3.74 s, Performance 88: a miss of the target, within the recorded gate (4.11 s).
  const accepted = judgeCell(
    cell([run({ lcpMs: 3760, scores: { performance: 88 } }), run({ lcpMs: 3740 }, 2)], base),
  );
  assert.equal(accepted.verdict, 'accepted-miss');
  assert.match(accepted.notes.join('\n'), /misses the 2\.0 s target/);
  assert.match(accepted.notes.join('\n'), /plan 14\.3/);
  assert.match(accepted.notes.join('\n'), /Performance 88 is below 95/);
  // NEGATIVE: past the gate fails, with the real number.
  const past = judgeCell(cell([run({ lcpMs: 4200 }), run({ lcpMs: 4150 }, 2)], base));
  assert.equal(past.verdict, 'fail');
  assert.match(past.reasons[0], /LCP 4\.15 s >= 4\.11 s/);
  // NEGATIVE: Performance below the floor fails.
  const slow = judgeCell(cell([run({ lcpMs: 3700, scores: { performance: 70 } })], base));
  assert.equal(slow.verdict, 'fail');
  assert.match(slow.reasons[0], /Performance 70 < 75\.6/);
  // NEGATIVE: Accessibility keeps its 95 there.
  const a11y = judgeCell(cell([run({ lcpMs: 3700, scores: { accessibility: 93 } })], base));
  assert.equal(a11y.verdict, 'fail');
});

test('the gate does not leak: desktop of the default instance and the preview instance keep 2.0 s', () => {
  const desktop = judgeCell(
    cell([run({ lcpMs: 3000 })], { instance: 'default', preset: 'desktop' }),
  );
  assert.equal(desktop.verdict, 'fail');
  const preview = judgeCell(
    cell([run({ lcpMs: 3000 })], { instance: 'preview', preset: 'mobile' }),
  );
  assert.equal(preview.verdict, 'fail');
});

test('the default-instance gate is a recorded constant, not the live measurement', () => {
  // Whatever the instance measures, 6 s is past the recorded gate: the rule cannot drift upwards.
  const result = judgeCell(
    cell([run({ lcpMs: 6000 }), run({ lcpMs: 6000 }, 2)], {
      instance: 'default',
      preset: 'mobile',
    }),
  );
  assert.equal(result.verdict, 'fail');
});

test('needsRepeat: only a timing miss is measured again, at most three times', () => {
  assert.equal(needsRepeat(cell([])), true);
  assert.equal(needsRepeat(cell([run()])), false);
  assert.equal(needsRepeat(cell([run({ lcpMs: 2300 })])), true);
  assert.equal(needsRepeat(cell([run({ cls: 0.05 })])), true);
  assert.equal(needsRepeat(cell([run({ lcpMs: 2300 }), run({ lcpMs: 1500 }, 2)])), false);
  assert.equal(needsRepeat(cell([run({ lcpMs: 2300 }), run({ lcpMs: 2300 }, 2)])), true);
  assert.equal(
    needsRepeat(cell([run({ lcpMs: 2300 }), run({ lcpMs: 2300 }, 2), run({ lcpMs: 2300 }, 3)])),
    false,
  );
  // A wrong status or a low score on the first run is final: repeating would only hide it.
  assert.equal(needsRepeat(cell([run({ status: 500, lcpMs: 2300 })])), false);
  assert.equal(needsRepeat(cell([run({ scores: { performance: 90 }, lcpMs: 2300 })])), false);
  // `always` collects the spread.
  assert.equal(needsRepeat(cell([run()]), { always: true }), true);
  assert.equal(needsRepeat(cell([run(), run({}, 2), run({}, 3)]), { always: true }), false);
});

test('judge and formatReport: every measurement is printed, with the spread and the verdict', () => {
  const cells = [
    cell([run({ lcpMs: 2300 }), run({ lcpMs: 1500 }, 2)]),
    cell([run({ status: 404 })], { route: '/audit' }),
  ];
  const verdicts = judge(cells);
  assert.equal(verdicts.pass, false);
  assert.equal(verdicts.failed, 1);
  const text = formatReport(cells, verdicts);
  assert.match(text, /preview \| mobile \| \/users \| 1 \| 99 \| 100 \| 100 \| 2\.30/);
  assert.match(
    text,
    /preview \| mobile \| \/users \| 2 \| 99 \| 100 \| 100 \| 1\.50 .*PASS-ON-RETRY/,
  );
  assert.match(text, /spread over 2 runs: LCP 1\.50 to 2\.30 s \(median 1\.90\)/);
  assert.match(text, /FAIL: HTTP status 404/);
  assert.match(text, /cells: 2 \(pass-on-retry 1, fail 1\); FAIL/);
});

test('a whole pass passes only when every cell passes', () => {
  assert.equal(judge([cell([run()]), cell([run()], { route: '/audit' })]).pass, false);
  const ok = judge([cell([run()]), cell([run({ finalPath: '/audit' })], { route: '/audit' })]);
  assert.equal(ok.pass, true);
});

test('a report-only cell that misses is reported, and does not fail the pass', () => {
  const missing = cell([run({ lcpMs: 5000 }), run({ lcpMs: 5000 }), run({ lcpMs: 5000 })], {
    instance: 'a-owner',
    reportOnly: true,
  });
  const verdicts = judge([missing]);
  assert.equal(verdicts.results[0].verdict, 'reported');
  assert.equal(verdicts.pass, true);
  assert.match(verdicts.results[0].notes.join(' '), /not gated: LCP/);
  const gated = judge([{ ...missing, reportOnly: false }]);
  assert.equal(gated.pass, false);
});
