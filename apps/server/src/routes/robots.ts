// `GET /robots.txt` (contract R16, FR-A-049): the panel is not for crawlers. Disallow everything and
// make no other promise (no AI-specific rules: baseline section 14 does not apply here). The
// `X-Robots-Tag: noindex, nofollow` header on every response says the same to a crawler that does not
// read this file.
import { z } from 'zod';
import { defineRoute, type RouteDefinition } from '../http/route.js';

export const ROBOTS_TXT = 'User-agent: *\nDisallow: /\n';

export function robotsRoutes(): RouteDefinition[] {
  return [
    defineRoute({
      id: 'meta.robots',
      method: 'GET',
      path: '/robots.txt',
      access: { public: true },
      rateLimit: 'read',
      summary: 'robots.txt: disallow everything',
      responses: {
        200: {
          description: 'User-agent: * and Disallow: /.',
          content: { 'text/plain': { schema: z.string() } },
        },
      },
      handler: (c) => c.text(ROBOTS_TXT, 200),
    }),
  ];
}
