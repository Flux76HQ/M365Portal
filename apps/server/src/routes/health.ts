// Health routes (contract R1 and R2, FR-A-026): liveness and readiness.
//
// `/healthz` says the process is running, also in degraded mode, and asks nothing of storage.
// `/readyz` says whether the application can do its job: the data directory is writable, the
// database is open, the schema is the one this build expects. Both are public, `no-store` and exempt
// from rate limiting (and from CSRF, which only a write meets), because the Docker HEALTHCHECK and a
// load balancer call them every few seconds. Neither says anything but a status, the version and
// named checks with a stable failure code: raw error text never leaves the process.
//
// What decides readiness (the write-and-delete probe, the 2-second cache, the failure codes) is the
// lifecycle module (T-A-044); this file consumes it through the `Readiness` interface.
import { HealthzResponseSchema, ReadyzResponseSchema } from '@m365portal/shared/schemas/health';
import { z } from 'zod';
import { defineRoute, type RouteDefinition } from '../http/route.js';

type ReadyzResponse = z.output<typeof ReadyzResponseSchema>;

/** What a readiness check returns: the document of `/readyz`, read-only. */
export interface ReadinessResult {
  readonly status: ReadyzResponse['status'];
  readonly checks: readonly Readonly<ReadyzResponse['checks'][number]>[];
}

/**
 * Whether the application is ready, as three named checks. The implementation never throws for a
 * failing check (that is a result); the answer may be cached by the implementation, which is why the
 * route asks it on every request and keeps nothing itself.
 */
export interface Readiness {
  check(): ReadinessResult | Promise<ReadinessResult>;
}

export interface HealthRoutesDeps {
  /** The build-time version (`VERSION`), the same constant every other surface shows. */
  readonly version: string;
  readonly readiness: Readiness;
}

export function healthRoutes(deps: HealthRoutesDeps): RouteDefinition[] {
  return [
    defineRoute({
      id: 'health.live',
      method: 'GET',
      path: '/healthz',
      access: { public: true },
      rateLimit: 'exempt',
      summary: 'Liveness',
      description: 'The process is running. Answers in every mode, degraded mode included.',
      responses: {
        200: {
          description: 'The process is running.',
          content: { 'application/json': { schema: HealthzResponseSchema } },
        },
      },
      handler: (c) => c.json({ status: 'ok' as const, version: deps.version }, 200),
    }),
    defineRoute({
      id: 'health.ready',
      method: 'GET',
      path: '/readyz',
      access: { public: true },
      rateLimit: 'exempt',
      summary: 'Readiness',
      description:
        'Database open, schema at the expected version, data directory writable. Failing checks carry a stable code and never raw error text.',
      responses: {
        200: {
          description: 'Every check passed.',
          content: { 'application/json': { schema: ReadyzResponseSchema } },
        },
        503: {
          description: 'At least one check failed; the body says which, with a code.',
          content: { 'application/json': { schema: ReadyzResponseSchema } },
        },
      },
      handler: async (c) => {
        const result = await deps.readiness.check();
        return c.json(result, result.status === 'ready' ? 200 : 503);
      },
    }),
  ];
}
