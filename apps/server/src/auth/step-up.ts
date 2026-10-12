// Step-up (T-B-191, FR-B-411, US-B8 item 3): a recent sign-in with MFA for the actions that ask for
// it. Three parts:
//
//   the demand     a route with `access: { permission, stepUp: true }` answers 403 `step_up_required`
//                  (audited) to a user whose `step_up_at` is older than 10 minutes. That is the route
//                  wrapper's decision, from `Actor.stepUpFresh`; setup and break-glass are exempt.
//   the flow       `GET /auth/login?purpose=stepup` (login.ts): needs a user session, sends
//                  `prompt=login`, and keeps the hash of the session id in the transaction. No
//                  `max_age` and no `claims` (U13, U27).
//   the callback   `checkStepUp` below, then the MFA policy again, then the session id is rotated and
//                  `step_up_at` set (callback.ts). Any failure is audited `auth.stepup` denied. A
//                  tenant that never asks for MFA gives the explicit reason `mfa_required`, so the
//                  person sees why and is never looped.
import { STEPUP_CHECKS, type StepupCheck } from '@m365portal/shared/auth/signin-errors';
import type { SessionRecord } from '../policy/ports.js';
import type { ValidatedIdToken } from '../ports/identity.js';

/** An `auth_time` earlier than the start of the transaction minus this is stale (FR-B-411). */
export const AUTH_TIME_SKEW_SECONDS = 60;

export type StepUpVerdict =
  { readonly ok: true } | { readonly ok: false; readonly check: StepupCheck };

/**
 * The checks of the step-up callback that the ID-token validator does not make: the same person
 * (`oid`), and an `auth_time` that proves the sign-in happened for this transaction.
 */
export function checkStepUp(input: {
  readonly token: ValidatedIdToken;
  readonly sessionOid: string;
  /** Milliseconds since the epoch at which the login transaction started. */
  readonly startedAt: number;
}): StepUpVerdict {
  if (input.token.oid.toLowerCase() !== input.sessionOid.toLowerCase()) {
    return { ok: false, check: 'oid_mismatch' };
  }
  const { authTime } = input.token;
  if (authTime === null) return { ok: false, check: 'auth_time_missing' };
  if (authTime * 1000 < input.startedAt - AUTH_TIME_SKEW_SECONDS * 1000) {
    return { ok: false, check: 'auth_time_stale' };
  }
  return { ok: true };
}

/** Is a session row still live (the resolver's rule, for a caller that holds only the hash)? */
export function isLiveUserSession(
  record: SessionRecord,
  now: number,
  idleTimeoutMs: number,
): boolean {
  if (record.kind !== 'user') return false;
  if (!(now < Date.parse(record.absoluteExpiresAt))) return false;
  return now < Date.parse(record.lastSeenAt) + idleTimeoutMs;
}

export { STEPUP_CHECKS };
