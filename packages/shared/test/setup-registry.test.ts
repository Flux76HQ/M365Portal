// T-B-120, FR-B-210 (registry half), FR-B-211, FR-B-212 (constants), FR-B-214 (link rule),
// FR-B-217 (codes), TB-13, CB13: the setup registries. Four modules are held to the documents:
//   - `setup/steps.ts`            the five steps and their sub-actions (spec 6.2.1), `aggregate`
//                                  (plan 9.4), the closed detail list, hint keys, the link rule;
//   - `setup/result-codes.ts`     the wizard result codes (spec 6.9.5 and contract 6.2);
//   - `setup/log-keys.ts`         the live-log keys (plan Appendix A);
//   - `setup/backoff-constants.ts` the retry constants (spec 6.9.2, plan 9.7), read from `LIMITS`.
// The documents are read, so a document that changes without the registry fails (and conversely).
// Every guard has a negative fixture run through `expectGuardFails` (tasks.md section 0.3).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LIMITS } from '../src/limits.js';
import {
  FAILURE_CLASSES,
  SETUP_MIN_WAIT_MS,
  SETUP_OBJECT_CHAIN_WINDOW_SECONDS,
  SETUP_PROPAGATION_TIMEOUT_SECONDS,
  SETUP_REPLICATION_BACKOFF,
  SETUP_TRANSIENT_BACKOFF,
  SETUP_TRANSIENT_MAX_TRIES,
  scheduleOf,
} from '../src/setup/backoff-constants.js';
import {
  LOG_KEYS,
  LOG_KEY_LIST,
  LOG_PARAM_NAMES,
  SERVER_LOG_EVENTS,
  isLogKey,
} from '../src/setup/log-keys.js';
import {
  ENVIRONMENT_CHECK_KEYS,
  RESULT_CODES,
  SETUP_RESULT_CODES,
  isResultCode,
  resultCodesOf,
  resultMessageKey,
  resultRemedyKey,
} from '../src/setup/result-codes.js';
import {
  EXCHANGE_SUB_ACTIONS,
  ROLLBACK_HINT_KEYS,
  SETUP_MODES,
  SETUP_STATES,
  SETUP_STEP_DETAIL,
  STEPS,
  STEP_KEYS,
  STEP_STATUSES,
  SUB_ACTION_KEYS,
  SECRET_KEY_PATTERN,
  VERIFICATION_URI_HOSTS,
  aggregate,
  isAllowedVerificationUri,
  isSecretLookingKey,
  stepMessageKey,
  stepOfSubAction,
  subActionMessageKey,
  subActionsOf,
  type StepStatus,
  type SubActionStatus,
} from '../src/setup/steps.js';
import { expectGuardFails } from '../src/testing/index.js';

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8');
const SPEC = read('../../../specs/002-phase-b/spec.md');
const PLAN = read('../../../specs/002-phase-b/plan.md');
const CONTRACT = read('../../../specs/002-phase-b/contracts/phase-b-api.md');

/** The text between a start marker (inclusive) and the next marker that matches `end`. */
function sectionOf(document: string, start: string | RegExp, end: RegExp): string {
  const from = typeof start === 'string' ? document.indexOf(start) : document.search(start);
  if (from < 0) throw new Error(`section start not found: ${String(start)}`);
  const rest = document.slice(from);
  const afterFirstLine = rest.indexOf('\n') + 1;
  const stop = rest.slice(afterFirstLine).search(end);
  return stop < 0 ? rest : rest.slice(0, afterFirstLine + stop);
}

const backticked = (text: string): string[] =>
  [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? '');

// ---------------------------------------------------------------------------------------------
// Steps and sub-actions (spec 6.2.1)
// ---------------------------------------------------------------------------------------------

/** Rows of the table of spec 6.2.1: step key and the sub-action keys of its third column. */
function specStepRows(): [string, string[]][] {
  const table = sectionOf(SPEC, '#### 6.2.1', /^#{2,4} /m);
  return [...table.matchAll(/^\| (\d) \| `([a-z_]+)` \| ([^|]+) \|/gm)].map((m) => [
    m[2] ?? '',
    backticked(m[3] ?? ''),
  ]);
}

describe('STEPS', () => {
  it('lists the five steps of spec 6.2.1 in order, with their sub-action keys', () => {
    const rows = specStepRows();
    expect(rows.map(([key]) => key)).toEqual([...STEP_KEYS]);
    expect(STEP_KEYS).toEqual(['environment', 'connect', 'configure', 'verify', 'finish']);
    for (const [key, subActions] of rows) {
      expect(STEPS[key as keyof typeof STEPS].subActions, key).toEqual(subActions);
    }
  });

  it('has the counts of the task: six checks, two alternatives, seven, five, five', () => {
    expect(STEPS.environment.subActions).toHaveLength(6);
    expect(STEPS.connect.subActions).toEqual(['device_code', 'manual_inputs']);
    expect(STEPS.configure.subActions).toHaveLength(7);
    expect(STEPS.verify.subActions).toHaveLength(5);
    expect(STEPS.finish.subActions).toHaveLength(5);
    expect(STEP_KEYS.map((key) => STEPS[key].order)).toEqual([1, 2, 3, 4, 5]);
    expect(STEP_KEYS.every((key) => STEPS[key].key === key)).toBe(true);
  });

  it('keeps sub-action keys unique across steps, so a key names its step', () => {
    expect(new Set(SUB_ACTION_KEYS).size).toBe(SUB_ACTION_KEYS.length);
    expect(SUB_ACTION_KEYS).toHaveLength(6 + 2 + 7 + 5 + 5);
    for (const key of STEP_KEYS) {
      for (const sub of STEPS[key].subActions) expect(stepOfSubAction(sub)).toBe(key);
    }
    expect(stepOfSubAction('nope')).toBeUndefined();
  });

  it('connect has one sub-action per mode; the other steps keep all of theirs', () => {
    expect(subActionsOf('connect', 'automatic')).toEqual(['device_code']);
    expect(subActionsOf('connect', 'manual')).toEqual(['manual_inputs']);
    for (const mode of SETUP_MODES) {
      expect(subActionsOf('configure', mode)).toEqual(STEPS.configure.subActions);
    }
  });

  it('names the six environment checks of the result-code registry the same way', () => {
    expect([...ENVIRONMENT_CHECK_KEYS]).toEqual([...STEPS.environment.subActions]);
  });

  it('names the two Exchange sub-actions of EB-08, both inside configure', () => {
    expect(EXCHANGE_SUB_ACTIONS).toEqual(['exchange_permissions', 'exchange_role']);
    for (const sub of EXCHANGE_SUB_ACTIONS) expect(stepOfSubAction(sub)).toBe('configure');
  });

  it('is frozen all the way down', () => {
    expect(Object.isFrozen(STEPS)).toBe(true);
    for (const key of STEP_KEYS) {
      expect(Object.isFrozen(STEPS[key])).toBe(true);
      expect(Object.isFrozen(STEPS[key].subActions)).toBe(true);
    }
    expect(Object.isFrozen(STEP_KEYS)).toBe(true);
    expect(Object.isFrozen(SETUP_STEP_DETAIL)).toBe(true);
  });

  it('keeps statuses and states as the contract writes them', () => {
    expect([...STEP_STATUSES]).toEqual([
      'pending',
      'running',
      'waiting',
      'succeeded',
      'warning',
      'failed',
      'skipped',
    ]);
    expect([...SETUP_STATES]).toEqual([
      'unconfigured',
      'in_progress',
      'awaiting_first_signin',
      'completed',
    ]);
    expect(CONTRACT).toContain(
      "SetupState   = 'unconfigured' | 'in_progress' | 'awaiting_first_signin' | 'completed'",
    );
    expect(CONTRACT).toContain(
      "StepStatus   = 'pending' | 'running' | 'waiting' | 'succeeded' | 'warning' | 'failed' | 'skipped'",
    );
  });

  it('derives catalogue keys from the registry, one per step and sub-action', () => {
    expect(stepMessageKey('configure')).toBe('setup.step.configure');
    expect(subActionMessageKey('graph_permissions')).toBe('setup.sub.graph_permissions');
  });
});

// ---------------------------------------------------------------------------------------------
// aggregate (plan 9.4)
// ---------------------------------------------------------------------------------------------

describe('aggregate', () => {
  type Item = StepStatus | SubActionStatus;
  const cases: [string, Item[], StepStatus][] = [
    ['no sub-actions: not started', [], 'pending'],
    ['all succeeded', ['succeeded', 'succeeded'], 'succeeded'],
    ['a skipped sub-action counts as done', ['succeeded', 'skipped'], 'succeeded'],
    ['all skipped (manual mode configure)', ['skipped', 'skipped', 'skipped'], 'succeeded'],
    ['any failed wins over everything', ['failed', 'running', 'pending', 'warning'], 'failed'],
    ['failed with succeeded', ['succeeded', 'failed'], 'failed'],
    ['running beats pending and warning', ['running', 'pending', 'warning'], 'running'],
    ['waiting is running at step level', ['succeeded', 'waiting'], 'running'],
    ['waiting beats pending', ['waiting', 'pending'], 'running'],
    ['pending beats warning', ['pending', 'warning', 'succeeded'], 'pending'],
    ['succeeded with pending', ['succeeded', 'pending'], 'pending'],
    ['any warning', ['succeeded', 'warning'], 'warning'],
    [
      'a skipped flagged as a warning (the two Exchange sub-actions, EB-08)',
      ['succeeded', { status: 'skipped', warning: true }, { status: 'skipped', warning: true }],
      'warning',
    ],
    [
      'a skipped flagged false stays succeeded',
      [{ status: 'skipped', warning: false }],
      'succeeded',
    ],
    ['objects and bare statuses mix', ['succeeded', { status: 'failed' }], 'failed'],
  ];

  it.each(cases)('%s', (_name, input, expected) => {
    expect(aggregate(input)).toBe(expected);
  });

  it('covers every pair of statuses with the precedence failed, running, pending, warning, succeeded', () => {
    const rank = (s: StepStatus): number => {
      if (s === 'failed') return 4;
      if (s === 'running' || s === 'waiting') return 3;
      if (s === 'pending') return 2;
      if (s === 'warning') return 1;
      return 0;
    };
    const names = ['succeeded', 'pending', 'running', 'warning', 'failed'] as const;
    for (const a of STEP_STATUSES) {
      for (const b of STEP_STATUSES) {
        const winner = rank(a) >= rank(b) ? a : b;
        const expected: StepStatus =
          rank(winner) === 4
            ? 'failed'
            : rank(winner) === 3
              ? 'running'
              : rank(winner) === 2
                ? 'pending'
                : rank(winner) === 1
                  ? 'warning'
                  : 'succeeded';
        expect(aggregate([a, b]), `${a} + ${b}`).toBe(expected);
      }
    }
    expect(names).toHaveLength(5);
  });

  it('never returns waiting, skipped or a status outside the registry', () => {
    for (const a of STEP_STATUSES) {
      for (const b of STEP_STATUSES) {
        const out = aggregate([a, b]);
        expect(['pending', 'running', 'succeeded', 'warning', 'failed']).toContain(out);
      }
    }
  });

  it('negative: an aggregate that lets pending win over failed fails the table', () => {
    const wrong = (subs: readonly Item[]): StepStatus =>
      subs.some((s) => (typeof s === 'string' ? s : s.status) === 'pending')
        ? 'pending'
        : aggregate(subs);
    expectGuardFails(
      () => {
        for (const [name, input, expected] of cases) {
          if (wrong(input) !== expected) throw new Error(`aggregate table: ${name}`);
        }
      },
      undefined,
      { name: 'aggregate precedence', reason: 'aggregate table' },
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Detail keys, hints, the link rule
// ---------------------------------------------------------------------------------------------

describe('SETUP_STEP_DETAIL (closed key list, FR-B-210)', () => {
  it('holds no name that looks like a secret', () => {
    for (const name of SETUP_STEP_DETAIL) {
      expect(isSecretLookingKey(name), name).toBe(false);
    }
  });

  it('has no duplicates and uses plain camel-case names', () => {
    expect(new Set(SETUP_STEP_DETAIL).size).toBe(SETUP_STEP_DETAIL.length);
    for (const name of SETUP_STEP_DETAIL) expect(name).toMatch(/^[a-z][A-Za-z0-9]*$/);
    expect(SETUP_STEP_DETAIL).toContain('manual');
    expect(SETUP_STEP_DETAIL).toContain('nextAttemptAt');
  });

  it('SECRET_KEY_PATTERN matches the seven words of FR-B-210 in any case, as a part of a name', () => {
    for (const word of ['secret', 'token', 'key', 'password', 'assertion', 'pem', 'credential']) {
      expect(isSecretLookingKey(word), word).toBe(true);
      expect(isSecretLookingKey(word.toUpperCase()), word).toBe(true);
      expect(isSecretLookingKey(`my_${word}_value`), word).toBe(true);
    }
    expect(isSecretLookingKey('clientSecret')).toBe(true);
    expect(isSecretLookingKey('accessToken')).toBe(true);
    expect(isSecretLookingKey('thumbprint8')).toBe(false);
    expect(SECRET_KEY_PATTERN.flags).toContain('i');
  });

  it('negative: a detail list that smuggles a secret-looking name fails the guard', () => {
    const guard = (names: readonly string[]): void => {
      for (const name of names)
        if (isSecretLookingKey(name)) throw new Error(`secret key: ${name}`);
    };
    guard(SETUP_STEP_DETAIL);
    expectGuardFails(guard, [...SETUP_STEP_DETAIL, 'accessToken'], { reason: 'accessToken' });
  });
});

describe('ROLLBACK_HINT_KEYS (plan 9.13)', () => {
  it('lists the six hint keys of the plan and the tasks', () => {
    expect([...ROLLBACK_HINT_KEYS]).toEqual([
      'setup.hint.application',
      'setup.hint.service_principal',
      'setup.hint.certificate',
      'setup.hint.grants',
      'setup.hint.exchange_role',
      'setup.hint.bootstrap_consent',
    ]);
    const section = sectionOf(PLAN, '### 9.13 Rollback hints', /^#{2,3} /m);
    expect(
      backticked(section)
        .filter((k) => k.startsWith('setup.hint.'))
        .sort(),
    ).toEqual([...ROLLBACK_HINT_KEYS].sort());
  });
});

describe('isAllowedVerificationUri (FR-B-214, U43)', () => {
  it('accepts https links on the four allow-listed hosts', () => {
    expect([...VERIFICATION_URI_HOSTS]).toEqual([
      'microsoft.com',
      'www.microsoft.com',
      'login.microsoft.com',
      'login.microsoftonline.com',
    ]);
    for (const uri of [
      'https://login.microsoft.com/device',
      'https://microsoft.com/devicelogin',
      'https://www.microsoft.com/link',
      'https://login.microsoftonline.com/common/oauth2/deviceauth',
      'https://LOGIN.MICROSOFT.COM/device',
      'https://login.microsoft.com:443/device',
    ]) {
      expect(isAllowedVerificationUri(uri), uri).toBe(true);
    }
  });

  it('refuses every other scheme, host, port, credential and look-alike', () => {
    for (const uri of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html,x',
      'http://login.microsoft.com/device',
      'ftp://login.microsoft.com/device',
      '//login.microsoft.com/device',
      'login.microsoft.com/device',
      'https://user@login.microsoft.com/device',
      'https://user:pw@login.microsoft.com/device',
      'https://login.microsoft.com@evil.test/device',
      'https://login.microsoft.com.evil.test/device',
      'https://evil.test/login.microsoft.com',
      'https://evil-login.microsoft.com/device',
      'https://sub.login.microsoft.com/device',
      'https://xlogin.microsoft.com/device',
      'https://login.microsoft.com.:443/device',
      'https://login.microsoft.com./device',
      'https://login.microsoft.com:8443/device',
      'https://login.microsoft.com%2eevil.test/device',
      'https://login.microsoft.com\\@evil.test/device',
      'https://ｌogin.microsoft.com/device',
      'https://login.microsoft.com/dev ice',
      'https://login.microsoft.com/\ndevice',
      'https://login.microsoft.com/\tdevice',
      'https://microsoft.com.evil.test',
      'https://notmicrosoft.com/device',
      'https://login.microsoftonline.com.evil.test/device',
      '',
      ' ',
      `https://login.microsoft.com/${'a'.repeat(3000)}`,
    ]) {
      expect(isAllowedVerificationUri(uri), JSON.stringify(uri)).toBe(false);
    }
  });

  it('refuses a value that is not a string', () => {
    for (const value of [undefined, null, 1, {}, [], new URL('https://login.microsoft.com/')]) {
      expect(isAllowedVerificationUri(value)).toBe(false);
    }
  });

  it('negative: a check that only tests the host suffix lets a look-alike through', () => {
    const suffixOnly = (uri: string): void => {
      if (/login\.microsoft\.com/.exec(new URL(uri).hostname) === null) throw new Error('rejected');
    };
    suffixOnly('https://login.microsoft.com/device');
    // The wrong guard accepts the look-alike, which is the point of the fixture: the real one throws.
    const real = (uri: string): void => {
      if (!isAllowedVerificationUri(uri)) throw new Error('verification link refused');
    };
    expectGuardFails(real, 'https://login.microsoft.com.evil.test/device', {
      reason: 'verification link refused',
    });
    expectGuardFails(real, 'javascript:alert(1)', { reason: 'refused' });
    expect(() => {
      suffixOnly('https://login.microsoft.com.evil.test/device');
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------
// Result codes (spec 6.9.5, contract 6.2)
// ---------------------------------------------------------------------------------------------

/** The rows of a "Step | Code | Status | Meaning" table: [step, code, status]. */
function resultRows(table: string): [string, string, string][] {
  const rows: [string, string, string][] = [];
  for (const m of table.matchAll(
    /^\| (environment|connect|configure|verify|finish) \| ([^|]+) \| (\w+) \|/gm,
  )) {
    for (const code of backticked(m[2] ?? '')) rows.push([m[1] ?? '', code, m[3] ?? '']);
  }
  return rows;
}

describe('SETUP_RESULT_CODES', () => {
  const specTable = sectionOf(SPEC, '**Wizard result codes**', /^\*\*Sign-in error codes\*\*/m);
  const contractTable = sectionOf(CONTRACT, '### 6.2 Wizard result codes', /^### P19/m);
  const specRows = resultRows(specTable);

  it('equals the wizard table of spec 6.9.5 per step with its status', () => {
    expect(specRows).toHaveLength(41);
    const registry = RESULT_CODES.map((code) => [
      SETUP_RESULT_CODES[code].step,
      code,
      SETUP_RESULT_CODES[code].status,
    ]);
    expect(registry).toEqual(specRows);
  });

  it('equals the table of contract 6.2 too, so the two documents agree', () => {
    expect(resultRows(contractTable)).toEqual(specRows);
  });

  it('puts every code in a step of the registry with a status valid for that step', () => {
    for (const code of RESULT_CODES) {
      const { step, status } = SETUP_RESULT_CODES[code];
      expect(STEP_KEYS, code).toContain(step);
      if (step === 'environment') expect(['fail', 'warn'], code).toContain(status);
      else expect(['failed', 'waiting', 'warning', 'skipped'], code).toContain(status);
    }
  });

  it('spells every code in snake case, unique, and finds them again per step', () => {
    expect(new Set(RESULT_CODES).size).toBe(RESULT_CODES.length);
    for (const code of RESULT_CODES) expect(code).toMatch(/^[a-z]+(?:_[a-z]+)*$/);
    expect(STEP_KEYS.flatMap((step) => resultCodesOf(step))).toEqual([...RESULT_CODES]);
    expect(resultCodesOf('environment')).toHaveLength(9);
    expect(resultCodesOf('finish')).toEqual(['owner_missing', 'group_unknown', 'owner_changed']);
  });

  it('recognises codes and refuses everything else, inherited names included', () => {
    expect(isResultCode('drift_detected')).toBe(true);
    for (const value of ['permission_denied', 'toString', '__proto__', '', 1, null, undefined]) {
      expect(isResultCode(value), String(value)).toBe(false);
    }
  });

  it('keeps wizard result codes apart from the problem codes except tenant_mismatch (CD-05)', async () => {
    const { PROBLEM_CODES } = await import('../src/problem.js');
    const shared = RESULT_CODES.filter((code) => Object.hasOwn(PROBLEM_CODES, code));
    // `tenant_mismatch` is both: a 409 problem code and a connect result code (spec 6.9.5). It
    // travels as a result code in `errors[].code` and in the step state, never as the other.
    //
    // Phase D (spec 6.11.3) adds `exchange_unavailable` as a 503 problem code of the Exchange layer; the
    // wizard has had it since Phase B as the warning result of the Exchange probe in the verify step
    // (`setup/result-codes.ts`). Same word, same meaning (Exchange is not reachable), two surfaces
    // that never mix: a result code travels in `errors[].code` of a setup step, a problem code is the
    // `code` of a problem body. That is the second and last permitted overlap.
    expect(
      shared.filter((code) => code !== 'tenant_mismatch' && code !== 'exchange_unavailable'),
    ).toEqual([]);
    expect(shared.sort()).toEqual(['exchange_unavailable', 'tenant_mismatch']);
  });

  it('derives one message key and one remedy key per code, all distinct', () => {
    const keys = RESULT_CODES.flatMap((code) => [resultMessageKey(code), resultRemedyKey(code)]);
    expect(new Set(keys).size).toBe(RESULT_CODES.length * 2);
    expect(resultMessageKey('drift_detected')).toBe('setup.result.drift_detected');
    expect(resultRemedyKey('drift_detected')).toBe('setup.remedy.drift_detected');
  });

  it('is frozen', () => {
    expect(Object.isFrozen(SETUP_RESULT_CODES)).toBe(true);
    expect(Object.isFrozen(SETUP_RESULT_CODES.drift_detected)).toBe(true);
  });

  it('negative: a registry that drops a documented code fails the table comparison', () => {
    const without = RESULT_CODES.filter((code) => code !== 'owner_changed').map((code) => [
      SETUP_RESULT_CODES[code].step,
      code,
      SETUP_RESULT_CODES[code].status,
    ]);
    expectGuardFails(
      () => {
        expect(without).toEqual(specRows);
      },
      undefined,
      { name: 'registry misses a documented code' },
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Log keys (plan Appendix A)
// ---------------------------------------------------------------------------------------------

describe('LOG_KEYS', () => {
  const appendix = sectionOf(PLAN, '## Appendix A. Log message keys', /^## Appendix B/m);
  const [wizardPart = '', eventsPart = ''] = appendix.split('Server log events');

  /** `setup.log.run_started` {mode, steps}; `.step_started` {step}; ... */
  function appendixKeys(): [string, string[]][] {
    const out: [string, string[]][] = [];
    const body = wizardPart.slice(wizardPart.indexOf('`setup.log.'));
    for (const segment of body.split(';')) {
      const m = /`(setup\.log\.[a-z_]+|\.[a-z_]+)`(?:\s*\{([^}]*)\})?/.exec(segment);
      if (!m) continue;
      const head = m[1] ?? '';
      const key = head.startsWith('.') ? `setup.log${head}` : head;
      out.push([key, m[2] ? m[2].split(',').map((p) => p.trim()) : []]);
    }
    return out;
  }

  /** The additions beyond the seed, each with the requirement that asks for it. */
  const ADDITIONS: Record<string, string[]> = {
    'setup.log.role_fixture_mismatch': ['role'], // FR-B-302
    'setup.log.drift_found': ['kind'], // FR-B-220, FR-B-307
  };

  it('equals plan Appendix A with its parameters, plus the two documented additions', () => {
    const seed = appendixKeys();
    expect(seed).toHaveLength(24);
    const expected = Object.fromEntries([...seed, ...Object.entries(ADDITIONS)]);
    const actual = Object.fromEntries(Object.entries(LOG_KEYS).map(([k, v]) => [k, [...v]]));
    expect(actual).toEqual(expected);
    expect(LOG_KEY_LIST).toHaveLength(26);
  });

  it('keeps key and parameter names plain, secret-free and scalar-only', () => {
    for (const [key, names] of Object.entries(LOG_KEYS)) {
      expect(key, key).toMatch(/^setup\.log\.[a-z]+(?:_[a-z]+)*$/);
      for (const name of names) {
        expect(name, `${key} ${name}`).toMatch(/^[a-z][A-Za-z0-9]*$/);
        expect(isSecretLookingKey(name), `${key} ${name}`).toBe(false);
      }
      expect(new Set(names).size).toBe(names.length);
      expect(names.length).toBeLessThanOrEqual(8); // Params: at most 8 entries
    }
    expect(LOG_PARAM_NAMES).toEqual([...new Set(Object.values(LOG_KEYS).flat())].sort());
  });

  it('recognises its keys only', () => {
    expect(isLogKey('setup.log.run_started')).toBe(true);
    for (const value of ['setup.log.nope', 'run_started', 'toString', null, 3]) {
      expect(isLogKey(value)).toBe(false);
    }
  });

  it('lists the thirteen server log events of FR-B-715 apart from the wizard keys', () => {
    const named = backticked(eventsPart.slice(0, eventsPart.indexOf('\n')));
    expect([...SERVER_LOG_EVENTS]).toEqual(named);
    expect(SERVER_LOG_EVENTS).toHaveLength(13);
    for (const event of SERVER_LOG_EVENTS) expect(isLogKey(event)).toBe(false);
  });

  it('is frozen all the way down', () => {
    expect(Object.isFrozen(LOG_KEYS)).toBe(true);
    expect(Object.isFrozen(LOG_KEYS['setup.log.found'])).toBe(true);
  });

  it('negative: a registry that lost a key fails the Appendix A comparison', () => {
    const partial = Object.fromEntries(
      Object.entries(LOG_KEYS)
        .filter(([key]) => key !== 'setup.log.run_crashed')
        .map(([k, v]) => [k, [...v]]),
    );
    const expected = Object.fromEntries([...appendixKeys(), ...Object.entries(ADDITIONS)]);
    expectGuardFails(
      () => {
        expect(partial).toEqual(expected);
      },
      undefined,
      { name: 'log registry misses run_crashed' },
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Backoff constants (spec 6.9.2, plan 9.7)
// ---------------------------------------------------------------------------------------------

describe('backoff constants', () => {
  it('equal the numbers of the spec table (referenced here, not copied into the module)', () => {
    expect(SETUP_TRANSIENT_BACKOFF).toEqual({ baseMs: 1_000, capMs: 30_000 });
    expect(SETUP_TRANSIENT_MAX_TRIES).toBe(6);
    expect(SETUP_REPLICATION_BACKOFF).toEqual({ baseMs: 2_000, capMs: 60_000 });
    expect(SETUP_MIN_WAIT_MS).toBe(500);
    expect(SETUP_OBJECT_CHAIN_WINDOW_SECONDS).toBe(300);
    expect(SETUP_PROPAGATION_TIMEOUT_SECONDS).toEqual({ default: 900, min: 60, max: 3_600 });
  });

  it('are the LIMITS values, not second copies', () => {
    expect(SETUP_MIN_WAIT_MS).toBe(LIMITS.setup.minWaitMs);
    expect(SETUP_TRANSIENT_BACKOFF.baseMs).toBe(LIMITS.setup.transientBackoff.initialMs);
    expect(SETUP_TRANSIENT_BACKOFF.capMs).toBe(LIMITS.setup.transientBackoff.maxMs);
    expect(SETUP_TRANSIENT_MAX_TRIES).toBe(LIMITS.setup.transientBackoff.maxTries);
    expect(SETUP_REPLICATION_BACKOFF.baseMs).toBe(LIMITS.setup.replicationBackoff.initialMs);
    expect(SETUP_REPLICATION_BACKOFF.capMs).toBe(LIMITS.setup.replicationBackoff.maxMs);
    expect(SETUP_OBJECT_CHAIN_WINDOW_SECONDS).toBe(LIMITS.setup.objectChainWindowSeconds);
    expect(SETUP_PROPAGATION_TIMEOUT_SECONDS).toEqual(LIMITS.setup.propagationTimeoutSeconds);
  });

  it('have the three failure classes, and only transient and replication have a schedule', () => {
    expect([...FAILURE_CLASSES]).toEqual(['transient', 'replication', 'permanent']);
    expect(scheduleOf('transient')).toBe(SETUP_TRANSIENT_BACKOFF);
    expect(scheduleOf('replication')).toBe(SETUP_REPLICATION_BACKOFF);
    expect(scheduleOf('permanent')).toBeUndefined();
  });

  it('keep the floor below both first delays, so a draw near zero is the only reason for it', () => {
    expect(SETUP_MIN_WAIT_MS).toBeLessThan(SETUP_TRANSIENT_BACKOFF.baseMs);
    expect(SETUP_MIN_WAIT_MS).toBeLessThan(SETUP_REPLICATION_BACKOFF.baseMs);
    expect(SETUP_TRANSIENT_BACKOFF.capMs).toBeGreaterThan(SETUP_TRANSIENT_BACKOFF.baseMs);
    expect(SETUP_REPLICATION_BACKOFF.capMs).toBeGreaterThan(SETUP_REPLICATION_BACKOFF.baseMs);
  });

  it('are frozen', () => {
    expect(Object.isFrozen(SETUP_TRANSIENT_BACKOFF)).toBe(true);
    expect(Object.isFrozen(SETUP_REPLICATION_BACKOFF)).toBe(true);
    expect(Object.isFrozen(SETUP_PROPAGATION_TIMEOUT_SECONDS)).toBe(true);
  });

  it('negative: a constant that drifted from the spec number fails', () => {
    expectGuardFails(
      () => {
        expect(SETUP_TRANSIENT_MAX_TRIES + 1).toBe(6);
      },
      undefined,
      { name: 'transient tries drifted' },
    );
  });
});
