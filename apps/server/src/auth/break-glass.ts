// `POST /api/v1/auth/break-glass` (P06, T-B-192, FR-B-521, EB-25, SC-B-010, CD-08, CD-11): the way back in
// when nobody can sign in with Entra. It exists only when `BREAK_GLASS_USERNAME` and
// `BREAK_GLASS_PASSWORD_HASH` are both set (the availability gate; otherwise the standard 404) and needs
// a pinned tenant (before that: 409 `setup_required`).
//
//   body     `BreakGlassRequest` (strict), at most 4,096 bytes; Origin and an anonymous CSRF token
//   work     `password-hash.ts`: always the same work, behind a one-slot queue (1 running, 2 waiting);
//            a fourth at once is 429 `break_glass_locked`
//   lock     5 failures per client in 15 minutes and 20 failures in an hour overall lock the route:
//            429 `break_glass_locked` with an integer `Retry-After`; a locked attempt is not verified
//            (so the right password does not get in either) and not audited
//   failure  401 `unauthenticated`, the same for an unknown user and a wrong password, with the
//            challenge; a failure inside the bound is audited (`breakglass.signin` denied, actor
//            anonymous, reason `invalid_credentials`); the username and the password are never
//            logged or audited
//   success  `break-glass-session.ts`
import { LIMITS } from '@m365portal/shared/limits';
import { BreakGlassRequestSchema, BreakGlassResponseSchema } from '@m365portal/shared/schemas/auth';
import { appendAudit } from '../audit/index.js';
import { withTransaction } from '../db/index.js';
import { WWW_AUTHENTICATE } from '../http/access-guard.js';
import { ProblemError, problemResponse } from '../http/problem.js';
import { defineRoute, type RouteDefinition } from '../http/route.js';
import { readTenantPin } from '../integrations/tenant-pin.js';
import type { Clock } from '../ports/clock.js';
import { issueBreakGlassSession } from './break-glass-session.js';
import type { AuthContext } from './context.js';
import {
  QueueFullError,
  createBoundedQueue,
  createBreakGlassVerifier,
  type BoundedQueue,
  type BreakGlassVerifier,
} from './password-hash.js';

const MINUTE_MS = 60_000;
/** A refused attempt because the line was full is told to wait this long. */
const BUSY_RETRY_SECONDS = 5;

export type AttemptResult =
  | { readonly kind: 'success' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'locked'; readonly retryAfterSeconds: number }
  | { readonly kind: 'busy'; readonly retryAfterSeconds: number };

export interface BreakGlassAttempts {
  attempt(clientKey: string, username: string, password: string): Promise<AttemptResult>;
  /** Forget the failures that have left their windows. */
  prune(): void;
}

export function createBreakGlassAttempts(options: {
  readonly clock: Clock;
  readonly verifier: BreakGlassVerifier;
  readonly queue?: BoundedQueue;
}): BreakGlassAttempts {
  const { breakGlass: limits } = LIMITS;
  const clientWindowMs = limits.failsPerClientWindowMinutes * MINUTE_MS;
  const globalWindowMs = limits.failsGlobalWindowMinutes * MINUTE_MS;
  const queue =
    options.queue ?? createBoundedQueue({ running: limits.queueRunning, waiting: limits.queueWaiting });
  /** Failure instants, oldest first, per client key; and overall. */
  const perClient = new Map<string, number[]>();
  let overall: number[] = [];

  function within(times: readonly number[], windowMs: number, now: number): number[] {
    return times.filter((time) => now - time < windowMs);
  }

  /** Seconds until fewer than `max` failures remain inside the window, or `undefined` when under it. */
  function retryAfter(times: readonly number[], max: number, windowMs: number, now: number): number | undefined {
    const live = within(times, windowMs, now);
    if (live.length < max) return undefined;
    const decisive = live[live.length - max] ?? now;
    return Math.max(1, Math.ceil((decisive + windowMs - now) / 1000));
  }

  function prune(): void {
    const now = options.clock.now();
    for (const [key, times] of perClient) {
      const live = within(times, clientWindowMs, now);
      if (live.length === 0) perClient.delete(key);
      else perClient.set(key, live);
    }
    overall = within(overall, globalWindowMs, now);
  }

  return {
    prune,
    async attempt(clientKey, username, password) {
      const now = options.clock.now();
      const waits = [
        retryAfter(perClient.get(clientKey) ?? [], limits.failsPerClient, clientWindowMs, now),
        retryAfter(overall, limits.failsGlobal, globalWindowMs, now),
      ].filter((wait): wait is number => wait !== undefined);
      if (waits.length > 0) return { kind: 'locked', retryAfterSeconds: Math.max(...waits) };

      let matches: boolean;
      try {
        matches = await queue.run(() => options.verifier.verify(username, password));
      } catch (failure) {
        if (failure instanceof QueueFullError) {
          return { kind: 'busy', retryAfterSeconds: BUSY_RETRY_SECONDS };
        }
        throw failure;
      }
      if (matches) return { kind: 'success' };

      const failedAt = options.clock.now();
      const mine = within(perClient.get(clientKey) ?? [], clientWindowMs, failedAt);
      mine.push(failedAt);
      perClient.delete(clientKey);
      perClient.set(clientKey, mine);
      if (perClient.size > LIMITS.trackedClients) {
        const oldest = perClient.keys().next();
        if (oldest.done !== true) perClient.delete(oldest.value);
      }
      overall = within(overall, globalWindowMs, failedAt);
      overall.push(failedAt);
      return { kind: 'invalid' };
    },
  };
}

/** The attempts of this process for the configured account; `undefined` when break-glass is not configured. */
export function createBreakGlass(ctx: AuthContext): BreakGlassAttempts | undefined {
  const configured = ctx.deps.config.breakGlass;
  if (configured === undefined) return undefined;
  return createBreakGlassAttempts({
    clock: { now: ctx.deps.now },
    verifier: createBreakGlassVerifier({
      username: configured.username,
      passwordHash: configured.passwordHash.reveal(),
    }),
  });
}

/**
 * The route is always in the table and in the OpenAPI document; the gate `breakGlass` decides whether
 * it exists for a request, and answers the standard 404 unless the account is configured.
 */
export function breakGlassRoute(
  ctx: AuthContext,
  attempts: BreakGlassAttempts | undefined,
): RouteDefinition {
  return defineRoute({
    id: 'auth.breakglass',
    method: 'POST',
    path: '/api/v1/auth/break-glass',
    access: { public: true },
    rateLimit: 'auth',
    availability: 'breakGlass',
    bodyLimit: LIMITS.body.authBytes,
    audit: 'breakglass.signin',
    summary: 'Break-glass sign-in',
    description:
      'Signs in with the break-glass account of the operator: a session that lasts 30 minutes and holds only rbac:manage. Exists only when the account is configured.',
    request: {
      body: { required: true, content: { 'application/json': { schema: BreakGlassRequestSchema } } },
    },
    responses: {
      200: {
        description: 'Signed in; navigate to `redirect`.',
        content: { 'application/json': { schema: BreakGlassResponseSchema } },
      },
      409: { description: 'No tenant is pinned yet (setup_required).' },
      429: { description: 'Locked after failed attempts, or the line is full (break_glass_locked).' },
    },
    handler: async (c, input) => {
      // The gate keeps this out of reach when the account is not configured; this is the second line.
      if (attempts === undefined) throw new ProblemError('not_found');
      const db = ctx.deps.requireDatabase();
      const pin = readTenantPin(db);
      if (pin === undefined) throw new ProblemError('setup_required');

      const result = await attempts.attempt(
        c.get('client').key,
        input.body.username,
        input.body.password,
      );
      if (result.kind === 'locked' || result.kind === 'busy') {
        const response = problemResponse(c, 'break_glass_locked');
        response.headers.set('Retry-After', String(result.retryAfterSeconds));
        return response;
      }
      if (result.kind === 'invalid') {
        const { address } = c.get('client');
        withTransaction(db, (tx) =>
          appendAudit(tx, {
            ts: new Date(ctx.deps.now()).toISOString(),
            actorKind: 'anonymous',
            actorId: 'anonymous',
            action: 'breakglass.signin',
            targetType: 'break_glass',
            outcome: 'denied',
            reasonCode: 'invalid_credentials',
            ...(address === undefined ? {} : { clientIp: address }),
            requestId: c.get('requestId'),
            detail: { reason: 'invalid_credentials' },
          }),
        );
        const response = problemResponse(c, 'unauthenticated');
        response.headers.set('WWW-Authenticate', WWW_AUTHENTICATE);
        return response;
      }
      return issueBreakGlassSession(ctx, c, pin.tenantId);
    },
  });
}
