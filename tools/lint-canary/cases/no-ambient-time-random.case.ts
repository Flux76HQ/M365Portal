// Canary cases for local/no-ambient-time-random (PB-20): scope
// apps/server/src/{setup,connection,auth,rbac,policy,integrations,secrets}/**.
//
// The Phase A folders (lifecycle, http, branding, audit) keep reading the clock directly and are
// outside the scope; the control below is the one that notices a scope that was widened.
import type { CanaryCase } from '../canary-case.js';

const RULE = 'local/no-ambient-time-random';

export const cases = [
  {
    name: 'a setup service reads the wall clock',
    path: 'apps/server/src/setup/__lint_canary__/date-now.ts',
    code: `
export function expiresAt(): number {
  return Date.now() + 900_000;
}
`,
    mustReport: [RULE],
  },
  {
    name: 'a sign-in service builds a Date from nothing',
    path: 'apps/server/src/auth/__lint_canary__/new-date.ts',
    code: `
export function today(): string {
  return new Date().toISOString();
}
`,
    mustReport: [RULE],
  },
  {
    name: 'an RBAC service uses Math.random',
    path: 'apps/server/src/rbac/__lint_canary__/math-random.ts',
    code: `
export function jitter(): number {
  return Math.random() * 100;
}
`,
    mustReport: [RULE],
  },
  {
    name: 'an integration starts a global timer',
    path: 'apps/server/src/integrations/graph/__lint_canary__/set-timeout.ts',
    code: `
export function later(callback: () => void): void {
  setTimeout(callback, 1000);
}
`,
    mustReport: [RULE],
  },
  {
    name: 'the policy layer asks node:crypto for a UUID',
    path: 'apps/server/src/policy/__lint_canary__/random-uuid.ts',
    code: `
import { randomUUID } from 'node:crypto';

export const id = randomUUID;
`,
    mustReport: [RULE],
  },
  {
    name: 'secrets reads the wall clock',
    path: 'apps/server/src/secrets/__lint_canary__/date-now-secrets.ts',
    code: `
export function stamp(): number {
  return Date.now();
}
`,
    mustReport: [RULE],
  },
  {
    name: 'control: the injected clock, source and scheduler are the way',
    path: 'apps/server/src/connection/__lint_canary__/injected.ts',
    code: `
import type { Clock, RandomSource, Scheduler } from '../../ports/clock.js';

export function plan(clock: Clock, random: RandomSource, scheduler: Scheduler): unknown {
  const at = new Date(clock.now() + 1000);
  return scheduler.setTimeout(() => undefined, Math.floor(random.float() * 10) + at.getTime());
}
`,
    mustNotReport: [RULE],
  },
  {
    name: 'control: secrets generates keys and nonces with node:crypto',
    path: 'apps/server/src/secrets/__lint_canary__/nonce.ts',
    code: `
import { randomBytes } from 'node:crypto';

export const nonce = (): Buffer => randomBytes(24);
`,
    mustNotReport: [RULE],
  },
  {
    name: 'control: Phase A lifecycle code reads the clock directly (outside the scope)',
    path: 'apps/server/src/lifecycle/__lint_canary__/date-now.ts',
    code: `
export function started(): number {
  return Date.now();
}
`,
    mustNotReport: [RULE],
  },
] as const satisfies readonly CanaryCase[];
