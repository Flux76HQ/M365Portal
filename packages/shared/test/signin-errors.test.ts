// T-B-180, FR-B-403, FR-B-405, FR-B-411, FR-B-603 (part), TB-05, TB-13, CB12: the sign-in code
// registry. `/signin?error=<code>` accepts only the allow-list of spec 6.9.5 and renders
// `signin_failed` for anything else; `/no-access?reason=` accepts `no_role` and `graph_unavailable`;
// the `check` and `reason` values of the audit entries come from Appendix C and are never shown to
// the user. The documents are read, so a document that changes without the registry fails.
// Every guard has a negative fixture (tasks.md section 0.3).
import { readFileSync } from 'node:fs';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { AADSTS_REASONS, mapMicrosoftError } from '../src/auth/aadsts-map.js';
import {
  NO_ACCESS_REASONS,
  SIGNIN_AUDIT_REASONS,
  SIGNIN_CHECKS,
  SIGNIN_CODE_FOR_REASON,
  SIGNIN_CONSENT_LINK_CODES,
  SIGNIN_ERROR_AUDIT,
  SIGNIN_ERROR_CODES,
  STEPUP_CHECKS,
  isNoAccessReason,
  isSigninErrorCode,
  noAccessMessageKey,
  resolveNoAccessReason,
  resolveNoAccessRef,
  resolveSigninError,
  signinCodeForMicrosoftError,
  signinErrorMessageKey,
  signinErrorRemedyKey,
} from '../src/auth/signin-errors.js';
import { expectGuardFails } from '../src/testing/index.js';

const show = (value: unknown): string => inspect(value, { breakLength: Infinity });
const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8');
const SPEC = read('../../../specs/002-phase-b/spec.md');
const CONTRACT = read('../../../specs/002-phase-b/contracts/phase-b-api.md');

const backticked = (text: string): string[] =>
  [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? '');

/** The text from `start` to the next heading line that matches `end`. */
function sectionOf(document: string, start: string, end: RegExp): string {
  const from = document.indexOf(start);
  if (from < 0) throw new Error(`section start not found: ${start}`);
  const rest = document.slice(from);
  const first = rest.indexOf('\n') + 1;
  const stop = rest.slice(first).search(end);
  return stop < 0 ? rest : rest.slice(0, first + stop);
}

/** The rows of the sign-in table of spec 6.9.5: [codes, audited column]. */
function specSigninRows(): [string[], string][] {
  const table = sectionOf(SPEC, '**Sign-in error codes**', /^#{2,4} /m);
  return [...table.matchAll(/^\| ([^|]+) \| [^|]+ \| ([^|]+) \|$/gm)]
    .filter((m) => (m[1] ?? '').includes('`'))
    .map((m) => [backticked(m[1] ?? ''), (m[2] ?? '').trim()]);
}

describe('SIGNIN_ERROR_CODES', () => {
  it('is the allow-list of spec 6.9.5, in the order the table gives it', () => {
    const codes = specSigninRows()
      .flatMap(([row]) => row)
      .filter((code) => !isNoAccessCode(code));
    expect(codes).toEqual([...SIGNIN_ERROR_CODES]);
    expect(SIGNIN_ERROR_CODES).toEqual([
      'signin_failed',
      'cookies_missing_or_expired',
      'access_denied',
      'interaction_required',
      'consent_required',
      'admin_approval_required',
      'assignment_required',
      'conditional_access_blocked',
      'temporarily_unavailable',
      'mfa_required',
      'amr_missing',
      'stepup_failed',
      'secrets_unavailable',
      'setup_required',
      'session_expired',
    ]);
  });

  it('is also the allow-list of contract 9.2', () => {
    const table = sectionOf(CONTRACT, '### 9.2 Sign-in error codes', /^### 9\.3/m);
    const rows = [...table.matchAll(/^\| ([^|]+) \| [^|]+ \| ([^|]+) \|$/gm)].filter((m) =>
      (m[1] ?? '').includes('`'),
    );
    const codes = rows
      .flatMap((m) => backticked(m[1] ?? ''))
      .filter((code) => !isNoAccessCode(code));
    expect(codes).toEqual([...SIGNIN_ERROR_CODES]);
  });

  it('says for each code whether the audit trail records it, as the Audited column does', () => {
    for (const [codes, audited] of specSigninRows()) {
      for (const code of codes) {
        if (isNoAccessCode(code)) continue;
        const expected = audited.startsWith('from')
          ? 'from_validation'
          : audited === 'yes'
            ? 'always'
            : 'never';
        expect(SIGNIN_ERROR_AUDIT[code as keyof typeof SIGNIN_ERROR_AUDIT], code).toBe(expected);
      }
    }
    expect(Object.keys(SIGNIN_ERROR_AUDIT)).toEqual([...SIGNIN_ERROR_CODES]);
  });

  it('resolves any value outside the allow-list to signin_failed', () => {
    for (const code of SIGNIN_ERROR_CODES) expect(resolveSigninError(code)).toBe(code);
    for (const value of [
      'nope',
      '',
      'SIGNIN_FAILED',
      ' signin_failed',
      'access_denied ',
      'toString',
      '__proto__',
      'constructor',
      'no_role',
      '<script>alert(1)</script>',
      'a'.repeat(5000),
      undefined,
      null,
      0,
      {},
      ['access_denied'],
    ]) {
      expect(resolveSigninError(value), show(value).slice(0, 30)).toBe('signin_failed');
    }
  });

  it('recognises only its own codes', () => {
    expect(isSigninErrorCode('mfa_required')).toBe(true);
    expect(isSigninErrorCode('no_role')).toBe(false);
    expect(isSigninErrorCode('hasOwnProperty')).toBe(false);
  });

  it('names a message key and a remedy key for every code, all distinct', () => {
    const keys = SIGNIN_ERROR_CODES.flatMap((code) => [
      signinErrorMessageKey(code),
      signinErrorRemedyKey(code),
    ]);
    expect(new Set(keys).size).toBe(SIGNIN_ERROR_CODES.length * 2);
    expect(signinErrorMessageKey('mfa_required')).toBe('signin.error.mfa_required');
    expect(signinErrorRemedyKey('mfa_required')).toBe('signin.remedy.mfa_required');
  });

  it('keeps the consent link for the two codes FR-B-419 names, and no other', () => {
    expect([...SIGNIN_CONSENT_LINK_CODES]).toEqual(['consent_required', 'admin_approval_required']);
    for (const code of SIGNIN_CONSENT_LINK_CODES) expect(SIGNIN_ERROR_CODES).toContain(code);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(SIGNIN_ERROR_CODES)).toBe(true);
    expect(Object.isFrozen(SIGNIN_ERROR_AUDIT)).toBe(true);
    expect(Object.isFrozen(SIGNIN_CODE_FOR_REASON)).toBe(true);
  });

  it('negative: a resolver that passes unknown values through fails the allow-list rule', () => {
    const guard = (impl: (value: string) => string) => (value: string) => {
      if (impl(value) !== 'signin_failed') throw new Error('unknown code rendered as is');
    };
    guard(resolveSigninError)('nope');
    expectGuardFails(
      guard((value) => value),
      'nope',
      { reason: 'rendered as is' },
    );
  });
});

function isNoAccessCode(code: string): boolean {
  return code === 'no_role' || code === 'graph_unavailable' || code.startsWith('no-access');
}

describe('NO_ACCESS_REASONS', () => {
  it('is no_role and graph_unavailable', () => {
    expect([...NO_ACCESS_REASONS]).toEqual(['no_role', 'graph_unavailable']);
  });

  it('renders no_role for anything else', () => {
    expect(resolveNoAccessReason('graph_unavailable')).toBe('graph_unavailable');
    expect(resolveNoAccessReason('no_role')).toBe('no_role');
    for (const value of [
      '',
      'signin_failed',
      'GRAPH_UNAVAILABLE',
      'toString',
      undefined,
      null,
      1,
      [],
    ]) {
      expect(resolveNoAccessReason(value)).toBe('no_role');
    }
    expect(isNoAccessReason('graph_unavailable')).toBe(true);
    expect(isNoAccessReason('mfa_required')).toBe(false);
  });

  it('shows the reference id only when it matches ^[A-Za-z0-9-]{8,64}$', () => {
    expect(resolveNoAccessRef('0f8fad5b-d9cb-469f-a165-70867728950e')).toBe(
      '0f8fad5b-d9cb-469f-a165-70867728950e',
    );
    expect(resolveNoAccessRef('abcdefgh')).toBe('abcdefgh');
    expect(resolveNoAccessRef('a'.repeat(64))).toBe('a'.repeat(64));
    for (const value of [
      'abcdefg',
      'a'.repeat(65),
      'has space1',
      '<b>abcdefgh',
      'abcdefgh\n',
      'ab_cdefgh',
      '',
      undefined,
      null,
      5,
    ]) {
      expect(resolveNoAccessRef(value), String(value)).toBeNull();
    }
  });

  it('has one message key per reason', () => {
    expect(noAccessMessageKey('no_role')).toBe('noaccess.reason.no_role');
    expect(noAccessMessageKey('graph_unavailable')).toBe('noaccess.reason.graph_unavailable');
  });
});

describe('SIGNIN_CHECKS (Appendix C)', () => {
  const appendix = sectionOf(SPEC, '## Appendix C. Sign-in fixtures', /^## Appendix D/m);

  it('equals the check names Appendix C lists', () => {
    const list = /`check` is the internal check name \(([^)]+)\)/.exec(appendix)?.[1] ?? '';
    expect(backticked(list)).toEqual([...SIGNIN_CHECKS]);
    expect(SIGNIN_CHECKS).toHaveLength(15);
  });

  it('uses every check in at least one fixture row', () => {
    const rows = [...appendix.matchAll(/^\| F-(\d\d) \|.*$/gm)];
    expect(rows).toHaveLength(45);
    const used = new Set(
      rows.flatMap((m) => [...m[0].matchAll(/check `([a-z_]+)`/g)].map((c) => c[1])),
    );
    expect([...used].sort()).toEqual([...SIGNIN_CHECKS].sort());
  });

  it('holds every reason of the Audit column of Appendix C in SIGNIN_AUDIT_REASONS', () => {
    const rows = [...appendix.matchAll(/^\| F-\d\d \|.*\| (denied[^|]*) \| \d[^|]* \|$/gm)];
    const reasons = new Set<string>();
    for (const m of rows) {
      const auditCell = (m[1] ?? '').replace(/check `[a-z_]+`/g, '');
      for (const word of backticked(auditCell)) reasons.add(word);
    }
    expect([...reasons].sort()).toEqual(
      [
        'amr_missing',
        'graph_unavailable',
        'keys_unavailable',
        'mfa_required',
        'no_role',
        'token_invalid',
      ].sort(),
    );
    for (const reason of reasons) expect(SIGNIN_AUDIT_REASONS, reason).toContain(reason);
  });

  it('adds the step-up checks of FR-B-411 and keeps names distinct and plain', () => {
    expect([...STEPUP_CHECKS]).toEqual(['oid_mismatch', 'auth_time_missing', 'auth_time_stale']);
    const all = [...SIGNIN_CHECKS, ...STEPUP_CHECKS];
    expect(new Set(all).size).toBe(all.length);
    for (const name of all) expect(name).toMatch(/^[a-z]+(?:_[a-z]+)*$/);
    expect([...SIGNIN_AUDIT_REASONS]).toEqual([
      'token_invalid',
      'keys_unavailable',
      'mfa_required',
      'amr_missing',
      'no_role',
      'graph_unavailable',
      'stepup_failed',
    ]);
  });

  it('negative: a registry without a documented check fails the comparison', () => {
    const without = SIGNIN_CHECKS.filter((name) => name !== 'nonce');
    expectGuardFails(
      () => {
        expect(without).toEqual([...SIGNIN_CHECKS]);
      },
      undefined,
      { name: 'checks miss nonce' },
    );
  });
});

describe('projection of the AADSTS map (TB-05)', () => {
  it('maps every reason of the shared table to a sign-in code in the allow-list', () => {
    expect(Object.keys(SIGNIN_CODE_FOR_REASON).sort()).toEqual([...AADSTS_REASONS].sort());
    for (const reason of AADSTS_REASONS) {
      expect(SIGNIN_ERROR_CODES, reason).toContain(SIGNIN_CODE_FOR_REASON[reason]);
    }
  });

  it('keeps the distinct messages FR-B-217 asks for, and hides the rest behind signin_failed', () => {
    expect(SIGNIN_CODE_FOR_REASON.consent_required).toBe('consent_required');
    expect(SIGNIN_CODE_FOR_REASON.admin_approval_required).toBe('admin_approval_required');
    expect(SIGNIN_CODE_FOR_REASON.assignment_required).toBe('assignment_required');
    expect(SIGNIN_CODE_FOR_REASON.conditional_access_blocked).toBe('conditional_access_blocked');
    expect(SIGNIN_CODE_FOR_REASON.interaction_required).toBe('interaction_required');
    expect(SIGNIN_CODE_FOR_REASON.temporarily_unavailable).toBe('temporarily_unavailable');
    for (const reason of [
      'invalid_client',
      'client_assertion_invalid',
      'refresh_token_invalid',
      'unknown',
    ] as const) {
      expect(SIGNIN_CODE_FOR_REASON[reason], reason).toBe('signin_failed');
    }
  });

  it.each([
    ['F-34 access_denied', { error: 'access_denied' }, 'access_denied'],
    ['F-35 interaction_required', { error: 'interaction_required' }, 'interaction_required'],
    [
      'F-36 AADSTS65001',
      { error: 'invalid_grant', errorDescription: 'AADSTS65001: The user has not consented' },
      'consent_required',
    ],
    [
      'F-36 AADSTS90093',
      { error: 'access_denied', errorDescription: 'AADSTS90093: x' },
      'admin_approval_required',
    ],
    [
      'F-36 AADSTS90094',
      { error: 'invalid_request', errorDescription: 'AADSTS90094: x' },
      'admin_approval_required',
    ],
    [
      'F-36 AADSTS50105',
      { error: 'access_denied', errorDescription: 'AADSTS50105: x' },
      'assignment_required',
    ],
    [
      'AADSTS53003',
      { error: 'access_denied', errorDescription: 'AADSTS53003: x' },
      'conditional_access_blocked',
    ],
    [
      'F-37 hostile description',
      { error: 'invalid_request', errorDescription: `${'x'.repeat(5000)} AADSTS65001` },
      'signin_failed',
    ],
    ['F-38 invalid_grant', { error: 'invalid_grant' }, 'signin_failed'],
    ['F-39 invalid_client', { error: 'invalid_client' }, 'signin_failed'],
    ['temporarily_unavailable', { error: 'temporarily_unavailable' }, 'temporarily_unavailable'],
    [
      'unknown AADSTS number',
      { error: 'server_error', errorDescription: 'AADSTS999999: x' },
      'signin_failed',
    ],
    ['nothing at all', {}, 'signin_failed'],
    ['not strings', { error: 5, errorDescription: {} }, 'signin_failed'],
  ] as const)('signinCodeForMicrosoftError: %s', (_name, input, expected) => {
    expect(signinCodeForMicrosoftError(input)).toBe(expected);
    expect(SIGNIN_ERROR_CODES).toContain(signinCodeForMicrosoftError(input));
  });

  it('agrees with the shared map: whatever it maps is handled, and the result is a code, not text', () => {
    for (const reason of AADSTS_REASONS) {
      const code = SIGNIN_CODE_FOR_REASON[reason];
      expect(typeof code).toBe('string');
    }
    expect(mapMicrosoftError({ error: 'access_denied' }).reason).toBe('unknown');
  });

  it('negative: a projection that forgets a reason fails the totality check', () => {
    const missing = Object.keys(SIGNIN_CODE_FOR_REASON).filter((key) => key !== 'unknown');
    expectGuardFails(
      () => {
        expect(missing.sort()).toEqual([...AADSTS_REASONS].sort());
      },
      undefined,
      { name: 'projection misses a reason' },
    );
  });
});
