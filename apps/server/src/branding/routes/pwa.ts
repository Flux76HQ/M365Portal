// The manifest and the two conventional icon paths (T-A-090; FR-A-094; R13, R14, R15; PA-13):
//
//   R13 GET /manifest.webmanifest   public; `application/manifest+json`, `no-cache`, ETag of the revision
//   R14 GET /favicon.ico            public; 307 to the hashed 32 pixel icon, `no-cache`
//   R15 GET /apple-touch-icon.png   public; 307 to the hashed 180 pixel icon, `no-cache`
//
// All three are generated from the applied branding. When storage is unusable (degraded mode,
// FR-A-013) the manifest answers with the defaults and no icons, and the two icon paths are 404: there
// is no file to point at. The redirect target is the hashed path of the registry, never built from
// anything in the request. The `ETag` of the manifest is the strong tag of the revision; the cache
// layer answers 304 from it.
import { revisionEtag } from '@m365portal/shared/schemas/branding';
import { WebManifestSchema } from '@m365portal/shared/schemas/manifest';
import { ProblemError } from '../../http/problem.js';
import { defineRoute, type RouteDefinition } from '../../http/route.js';
import { degradedBranding } from '../defaults.js';
import { appliedBranding, buildManifest } from '../manifest.js';
import type { BrandingService } from '../service.js';

export interface PwaRoutesDeps {
  readonly service: Pick<BrandingService, 'get'>;
}

const REDIRECT_RESPONSE = {
  307: { description: 'The hashed icon of the applied branding.' },
  404: { description: 'No icon: storage is unavailable.' },
} as const;

function redirectTo(url: string): Response {
  return new Response(null, {
    status: 307,
    headers: { Location: url, 'Cache-Control': 'no-cache' },
  });
}

export function pwaRoutes(deps: PwaRoutesDeps): RouteDefinition[] {
  return [
    defineRoute({
      id: 'pwa.manifest',
      method: 'GET',
      path: '/manifest.webmanifest',
      access: { public: true },
      rateLimit: 'read',
      summary: 'The web manifest',
      description:
        'Generated from the applied branding: the organisation name as data, a short name cut at a grapheme boundary, the effective light accent, the icons. Defaults and no icons without storage.',
      responses: {
        200: {
          description: 'The manifest.',
          content: { 'application/manifest+json': { schema: WebManifestSchema } },
        },
      },
      handler: (c) => {
        const branding = appliedBranding(deps.service) ?? degradedBranding();
        const manifest = buildManifest(branding);
        return c.body(JSON.stringify(manifest), 200, {
          'Content-Type': 'application/manifest+json',
          'Cache-Control': 'no-cache',
          ETag: revisionEtag(branding.revision),
        });
      },
    }),

    defineRoute({
      id: 'pwa.favicon',
      method: 'GET',
      path: '/favicon.ico',
      access: { public: true },
      rateLimit: 'read',
      summary: 'Redirect to the favicon',
      description: 'For browsers that ask by convention: 307 to the hashed 32 pixel icon.',
      responses: REDIRECT_RESPONSE,
      handler: () => {
        const branding = appliedBranding(deps.service);
        if (branding === undefined) throw new ProblemError('not_found');
        return redirectTo(branding.icons.favicon32.url);
      },
    }),

    defineRoute({
      id: 'pwa.appleTouchIcon',
      method: 'GET',
      path: '/apple-touch-icon.png',
      access: { public: true },
      rateLimit: 'read',
      summary: 'Redirect to the apple touch icon',
      description:
        'For browsers and crawlers that ask by convention: 307 to the hashed 180 pixel icon.',
      responses: REDIRECT_RESPONSE,
      handler: () => {
        const branding = appliedBranding(deps.service);
        if (branding === undefined) throw new ProblemError('not_found');
        return redirectTo(branding.icons.appleTouch180.url);
      },
    }),
  ];
}
