// T-B-390 (TB-06), FR-B-715: the structured log events of Phase B, over one full life of the panel on
// the real server and the fake tenant (test/helpers/full-run.ts). Each event exists, carries the fields
// it is allowed to carry and nothing else, and no line of the whole run holds an `oid`, a user name, a
// display name, a token, a code, a `state`, a session id, the setup token or a key.
//
// The checks are guards (`assertEventLines`, `assertNoPersonalData`): functions that throw. The real run
// must pass them and the negative fixtures at the end must not (tasks.md section 0.3).
import { SIGNIN_ERROR_CODES, NO_ACCESS_REASONS } from '@m365portal/shared/auth/signin-errors';
import { STEP_KEYS, SUB_ACTION_KEYS, STEP_STATUSES } from '@m365portal/shared/setup/steps';
import { expectGuardFails } from '@m365portal/shared/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runFullLifecycle, type FullRun } from './helpers/full-run.js';
import { useWizardTimers } from './setup/support/tenant-scene.js';

type Line = Record<string, unknown>;

/** Fields every line has (pino, the module label the logger adds). */
const BASE_FIELDS = ['level', 'time', 'msg', 'event', 'module'];

interface EventRule {
  readonly fields: Readonly<Record<string, (value: unknown) => boolean>>;
}

const isOneOf =
  (allowed: readonly string[]) =>
  (value: unknown): boolean =>
    typeof value === 'string' && allowed.includes(value);

/** FR-B-715: the nine events and the fields each may carry. */
const RULES: Readonly<Record<string, EventRule>> = {
  setup_unlock_locked: { fields: { lockScope: isOneOf(['client', 'global']) } },
  setup_step: {
    fields: {
      step: isOneOf(STEP_KEYS),
      subAction: isOneOf(SUB_ACTION_KEYS),
      status: isOneOf(STEP_STATUSES),
      attempt: (value) => Number.isInteger(value) && (value as number) >= 0,
    },
  },
  signin_ok: { fields: { mfa: (value) => typeof value === 'boolean' } },
  signin_denied: {
    fields: { code: isOneOf([...SIGNIN_ERROR_CODES, ...NO_ACCESS_REASONS, 'invalid_client']) },
  },
  session_revoked: { fields: { reason: isOneOf(['account_disabled']) } },
  break_glass_signin: { fields: {} },
  membership_refresh_failed: { fields: { reason: (value) => typeof value === 'string' } },
  preview_mode_removed: {
    fields: {
      variables: (value) =>
        Array.isArray(value) &&
        value.every((name) => name === 'PREVIEW_MODE' || name === 'PREVIEW_MODE_ALLOW_REMOTE'),
    },
  },
  setup_token_after_complete: { fields: {} },
};

function parse(text: string): Line[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Line);
}

/** Throws unless every one of the nine events is present and every line of it is in its rule. */
function assertEventLines(lines: readonly Line[]): void {
  for (const [event, rule] of Object.entries(RULES)) {
    const found = lines.filter((line) => line.event === event);
    if (found.length === 0) throw new Error(`the event ${event} was never logged`);
    for (const line of found) {
      for (const [name, value] of Object.entries(line)) {
        if (BASE_FIELDS.includes(name)) continue;
        const check = rule.fields[name];
        if (check === undefined) throw new Error(`${event}: the field ${name} is not allowed`);
        if (!check(value))
          throw new Error(`${event}: the field ${name} has a value out of its list`);
      }
      if (line.msg !== event) throw new Error(`${event}: the message is ${String(line.msg)}`);
    }
  }
}

/** Throws when a value that identifies a person or opens something is in a line of the log. */
function assertNoPersonalData(
  text: string,
  forbidden: readonly (readonly [string, string])[],
): void {
  for (const [name, value] of forbidden) {
    if (value !== '' && text.includes(value)) throw new Error(`the log holds ${name}`);
  }
}

describe('structured log events over a full run (FR-B-715)', () => {
  beforeEach(() => {
    useWizardTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  let run: FullRun | undefined;
  const have = (): FullRun => {
    if (run === undefined) throw new Error('the full run has not happened');
    return run;
  };

  it('the full run happens: wizard, sign-ins, the stranger turned away, break-glass, Graph failing, rotation, restarts', async () => {
    run = await runFullLifecycle();
    expect(run.facts).toMatchObject({
      completed: true,
      ownerSignedIn: true,
      breakGlassSignedIn: true,
      noRoleTurnedAway: true,
      previewLines: 1,
    });
  }, 300_000);

  it('every event exists once at least, with the fields of its rule and no others', () => {
    expect(() => {
      assertEventLines(parse(have().logText));
    }).not.toThrow();
  });

  it('setup_step names a step, a sub-action, a status and an attempt, once per settled sub-action', () => {
    const lines = parse(have().logText).filter((line) => line.event === 'setup_step');
    expect(lines.length).toBeGreaterThanOrEqual(10);
    for (const line of lines) {
      expect(Object.keys(line).sort()).toEqual(
        [
          'attempt',
          'event',
          'level',
          'module',
          'msg',
          'status',
          'step',
          'subAction',
          'time',
        ].sort(),
      );
    }
  });

  it('signin_denied names an allow-listed code: no_role for the person without a role', () => {
    const codes = parse(have().logText)
      .filter((line) => line.event === 'signin_denied')
      .map((line) => line.code);
    expect(codes).toContain('no_role');
  });

  it('no line of the run holds an oid, a user name, a display name, a token, a code, a state, a session id, the setup token or a key', () => {
    const current = have();
    const canaryValues = current.canaries.flatMap((canary) =>
      canary.values.map((value) => [canary.name, value] as const),
    );
    expect(canaryValues.length).toBeGreaterThan(20);
    const identity: (readonly [string, string])[] = [
      ['the oid of the Owner', current.oid],
      ['the user name of the Owner', current.upn],
      ['the display name of the Owner', current.displayName],
      ['the user name of the stranger', 'stranger@contoso-fake.example'],
    ];
    expect(() => {
      assertNoPersonalData(current.logText, [...identity, ...canaryValues]);
    }).not.toThrow();
  });

  describe('negative fixtures: the guards fail on purpose', () => {
    const good = (): Line[] => [
      ...Object.entries(RULES).map(([event]) => ({ level: 'info', time: 't', msg: event, event })),
    ];

    it('an event that was never logged', () => {
      expectGuardFails(assertEventLines, good().slice(1), { reason: /was never logged/ });
    });

    it('a field the rule does not allow, such as an oid', () => {
      const lines = good().map((line) =>
        line.event === 'signin_ok'
          ? { ...line, oid: '5b0d7a3e-8c1f-4f6e-9a52-0d3c2b1a4e77' }
          : line,
      );
      expectGuardFails(assertEventLines, lines, {
        reason: /signin_ok: the field oid is not allowed/,
      });
    });

    it('a code outside the allow-list', () => {
      const lines = good().map((line) =>
        line.event === 'signin_denied' ? { ...line, code: 'someone@example.com' } : line,
      );
      expectGuardFails(assertEventLines, lines, { reason: /out of its list/ });
    });

    it('a user name, a token or a state in a line', () => {
      for (const forbidden of [
        ['a user name', 'admin@contoso-fake.example'],
        ['a token', 'eyJhbGciOi.payload.signature'],
        ['a state', 'state-0123456789abcdef'],
      ] as const) {
        expectGuardFails(
          (text: string) => {
            assertNoPersonalData(text, [forbidden]);
          },
          `{"msg":"x ${forbidden[1]}"}`,
          { reason: /holds/ },
        );
      }
    });
  });
});
