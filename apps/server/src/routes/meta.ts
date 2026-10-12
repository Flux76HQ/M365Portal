// Metadata routes (contract R3, R4 and R5, FR-A-021, FR-A-027): the OpenAPI document, who the client
// is and what it may do, and the CSRF token. With `/healthz`, `/readyz` and `/robots.txt` these are
// the whole set of routes that need no storage and answer in degraded mode as well. `/api/v1/meta`
// and `/api/v1/session` are not created (`/session` is reserved for Phase B).
//
// Nothing in the request selects the actor: `/api/v1/me` reports the one the pipeline resolved from
// the configuration (plan 8.8). The preview feature flag is true only for a request that resolved to
// the preview actor, so a LAN `Host` in preview mode sees an empty permission list and no banner
// (FR-A-036).
import type { Permission } from '@m365portal/shared/permissions';
import { PERMISSIONS } from '@m365portal/shared/permissions';
import { CsrfResponseSchema, MeResponseSchema } from '@m365portal/shared/schemas/meta';
import { z } from 'zod';
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
  /** The CSRF binding: empty in Phase A, the session id from Phase B. */
  readonly binding?: (c: RouteContext) => string;
  /** The document, generated once the routes are registered. */
  readonly document: DocumentSource;
}

export function metaRoutes(deps: MetaRoutesDeps): RouteDefinition[] {
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
      handler: (c) => {
        const actor = c.get('actor');
        // The catalogue order, so the list is the same for every request of the same actor.
        const held: Permission[] = PERMISSIONS.filter((candidate) =>
          actor.permissions.has(candidate),
        );
        return c.json(
          {
            actor: { kind: actor.kind, id: actor.id, label: actor.label },
            permissions: held,
            // TRANSITIONAL: `preview` leaves the wire shape with T-B-194 (S-B4); it is never true any more.
            features: { showcase: deps.showcase, preview: false },
            version: deps.version,
            publicOrigin: deps.publicOrigin,
            storageAvailable: deps.storageAvailable(),
          },
          200,
        );
      },
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
