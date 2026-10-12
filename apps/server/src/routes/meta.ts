// Metadata routes (contract R3, R4 and R5, FR-A-021, FR-A-027): the OpenAPI document, who the client
// is and what it may do, and the CSRF token. With `/healthz`, `/readyz` and `/robots.txt` these are
// the whole set of routes that need no storage and answer in degraded mode as well. `/api/v1/meta`
// and `/api/v1/session` are not created (`/session` is reserved for Phase B).
//
// Nothing in the request selects the actor: `/api/v1/me` reports the one the pipeline resolved from
// the cookies (FR-B-413), formatted by `auth/me.ts`, the same builder the HTML shell uses for its boot
// data (SB-38). There is no preview flag any more (FR-B-102).
import { LIMITS } from '@m365portal/shared/limits';
import { CsrfResponseSchema, MeResponseSchema } from '@m365portal/shared/schemas/meta';
import { z } from 'zod';
import { createMeBuilder, type MeBuilder, type MeSources } from '../auth/me.js';
import type { Csrf } from '../http/csrf.js';
import type { DocumentSource } from '../http/openapi.js';
import { defineRoute, type RouteContext, type RouteDefinition } from '../http/route.js';

/** The OpenAPI document is large and fully described by the OpenAPI meta-schema, not by Zod. */
const OpenApiDocumentSchema = z
  .looseObject({ openapi: z.string() })
  .meta({ id: 'OpenApiDocument' });

export interface MetaRoutesDeps {
  readonly version: string;
  /** The serialised origin of `PUBLIC_BASE_URL`. */
  readonly publicOrigin: string;
  /** The `SHOWCASE` variable. */
  readonly showcase: boolean;
  /** False in degraded mode. Read on every request: storage can come and go. */
  readonly storageAvailable: () => boolean;
  readonly csrf: Csrf;
  /**
   * What `GET /api/v1/me` needs beyond the four fields above: the database (roles and setup state),
   * the clock, the idle timeout and the break-glass flag. The application passes them (`meSourcesOf`);
   * a fixture that leaves them out gets an answer without roles and with the setup state `unconfigured`.
   */
  readonly me?: Partial<
    Pick<MeSources, 'database' | 'now' | 'idleTimeoutMs' | 'breakGlass' | 'adminConsentUrl'>
  >;
  /** The CSRF binding of the cookies the browser sent (FR-B-408). */
  readonly binding?: (c: RouteContext) => string;
  /** The document, generated once the routes are registered. */
  readonly document: DocumentSource;
}

export function metaRoutes(deps: MetaRoutesDeps): RouteDefinition[] {
  const buildMe: MeBuilder = createMeBuilder({
    version: deps.version,
    publicOrigin: deps.publicOrigin,
    showcase: deps.showcase,
    storageAvailable: deps.storageAvailable,
    database: () => undefined,
    now: () => 0,
    idleTimeoutMs: LIMITS.session.idleTimeoutMinutes.default * 60_000,
    breakGlass: false,
    ...deps.me,
  });
  return [
    defineRoute({
      id: 'meta.openapi',
      method: 'GET',
      path: '/api/v1/openapi.json',
      access: { public: true },
      rateLimit: 'read',
      summary: 'The OpenAPI 3.1 document of this API',
      description:
        'Generated from the route definitions that enforce the rules; built once at start.',
      responses: {
        200: {
          description: 'The OpenAPI 3.1 document.',
          content: { 'application/json': { schema: OpenApiDocumentSchema } },
        },
      },
      handler: (c) => c.json(deps.document.get(), 200),
    }),
    defineRoute({
      id: 'meta.me',
      method: 'GET',
      path: '/api/v1/me',
      access: { public: true },
      rateLimit: 'read',
      summary: 'Who the client is and what it may do',
      description:
        'The actor the request resolved to, its permissions, the feature flags, the application version, the public origin and whether storage is available.',
      responses: {
        200: {
          description: 'The actor and the application metadata.',
          content: { 'application/json': { schema: MeResponseSchema } },
        },
      },
      handler: (c) => c.json(buildMe(c.get('actor')), 200),
    }),
    defineRoute({
      id: 'meta.csrf',
      method: 'GET',
      path: '/api/v1/csrf',
      access: { public: true },
      rateLimit: 'read',
      summary: 'A CSRF token for the writes that follow',
      description:
        'A stateless token (HMAC, 8 hours), sent back in X-CSRF-Token. Not compressed and never cached.',
      responses: {
        200: {
          description: 'The token and when it expires.',
          content: { 'application/json': { schema: CsrfResponseSchema } },
        },
      },
      handler: (c) => c.json(deps.csrf.issue(deps.binding?.(c) ?? ''), 200),
    }),
  ];
}
