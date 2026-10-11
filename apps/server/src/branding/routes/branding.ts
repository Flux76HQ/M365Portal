// The branding routes (T-A-087; FR-A-080 R6, R8 and R9, FR-A-082, FR-A-083; E-04):
//
//   R6 GET    /api/v1/branding   public; the applied branding with `ETag: "<revision>"`
//   R8 PUT    /api/v1/branding   `settings:branding`, rate class write; replaces the whole branding
//   R9 DELETE /api/v1/branding   `settings:branding`, rate class write; resets to the defaults
//
// The guards (rate limit, body limit, content type, Origin, CSRF, authorisation, validation) are the
// route wrapper's, in its fixed order; what is left for the handler is the precondition and the
// service. The audit entry of a success is written by the service in the transaction of the change
// (I-8); the audit entry of a denial is the wrapper's.
import {
  ApplyBrandingRequestSchema,
  BrandingSchema,
  revisionEtag,
} from '@m365portal/shared/schemas/branding';
import { z } from 'zod';
import { defineRoute, type RouteDefinition } from '../../http/route.js';
import type { BrandingService } from '../service.js';
import { changeContextOf, ifMatchRevisionOf } from './request-support.js';

export interface BrandingRoutesDeps {
  readonly service: BrandingService;
}

/** `If-Match` is documented here and judged by the handler: the validator cannot answer 428. */
const IfMatchHeaders = z.object({ 'if-match': z.string().optional() });

const ETAG_HEADER = {
  ETag: {
    description: 'The strong validator of the revision, such as "3"; send it back in If-Match.',
    schema: { type: 'string' },
  },
} as const;

const brandingResponse = (description: string) =>
  ({
    description,
    headers: ETAG_HEADER,
    content: { 'application/json': { schema: BrandingSchema } },
  }) as const;

export function brandingRoutes(deps: BrandingRoutesDeps): RouteDefinition[] {
  const { service } = deps;
  return [
    defineRoute({
      id: 'branding.get',
      method: 'GET',
      path: '/api/v1/branding',
      access: { public: true },
      rateLimit: 'read',
      summary: 'The applied branding',
      description:
        'Revision, organisation name, chosen accent, the derived token sets, logos, icons and the monogram. Carries an ETag for If-Match; no actor identity.',
      responses: { 200: brandingResponse('The applied branding.') },
      handler: (c) => {
        const branding = service.get();
        return c.json(branding, 200, { ETag: revisionEtag(branding.revision) });
      },
    }),

    defineRoute({
      id: 'branding.apply',
      method: 'PUT',
      path: '/api/v1/branding',
      access: { permission: 'settings:branding' },
      rateLimit: 'write',
      audit: 'branding.apply',
      summary: 'Apply the branding',
      description:
        'Replaces the whole branding. Requires If-Match with the current revision. The variants and icons are derived first; the change and its audit entry then commit in one transaction.',
      request: {
        headers: IfMatchHeaders,
        body: {
          required: true,
          content: { 'application/json': { schema: ApplyBrandingRequestSchema } },
        },
      },
      responses: { 200: brandingResponse('The branding at its new revision.') },
      handler: async (c, input) => {
        const revision = ifMatchRevisionOf(c);
        const branding = await service.apply(input.body, revision, changeContextOf(c));
        return c.json(branding, 200, { ETag: revisionEtag(branding.revision) });
      },
    }),

    defineRoute({
      id: 'branding.reset',
      method: 'DELETE',
      path: '/api/v1/branding',
      access: { permission: 'settings:branding' },
      rateLimit: 'write',
      audit: 'branding.reset',
      summary: 'Reset the branding to the defaults',
      description:
        'Name "M365Portal", the default accent, monogram icons, no logos. Requires If-Match. Retired assets keep 24 hours, so Undo can re-apply them.',
      request: { headers: IfMatchHeaders },
      responses: { 200: brandingResponse('The default branding at its new revision.') },
      handler: async (c) => {
        const revision = ifMatchRevisionOf(c);
        const branding = await service.reset(revision, changeContextOf(c));
        return c.json(branding, 200, { ETag: revisionEtag(branding.revision) });
      },
    }),
  ];
}
