// The connection routes P19 to P26 (T-B-139, FR-B-220, SB-19; contract section 6). Access `connection`:
// the setup actor while the wizard is open, afterwards a signed-in user holding `settings:connection`;
// the routes that change something need a step-up from a user (the setup actor is exempt).
//
//   P19 connection.get                GET  /api/v1/connection
//   P20 connection.log                GET  /api/v1/connection/log?after=&limit=        slidesSession false
//   P21 connection.runs.start         POST /api/v1/connection/runs                     step-up
//   P22 connection.runs.current       GET  /api/v1/connection/runs/current?after=      slidesSession false
//   P23 connection.runs.retry.now     POST /api/v1/connection/runs/current/retry-now   step-up
//   P24 connection.runs.cancel        POST /api/v1/connection/runs/current/cancel      step-up
//   P25 connection.adopt              POST /api/v1/connection/adopt                    step-up
//   P26 connection.verify             POST /api/v1/connection/verify                   step-up
//
// The runner is the engine's: one run at a time for the wizard and for these routes. A run request
// returns at once with 202; the progress is the one polled channel P22.
import {
  AdoptRequestSchema,
  ConnectionResponseSchema,
  LogPageSchema,
  LogQuerySchema,
  ProofSchema,
  RunSnapshotQuerySchema,
  RunSnapshotSchema,
  RunStatusSchema,
  StartRunRequestSchema,
  logQueryOf,
} from '@m365portal/shared/schemas/connection';
import { z } from 'zod';
import { defineRoute, type RouteDefinition } from '../http/route.js';
import { auditContextOf, problemAnswer, runActorOf } from '../setup/http-support.js';
import type { SetupRuntime } from '../setup/runtime.js';
import { connectionSnapshot, verifyConnection } from './service.js';

const EmptyBodySchema = z.strictObject({}).meta({ id: 'ConnectionEmptyRequest' });
const body = <Schema extends z.ZodType>(schema: Schema) =>
  ({ required: true, content: { 'application/json': { schema } } }) as const;

const RUNS_PATH = '/api/v1/connection/runs';
const CURRENT_PATH = `${RUNS_PATH}/current`;

export function connectionRoutes(runtime: SetupRuntime): RouteDefinition[] {
  const { services, engine, deps } = runtime;
  const afterOf = (query: { readonly after?: string | undefined }): number =>
    query.after === undefined ? 0 : Number(query.after);

  return [
    defineRoute({
      id: 'connection.get',
      method: 'GET',
      path: '/api/v1/connection',
      access: { connection: true },
      rateLimit: 'read',
      summary: 'The connection to Microsoft 365',
      description:
        'The tenant, the application, the certificate with its days left and level, the secrets status and the proof. No secret is in it.',
      responses: {
        200: {
          description: 'The connection.',
          content: { 'application/json': { schema: ConnectionResponseSchema } },
        },
        503: problemAnswer('Storage is unavailable.'),
      },
      handler: (c) => c.json(connectionSnapshot(runtime), 200),
    }),

    defineRoute({
      id: 'connection.log',
      method: 'GET',
      path: '/api/v1/connection/log',
      access: { connection: true },
      rateLimit: 'read',
      slidesSession: false,
      summary: 'The setup log, paged',
      description: 'Lines after `after`, at most `limit`. Only the newest 1,000 lines are kept.',
      request: { query: LogQuerySchema },
      responses: {
        200: { description: 'A page.', content: { 'application/json': { schema: LogPageSchema } } },
        422: problemAnswer('The query is not valid.'),
        503: problemAnswer('Storage is unavailable.'),
      },
      handler: (c, input) => {
        const { after, limit } = logQueryOf(input.query);
        return c.json(services.wizardLog.read(deps.requireDatabase(), { after, limit }), 200);
      },
    }),

    defineRoute({
      id: 'connection.runs.start',
      method: 'POST',
      path: RUNS_PATH,
      access: { connection: true, stepUp: true },
      rateLimit: 'write',
      summary: 'Start a run',
      description:
        'Starts a background run in this process and answers at once. `steps` is an ordered subset of connect, configure and verify, or the word repair.',
      request: { body: body(StartRunRequestSchema) },
      responses: {
        202: {
          description: 'Started.',
          content: { 'application/json': { schema: RunStatusSchema } },
        },
        409: problemAnswer('A run is active, a step has not succeeded, or the tenant differs.'),
        422: problemAnswer('The request is not valid.'),
        503: problemAnswer('Storage or the secrets are unavailable.'),
      },
      handler: (c, input) => {
        const request = input.body;
        const status = engine.start(
          request.steps === 'repair'
            ? {
                kind: 'repair',
                mode: 'reconcile',
                steps: ['connect', 'configure', 'verify'],
                tenantHint: request.tenantHint,
                applicationName: request.applicationName,
                exchangeRole: request.exchangeRole,
              }
            : {
                kind: 'setup',
                mode: request.mode,
                steps: request.steps,
                tenantHint: request.tenantHint,
                applicationName: request.applicationName,
                exchangeRole: request.exchangeRole,
              },
          runActorOf(c),
        );
        return c.json(status, 202, { Location: CURRENT_PATH });
      },
    }),

    defineRoute({
      id: 'connection.runs.current',
      method: 'GET',
      path: CURRENT_PATH,
      access: { connection: true },
      rateLimit: 'read',
      slidesSession: false,
      summary: 'The current run, the steps, the device code and the new log lines',
      description:
        'The one polled channel. With no run since the process began the answer is 200 with run: null.',
      request: { query: RunSnapshotQuerySchema },
      responses: {
        200: {
          description: 'The snapshot.',
          content: { 'application/json': { schema: RunSnapshotSchema } },
        },
        422: problemAnswer('The query is not valid.'),
        503: problemAnswer('Storage is unavailable.'),
      },
      handler: (c, input) => c.json(engine.snapshot(afterOf(input.query)), 200),
    }),

    defineRoute({
      id: 'connection.runs.retry.now',
      method: 'POST',
      path: `${CURRENT_PATH}/retry-now`,
      access: { connection: true, stepUp: true },
      rateLimit: 'write',
      summary: 'Retry the current wait now',
      description: 'Wakes the current wait at once; the attempt counts.',
      request: { body: body(EmptyBodySchema) },
      responses: {
        202: {
          description: 'Woken.',
          content: { 'application/json': { schema: RunStatusSchema } },
        },
        409: problemAnswer('No run, or none is waiting.'),
      },
      handler: (c) => c.json(engine.retryNow(), 202),
    }),

    defineRoute({
      id: 'connection.runs.cancel',
      method: 'POST',
      path: `${CURRENT_PATH}/cancel`,
      access: { connection: true, stepUp: true },
      rateLimit: 'write',
      summary: 'Cancel the current run',
      description:
        'Sets the cancel flag; the runner stops at its next checkpoint, discards the bootstrap object and releases the lease.',
      request: { body: body(EmptyBodySchema) },
      responses: {
        202: {
          description: 'Cancelling.',
          content: { 'application/json': { schema: RunStatusSchema } },
        },
        409: problemAnswer('No run.'),
      },
      handler: (c) => c.json(engine.cancel(), 202),
    }),

    defineRoute({
      id: 'connection.adopt',
      method: 'POST',
      path: '/api/v1/connection/adopt',
      access: { connection: true, stepUp: true },
      rateLimit: 'write',
      summary: 'Adopt an existing application',
      description:
        "Explicit confirmation to adopt an application that has the wizard's name but not our install tag. Valid only while the current run waits for it.",
      request: { body: body(AdoptRequestSchema) },
      responses: {
        200: {
          description: 'The run continues.',
          content: { 'application/json': { schema: RunStatusSchema } },
        },
        409: problemAnswer('Nothing to adopt.'),
        422: problemAnswer('The confirmation is not valid.'),
      },
      handler: (c, input) =>
        c.json(
          engine.adopt({
            objectId: input.body.objectId,
            acknowledgeForeign: input.body.acknowledgeForeign === true,
          }),
          200,
        ),
    }),

    defineRoute({
      id: 'connection.verify',
      method: 'POST',
      path: '/api/v1/connection/verify',
      access: { connection: true, stepUp: true },
      rateLimit: 'write',
      audit: 'connection.verify',
      summary: 'Verify the connection now',
      description:
        'Re-runs the app-only checks with fresh tokens, in 60 seconds at most, and replaces the app-only items of the proof.',
      request: { body: body(EmptyBodySchema) },
      responses: {
        200: {
          description: 'The proof.',
          content: { 'application/json': { schema: ProofSchema } },
        },
        409: problemAnswer('A run is active, or the connection is not set up.'),
        503: problemAnswer('Graph throttles, or storage or the secrets are unavailable.'),
      },
      handler: async (c) =>
        c.json(await verifyConnection(runtime, runActorOf(c), auditContextOf(c)), 200),
    }),
  ];
}
