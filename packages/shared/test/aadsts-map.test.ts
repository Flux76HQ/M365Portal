// T-B-068, FR-B-217 (shared half), TB-05: one table from an AADSTS number (or an OAuth error string)
// to a canonical reason. The wizard's result codes (T-B-131) and the sign-in error codes (T-B-180)
// are projections of it. Only the number is ever kept; Microsoft's free text never is.
//
// Documented codes (research-microsoft-b.md sections 2.6, 5.4 and 5.6), each re-read on Microsoft Learn
// on 2026-10-11:
//   65001   https://learn.microsoft.com/troubleshoot/entra/entra-id/app-integration/troubleshoot-consent-issues
//   90093, 90094  https://learn.microsoft.com/entra/identity/enterprise-apps/application-sign-in-unexpected-user-consent-error
//   50105   https://learn.microsoft.com/troubleshoot/entra/entra-id/app-integration/error-code-aadsts50105-user-not-assigned-role
//   53003   https://learn.microsoft.com/entra/identity/conditional-access/troubleshoot-conditional-access
//   530036  https://learn.microsoft.com/entra/identity/conditional-access/concept-authentication-flows
//   700027  https://learn.microsoft.com/entra/msal/javascript/node/certificate-credentials
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  AADSTS_NUMBER_REASONS,
  AADSTS_REASONS,
  OAUTH_ERROR_REASONS,
  extractAadsts,
  mapMicrosoftError,
  type AadstsReason,
} from '../src/auth/aadsts-map.js';
import { expectGuardFails } from '../src/testing/index.js';

/** The documented numbers and the reason each must map to: the second statement of FR-B-217. */
const DOCUMENTED_NUMBERS: readonly (readonly [number, string])[] = [
  [65001, 'consent_required'],
  [90094, 'admin_approval_required'],
  [90093, 'admin_approval_required'],
  [50105, 'assignment_required'],
  [53003, 'conditional_access_blocked'],
  [530036, 'refresh_token_invalid'],
  [700027, 'client_assertion_invalid'],
];

const DOCUMENTED_STRINGS: readonly (readonly [string, string])[] = [
  ['invalid_client', 'invalid_client'],
  ['interaction_required', 'interaction_required'],
  ['consent_required', 'consent_required'],
  ['temporarily_unavailable', 'temporarily_unavailable'],
];

/** The guard behind "a table with a missing documented code fails". */
function assertTableCoversDocumented(tables: {
  readonly numbers: Readonly<Record<number, string>>;
  readonly strings: Readonly<Record<string, string>>;
}): void {
  const { numbers, strings } = tables;
  const problems: string[] = [];
  for (const [number, reason] of DOCUMENTED_NUMBERS) {
    if (numbers[number] !== reason)
      problems.push(`AADSTS${String(number)} is not mapped to ${reason}`);
  }
  for (const [error, reason] of DOCUMENTED_STRINGS) {
    if (!Object.hasOwn(strings, error) || strings[error] !== reason) {
      problems.push(`${error} is not mapped to ${reason}`);
    }
  }
  if (problems.length > 0) throw new Error(problems.join('; '));
}

describe('extractAadsts: the strict pattern', () => {
  it.each([
    ['AADSTS65001: The user or administrator has not consented to use the application.', 65001],
    ['AADSTS90094: An administrator needs to grant permission.', 90094],
    ['AADSTS530036: blocked', 530036],
    ['AADSTS700027', 700027],
    ['AADSTS1234: short', 1234],
    ['AADSTS1234567: seven digits', 1234567],
  ])('reads the number from %j', (description, number) => {
    expect(extractAadsts(description)).toBe(number);
  });

  it.each([
    ['empty', ''],
    ['no code', 'The user is blocked.'],
    ['lower case', 'aadsts65001: x'],
    ['leading space', ' AADSTS65001: x'],
    ['leading newline', '\nAADSTS65001: x'],
    ['code not at the start', 'Error AADSTS65001: x'],
    ['three digits', 'AADSTS650: x'],
    ['eight digits', 'AADSTS12345678: x'],
    ['no digits', 'AADSTS: x'],
    ['a sign', 'AADSTS-65001: x'],
    ['a hex form', 'AADSTS0xFFFF: x'],
    ['full-width digits', 'AADSTS６５００１: x'],
    ['a number', 65001],
    ['null', null],
    ['undefined', undefined],
    ['an object', { toString: () => 'AADSTS65001' }],
    ['an array', ['AADSTS65001']],
  ])('returns null for %s', (_name, description) => {
    expect(extractAadsts(description)).toBeNull();
  });

  it('reads only the code at the start, never a second one inside the text', () => {
    expect(extractAadsts('AADSTS65001: see also AADSTS53003 and AADSTS90094')).toBe(65001);
    expect(extractAadsts('Trace ID: x AADSTS53003: Correlation ID: y')).toBeNull();
  });

  it('works on a 5,000 character description without scanning it all', () => {
    expect(extractAadsts(`AADSTS65001: ${'A'.repeat(5000)}`)).toBe(65001);
    expect(extractAadsts(`${'A'.repeat(5000)} AADSTS65001`)).toBeNull();
  });
});

describe('the table', () => {
  it.each(DOCUMENTED_NUMBERS)('maps AADSTS%i to %s', (number, reason) => {
    expect(mapMicrosoftError({ errorDescription: `AADSTS${String(number)}: text` })).toEqual({
      reason,
      aadsts: number,
    });
  });

  it.each(DOCUMENTED_STRINGS)('maps the error string %s to %s', (error, reason) => {
    expect(mapMicrosoftError({ error })).toEqual({ reason, aadsts: null });
  });

  it('covers every documented code and string', () => {
    expect(() => {
      assertTableCoversDocumented({ numbers: AADSTS_NUMBER_REASONS, strings: OAUTH_ERROR_REASONS });
    }).not.toThrow();
  });

  it('fails the guard for a table that lacks a documented code (negative)', () => {
    const withoutConditionalAccess = Object.fromEntries(
      Object.entries(AADSTS_NUMBER_REASONS).filter(([number]) => number !== '53003'),
    );
    expectGuardFails(
      assertTableCoversDocumented,
      { numbers: withoutConditionalAccess, strings: OAUTH_ERROR_REASONS },
      { reason: 'AADSTS53003 is not mapped' },
    );
    const withoutString = Object.fromEntries(
      Object.entries(OAUTH_ERROR_REASONS).filter(([error]) => error !== 'temporarily_unavailable'),
    );
    expectGuardFails(
      assertTableCoversDocumented,
      { numbers: AADSTS_NUMBER_REASONS, strings: withoutString },
      { reason: 'temporarily_unavailable is not mapped' },
    );
  });

  it('only maps to reasons that are in the published list, and every reason is used or "unknown"', () => {
    const used = new Set<string>([
      ...Object.values(AADSTS_NUMBER_REASONS),
      ...Object.values(OAUTH_ERROR_REASONS),
    ]);
    for (const reason of used) expect(AADSTS_REASONS as readonly string[]).toContain(reason);
    for (const reason of AADSTS_REASONS) {
      if (reason !== 'unknown') expect(used.has(reason)).toBe(true);
    }
    expect(AADSTS_REASONS).toContain('unknown');
  });

  it('is deeply frozen', () => {
    expect(Object.isFrozen(AADSTS_NUMBER_REASONS)).toBe(true);
    expect(Object.isFrozen(OAUTH_ERROR_REASONS)).toBe(true);
    expect(Object.isFrozen(AADSTS_REASONS)).toBe(true);
  });
});

describe('mapMicrosoftError: unknown input', () => {
  it('maps an unknown number to "unknown" and keeps the number', () => {
    expect(
      mapMicrosoftError({ errorDescription: 'AADSTS7000215: Invalid client secret.' }),
    ).toEqual({ reason: 'unknown', aadsts: 7000215 });
  });

  it('maps nothing at all to "unknown" with no number', () => {
    expect(mapMicrosoftError({})).toEqual({ reason: 'unknown', aadsts: null });
    expect(mapMicrosoftError({ error: 'something_new' })).toEqual({
      reason: 'unknown',
      aadsts: null,
    });
    expect(mapMicrosoftError({ error: 5, errorDescription: 5 })).toEqual({
      reason: 'unknown',
      aadsts: null,
    });
  });

  it('prefers the specific number over the generic error string, and keeps the number', () => {
    expect(
      mapMicrosoftError({
        error: 'interaction_required',
        errorDescription: 'AADSTS53003: blocked',
      }),
    ).toEqual({ reason: 'conditional_access_blocked', aadsts: 53003 });
  });

  it('falls back to the error string when the number is unknown, and keeps the number', () => {
    expect(
      mapMicrosoftError({ error: 'invalid_client', errorDescription: 'AADSTS7000222: expired' }),
    ).toEqual({ reason: 'invalid_client', aadsts: 7000222 });
  });

  it('does not look up inherited names or odd error strings', () => {
    for (const error of [
      'constructor',
      '__proto__',
      'toString',
      'hasOwnProperty',
      'INVALID_CLIENT',
      ' invalid_client',
    ]) {
      expect(mapMicrosoftError({ error })).toEqual({ reason: 'unknown', aadsts: null });
    }
  });
});

describe('hostile descriptions never leak into the result', () => {
  const HOSTILE = [
    `AADSTS65001: ${'<script>alert(1)</script>'.repeat(200)}`,
    'AADSTS65001: \u0000\u0007\u001b[31mred\u001b[0m\r\nSet-Cookie: x=y',
    'AADSTS65001: [click](javascript:alert(1)) <img src=x onerror=1>',
    'AADSTS65001: second AADSTS53003 AADSTS90094 inside the text',
    `AADSTS65001: ${'A'.repeat(5000)}`,
    'AADSTS65001: Correlation ID: 00000000-0000-0000-0000-000000000000 Timestamp: 2026-10-11',
  ];

  it.each(HOSTILE.map((description, index) => [index, description] as const))(
    'case %i keeps only the number and the reason',
    (_index, description) => {
      const result = mapMicrosoftError({ errorDescription: description });
      expect(result).toEqual({ reason: 'consent_required', aadsts: 65001 });
      expect(Object.keys(result).sort()).toEqual(['aadsts', 'reason']);
      expect(JSON.stringify(result)).not.toMatch(/script|Set-Cookie|javascript|Correlation/);
      expect(JSON.stringify(result)).not.toContain('\u0000');
    },
  );

  it('does not map from a code that only appears inside the text', () => {
    expect(mapMicrosoftError({ errorDescription: 'Sign-in failed. AADSTS53003: blocked' })).toEqual(
      { reason: 'unknown', aadsts: null },
    );
  });

  it('returns a result that carries no description even when the reason is unknown', () => {
    const result = mapMicrosoftError({ errorDescription: 'AADSTS9999999: <b>x</b>' });
    expect(result).toEqual({ reason: 'unknown', aadsts: 9999999 });
  });
});

describe('types', () => {
  it('names the reason set', () => {
    expectTypeOf<AadstsReason>().toEqualTypeOf<(typeof AADSTS_REASONS)[number]>();
    expectTypeOf(mapMicrosoftError).returns.toEqualTypeOf<{
      reason: AadstsReason;
      aadsts: number | null;
    }>();
  });
});
