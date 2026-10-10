// Stage 1 of the request pipeline (plan 7.2): the request id, the client and the effective scheme,
// and the typed variables every later stage reads from the Hono context.
//
// The request id (FR-A-024) is used only if it has the shape the pattern allows; anything else is
// replaced, never repaired, so a hostile `X-Request-Id` cannot reach a log line, a header or an
// audit entry. It is on every response, which is why it is written after the handler has run: that
// also covers the responses the error handler and the not-found handler produce.
import { randomUUID } from 'node:crypto';
import type { HttpBindings } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { RequestIdSchema } from '@m365portal/shared/schemas/common';
import type { Context, MiddlewareHandler } from 'hono';
import type { AppConfig } from '../config/env.js';
import { clientKeyOf } from './client-key.js';
import { createForwardingResolver, effectiveScheme } from './trust-proxy.js';

/** Who sent the request, as far as the forwarding rules allow us to say. */
export interface ClientIdentity {
  /** The canonical address, or `undefined` when the request has no socket (an in-process call). */
  readonly address: string | undefined;
  /** The rate-limit key: the IPv4 address, the IPv6 /64 prefix, or `unknown`. */
  readonly key: string;
}

/** The variables later stages read with `c.get(...)`. Later tasks add to this interface. */
export interface AppVariables {
  readonly requestId: string;
  readonly client: ClientIdentity;
  readonly scheme: 'http' | 'https';
  /** The reading of the injected clock when the request began, in milliseconds. */
  readonly startedAtMs: number;
  /**
   * The CSP nonce of this request: drawn on first use, the same value every time. Set by
   * `securityHeaders` (T-A-028), so a handler that renders a page can call it only when that
   * middleware ran before it; the header and the page then carry the same nonce.
   */
  readonly nonce: () => string;
}

export interface AppEnv {
  Bindings: HttpBindings;
  Variables: AppVariables;
}

export function generateRequestId(): string {
  return randomUUID();
}

/**
 * The id to use for a request: the inbound one when it matches `^[A-Za-z0-9-]{8,64}$` (the pattern
 * of `RequestIdSchema`, the only place it is written down), otherwise a new one.
 */
export function resolveRequestId(
  inbound: string | null | undefined,
  generate: () => string = generateRequestId,
): string {
  if (typeof inbound === 'string' && RequestIdSchema.safeParse(inbound).success) return inbound;
  return generate();
}

/** The remote address of the socket, or `undefined` when the request did not arrive on one. */
export function peerAddressOf(c: Context): string | undefined {
  try {
    const address = getConnInfo(c).remote.address;
    return typeof address === 'string' && address !== '' ? address : undefined;
  } catch {
    // An in-process request (`app.request`) has no `incoming` message to read.
    return undefined;
  }
}

/**
 * Set headers on the response that is about to leave, whatever produced it. A response returned by
 * a handler may have immutable headers (`Response.redirect`, a proxied `fetch`), so the first
 * header goes through Hono's `c.header`, which rewraps a finished response, and the rest follow on
 * the rewrapped one. A value of `undefined` removes the header.
 */
export function setResponseHeaders(
  c: Context,
  headers: Readonly<Record<string, string | undefined>>,
): void {
  const entries = Object.entries(headers);
  const first = entries[0];
  if (first === undefined) return;
  c.header(first[0], first[1]);
  const target = c.res.headers;
  for (const [name, value] of entries.slice(1)) {
    if (value === undefined) target.delete(name);
    else target.set(name, value);
  }
}

export interface RequestContextOptions {
  readonly config: Pick<AppConfig, 'trustProxy' | 'publicIsHttps'>;
  /** The clock for `startedAtMs`, in milliseconds. Default: a monotonic clock. */
  readonly now?: () => number;
  /** For tests: the source of new request ids. */
  readonly generateId?: () => string;
}

export function requestContext(options: RequestContextOptions): MiddlewareHandler<AppEnv> {
  const forwarding = createForwardingResolver(options.config.trustProxy);
  const now = options.now ?? ((): number => performance.now());
  const generate = options.generateId ?? generateRequestId;

  return async (c, next) => {
    const requestId = resolveRequestId(c.req.header('x-request-id'), generate);
    const resolved = forwarding({
      peer: peerAddressOf(c),
      forwardedFor: c.req.header('x-forwarded-for'),
      forwardedProto: c.req.header('x-forwarded-proto'),
    });
    c.set('requestId', requestId);
    c.set('client', { address: resolved.address, key: clientKeyOf(resolved.address) });
    c.set(
      'scheme',
      effectiveScheme({
        publicIsHttps: options.config.publicIsHttps,
        forwardedScheme: resolved.scheme,
      }),
    );
    c.set('startedAtMs', now());

    await next();

    setResponseHeaders(c, { 'X-Request-Id': requestId });
  };
}
