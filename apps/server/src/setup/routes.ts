// The setup routes P10 to P18 (T-B-139, FR-B-201 to FR-B-207, FR-B-212, FR-B-219; contract section 5).
//
//   P10 setup.status       GET    /api/v1/setup/status        public behind the gate, class `setup`
//   P11 setup.unlock       POST   /api/v1/setup/unlock        public behind the gate, class `setup`
//   P12 setup.session.end  DELETE /api/v1/setup/session
//   P13 setup.state        GET    /api/v1/setup/state
//   P14 setup.environment  POST   /api/v1/setup/environment
//   P15 setup.manual       PUT    /api/v1/setup/manual
//   P16 setup.certificate  GET    /api/v1/setup/certificate.cer
//   P17 setup.groups       GET    /api/v1/setup/groups?q=
//   P18 setup.finish       POST   /api/v1/setup/finish
//
// Every route carries `availability: 'setupOpen'`: once the state is `completed` (or over a plain-http
// base URL, from a request the loopback guard refuses) it does not exist and the standard 404 answers.
// Order inside P11, after the wrapper's gate, rate class, Origin and CSRF and the body parse: lock
// check, compare, bookkeeping. The token is read from the body and nowhere else, and it is never logged,
// audited or echoed.
import {
  FinishRequestSchema,
  FinishResponseSchema,
  GROUP_SEARCH_MAX_RESULTS,
  GroupSearchQuerySchema,
  GroupSearchResponseSchema,
  EnvironmentResultSchema,
  ManualRequestSchema,
  ManualResponseSchema,
  SetupStateResponseSchema,
  SetupStatusResponseSchema,
  UnlockRequestSchema,
  UnlockResponseSchema,
} from '@m365portal/shared/schemas/setup';
import { LIMITS } from '@m365portal/shared/limits';
import { z } from 'zod';
import { appendAudit } from '../audit/index.js';
import { clearCookie, setCookie } from '../auth/cookies.js';
import { withTransaction } from '../db/index.js';
import { defineRoute, type RouteDefinition } from '../http/route.js';
import { ProblemError, problemResponse } from '../http/problem.js';
import { hashSessionId } from '../policy/session-hash.js';
import { runEnvironmentChecks } from './environment.js';
import { finishSetup } from './finish.js';
import { appGraphOf, searchBeheerderGroups } from './groups.js';
import { auditContextOf, problemAnswer, runActorOf, withHeader } from './http-support.js';
import { applyManualInputs, manualCertificateFile, prepareManualCertificate } from './manual-mode.js';
import type { SetupRuntime } from './runtime.js';
import { setupStateView } from './view.js';

const EmptyBodySchema = z.strictObject({}).meta({ id: 'SetupEmptyRequest' });
const body = <Schema extends z.ZodType>(schema: Schema) =>
  ({ required: true, content: { 'application/json': { schema } } }) as const;

export function setupRoutes(runtime: SetupRuntime): RouteDefinition[] {
  const { services, engine, unlockLimiter, deps } = runtime;
  const publicOrigin = deps.config.publicOrigin;

  const gate = { availability: 'setupOpen' } as const;
  const busy = (): boolean => engine.busy();
  const secretsProblems = {
    503: problemAnswer('Storage or the secrets are unavailable.'),
  } as const;

  return [
    defineRoute({
      id: 'setup.status',
      method: 'GET',
      path: '/api/v1/setup/status',
      access: { public: true },
      rateLimit: 'setup',
      ...gate,
      summary: 'The setup state',
      description:
        'Public, behind the setup gate. The state and whether a setup token is needed; nothing else.',
      responses: {
        200: {
          description: 'The state.',
          content: { 'application/json': { schema: SetupStatusResponseSchema } },
        },
        ...secretsProblems,
      },
      handler: (c) => {
        const db = deps.requireDatabase();
        const state = services.state.read(db).state;
        return c.json({ state, tokenRequired: c.get('actor').kind !== 'setup' }, 200);
      },
    }),

    defineRoute({
      id: 'setup.unlock',
      method: 'POST',
      path: '/api/v1/setup/unlock',
      access: { public: true },
      rateLimit: 'setup',
      ...gate,
      bodyLimit: LIMITS.body.authBytes,
      audit: 'setup.unlock',
      summary: 'Unlock the setup wizard',
      description:
        'Compares the setup token and opens a setup session (cookie). Failures are counted per client address and overall; a lock refuses even a correct token.',
      request: { body: body(UnlockRequestSchema) },
      responses: {
        200: {
          description: 'Unlocked; the setup cookie is set.',
          content: { 'application/json': { schema: UnlockResponseSchema } },
        },
        401: problemAnswer('The token is not right.'),
        409: problemAnswer('The wizard is finished and waits for the first sign-in.'),
        429: problemAnswer('Too many attempts; the delay is in Retry-After.'),
        ...secretsProblems,
      },
      handler: (c, input) => {
        const db = deps.requireDatabase();
        const audit = auditContextOf(c);
        const key = c.get('client').key;

        // A finished wizard has nothing to unlock; this answers before the token is compared.
        if (services.state.read(db).state === 'awaiting_first_signin') {
          throw new ProblemError('setup_step_not_ready');
        }

        const lock = unlockLimiter.check(key);
        if (lock.locked) {
          return withHeader(
            problemResponse(c, 'setup_token_locked'),
            'Retry-After',
            String(lock.retryAfterSeconds),
          );
        }

        if (!services.token.verify(input.body.token)) {
          const started = unlockLimiter.failure(key);
          for (const start of started) {
            withTransaction(db, (tx) => {
              appendAudit(tx, {
                ts: new Date(deps.now()).toISOString(),
                actorKind: 'anonymous',
                actorId: 'anonymous',
                action: 'setup.unlock',
                targetType: 'setup',
                outcome: 'denied',
                reasonCode: 'setup_token_locked',
                ...(audit.clientIp === undefined ? {} : { clientIp: audit.clientIp }),
                requestId: audit.requestId,
                detail: { reason: 'setup_token_locked', lockScope: start.scope },
              });
            });
            services.log.warn({ event: 'setup_unlock_locked', lockScope: start.scope }, 'setup_unlock_locked');
          }
          return problemResponse(c, 'setup_token_invalid');
        }

        const created = services.sessions.create();
        try {
          withTransaction(db, (tx) => {
            services.state.apply(tx, 'unlock');
            services.steps.ensureRows(tx, services.state.read(tx).mode);
            appendAudit(tx, {
              ts: new Date(deps.now()).toISOString(),
              actorKind: 'setup',
              actorId: 'setup',
              action: 'setup.unlock',
              targetType: 'setup',
              outcome: 'success',
              ...(audit.clientIp === undefined ? {} : { clientIp: audit.clientIp }),
              requestId: audit.requestId,
            });
          });
        } catch (error) {
          services.sessions.end(hashSessionId(created.id));
          throw error;
        }
        const headers = new Headers({ 'Content-Type': 'application/json' });
        setCookie(headers, 'setup', created.id, publicOrigin);
        return new Response(JSON.stringify({ state: 'in_progress' }), { status: 200, headers });
      },
    }),

    defineRoute({
      id: 'setup.session.end',
      method: 'DELETE',
      path: '/api/v1/setup/session',
      access: { setup: true },
      rateLimit: 'write',
      ...gate,
      summary: 'End the setup session',
      description:
        'Ends this setup session at once and clears the cookie. When it was the last live session, the bootstrap object is discarded.',
      responses: { 204: { description: 'Ended.' } },
      handler: (c) => {
        const hash = c.get('actor').setupSession?.idHash;
        if (hash !== undefined) services.sessions.end(hash);
        const headers = new Headers();
        clearCookie(headers, 'setup', publicOrigin);
        return new Response(null, { status: 204, headers });
      },
    }),

    defineRoute({
      id: 'setup.state',
      method: 'GET',
      path: '/api/v1/setup/state',
      access: { setup: true },
      rateLimit: 'read',
      ...gate,
      summary: 'Everything the wizard shows when it loads',
      description:
        'The state, the five steps, the tenant, the application, the certificate, the designated Owner and the proof. Afterwards the page polls the run snapshot.',
      responses: {
        200: {
          description: 'The wizard state.',
          content: { 'application/json': { schema: SetupStateResponseSchema } },
        },
        ...secretsProblems,
      },
      handler: async (c) => {
        const hash = c.get('actor').setupSession?.idHash;
        const info = hash === undefined ? undefined : services.sessions.info(hash);
        const nowIso = new Date(deps.now()).toISOString();
        const view = await setupStateView(services, {
          idleExpiresAt: info?.idleExpiresAt ?? nowIso,
          absoluteExpiresAt: info?.absoluteExpiresAt ?? nowIso,
        });
        return c.json(view, 200);
      },
    }),

    defineRoute({
      id: 'setup.environment',
      method: 'POST',
      path: '/api/v1/setup/environment',
      access: { setup: true },
      rateLimit: 'write',
      ...gate,
      audit: 'setup.step.run',
      summary: 'Run the environment checks',
      description: 'The six checks of step 1; stores the step rows.',
      request: { body: body(EmptyBodySchema) },
      responses: {
        200: {
          description: 'The result.',
          content: { 'application/json': { schema: EnvironmentResultSchema } },
        },
        409: problemAnswer('A run is active.'),
        ...secretsProblems,
      },
      handler: async (c) => {
        if (busy()) throw new ProblemError('setup_step_busy');
        const result = await runEnvironmentChecks(services, runActorOf(c));
        return c.json(result, 200);
      },
    }),

    defineRoute({
      id: 'setup.manual',
      method: 'PUT',
      path: '/api/v1/setup/manual',
      access: { setup: true },
      rateLimit: 'write',
      ...gate,
      audit: 'setup.step.run',
      summary: 'Manual provisioning mode',
      description:
        'Stores the application id, the tenant id and the first Owner of a tenant a person configured by hand. The first Owner is resolved with the application\'s own token.',
      request: { body: body(ManualRequestSchema) },
      responses: {
        200: {
          description: 'Stored.',
          content: { 'application/json': { schema: ManualResponseSchema } },
        },
        409: problemAnswer('Not ready, busy, or another tenant is pinned.'),
        422: problemAnswer('The values are not valid, or the first Owner does not exist.'),
        503: problemAnswer('The application could not get a token yet, or storage or secrets are unavailable.'),
      },
      handler: async (c, input) => {
        const result = await applyManualInputs({ services, busy, actor: runActorOf(c) }, input.body);
        return c.json(result, 200);
      },
    }),

    defineRoute({
      id: 'setup.certificate',
      method: 'GET',
      path: '/api/v1/setup/certificate.cer',
      access: { setup: true },
      rateLimit: 'read',
      ...gate,
      summary: 'Download the public certificate',
      description:
        'The public certificate (pending, else active) as DER. It is generated and sealed on the first request while the wizard is open. No private material is ever in the body.',
      responses: {
        200: {
          description: 'The certificate.',
          content: { 'application/x-x509-ca-cert': { schema: z.string().meta({ format: 'binary' }) } },
        },
        409: problemAnswer('The wizard is not at the point where a certificate exists.'),
        ...secretsProblems,
      },
      handler: async (c) => {
        if (services.state.read(deps.requireDatabase()).state !== 'in_progress') {
          throw new ProblemError('setup_step_not_ready');
        }
        await prepareManualCertificate(services, runActorOf(c));
        const file = manualCertificateFile(services);
        if (file === undefined) throw new ProblemError('setup_step_not_ready');
        return new Response(new Uint8Array(file.der), {
          status: 200,
          headers: {
            'Content-Type': 'application/x-x509-ca-cert',
            'Content-Disposition': `attachment; filename="${file.filename}"`,
            'Cache-Control': 'no-store',
          },
        });
      },
    }),

    defineRoute({
      id: 'setup.groups',
      method: 'GET',
      path: '/api/v1/setup/groups',
      access: { setup: true },
      rateLimit: 'read',
      ...gate,
      summary: 'Search Entra groups',
      description: 'For the optional Beheerder group: groups whose name starts with `q`, at most 25.',
      request: { query: GroupSearchQuerySchema },
      responses: {
        200: {
          description: 'The groups.',
          content: { 'application/json': { schema: GroupSearchResponseSchema } },
        },
        409: problemAnswer('The connection is not verified yet.'),
        422: problemAnswer('The query is not valid.'),
        503: problemAnswer('Graph or the secrets are unavailable.'),
      },
      handler: async (c, input) => {
        const found = await searchBeheerderGroups(appGraphOf(deps), input.query.q, GROUP_SEARCH_MAX_RESULTS);
        const groups = found.flatMap((group) =>
          group.displayName === null || group.displayName === ''
            ? []
            : [{ id: group.id, displayName: group.displayName.slice(0, 120) }],
        );
        return c.json({ groups }, 200);
      },
    }),

    defineRoute({
      id: 'setup.finish',
      method: 'POST',
      path: '/api/v1/setup/finish',
      access: { setup: true },
      rateLimit: 'write',
      ...gate,
      audit: 'setup.step.run',
      summary: 'Finish the wizard',
      description:
        'Creates the first Owner assignment for the confirmed person, the optional Beheerder group assignment and the language, in one transaction, and moves the state to awaiting_first_signin.',
      request: { body: body(FinishRequestSchema) },
      responses: {
        200: {
          description: 'Finished.',
          content: { 'application/json': { schema: FinishResponseSchema } },
        },
        409: problemAnswer('A step has not ended well, a run is active, or the wizard already finished.'),
        422: problemAnswer('The confirmation names someone else, or the group is unknown.'),
        503: problemAnswer('Graph, storage or the secrets are unavailable.'),
      },
      handler: async (c, input) => {
        const result = await finishSetup(
          { services, busy, actor: runActorOf(c) },
          input.body,
          auditContextOf(c),
        );
        return c.json(result, 200);
      },
    }),
  ];
}
