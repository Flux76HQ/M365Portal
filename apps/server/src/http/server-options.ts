// The options of the Node HTTP server, set explicitly (FR-A-025, plan 7.1 step 9). Node's defaults
// are not the limits of this application, and a default nobody wrote down is a default nobody
// reviews. All four numbers come from `LIMITS.http`.
//
//   maxHeaderSize      the header block of a request, request line included: over it Node answers 431
//   headersTimeout     time to receive the complete header block
//   requestTimeout     time to receive the complete request, body included: over it Node answers 408
//   keepAliveTimeout   idle time of a kept-alive connection; above the 60 s idle timeout of a proxy
//                      in front, so the proxy closes first and never reuses a connection we closed
//
// The responses Node writes itself for a malformed request (400), a header block that is too large
// (431) and a request that is too slow (408) are the one documented exception to FR-A-040: they are
// written before the application sees the request, carry `Connection: close`, have no body and no
// `Server` header. `docs/security.md` says so.
import type { ServerOptions } from 'node:http';
import { LIMITS } from '@m365portal/shared/limits';

/**
 * How often Node looks for connections that have outrun the two timeouts above. Node's default is
 * 30 s, which would let a client that trickles its headers hold a socket for up to 45 s instead of
 * 15. A check is a pass over the open connections and costs next to nothing.
 */
export const CONNECTIONS_CHECKING_INTERVAL_MS = 5_000;

export interface NodeServerLimits {
  readonly maxHeaderSize: number;
  readonly headersTimeout: number;
  readonly requestTimeout: number;
  readonly keepAliveTimeout: number;
  readonly connectionsCheckingInterval: number;
}

/**
 * The options for `createServer` (and for `serve({ serverOptions })` of `@hono/node-server`).
 * `overrides` is for tests that need a timeout of a few hundred milliseconds; the server never
 * passes any.
 */
export function nodeServerOptions(overrides: Partial<NodeServerLimits> = {}): ServerOptions {
  return {
    maxHeaderSize: LIMITS.http.headerBytes,
    headersTimeout: LIMITS.http.headersTimeoutMs,
    requestTimeout: LIMITS.http.requestTimeoutMs,
    keepAliveTimeout: LIMITS.http.keepAliveTimeoutMs,
    connectionsCheckingInterval: CONNECTIONS_CHECKING_INTERVAL_MS,
    ...overrides,
  };
}
