// The dashboard route P70 (FR-D-808): `GET /api/v1/dashboard`, access `authenticated`, class `read`. The
// counters of the kinds the caller may read; a kind the caller may not read answers `denied`, never a
// number. Every counter goes through the policy layer (`ctx.visibleScopes`) and the scoped list reads.
// Nothing is written and a success is not audited; a denial is (the wrapper).
import { DashboardResponseSchema } from '@m365portal/shared/schemas/dashboard';
import { ProblemSchema } from '@m365portal/shared/problem';
import { defineRoute, type RouteDefinition } from '../http/route.js';
import type { DashboardService } from './service.js';

export function dashboardRoutes(dashboard: DashboardService): RouteDefinition[] {
  return [
    defineRoute({
      id: 'dashboard.counters',
      method: 'GET',
      path: '/api/v1/dashboard',
      access: { authenticated: true },
      rateLimit: 'read',
      summary: 'The dashboard counters',
      description:
        'How many users, groups, distribution lists and mail contacts the caller may see, counted through the same scoped reads as the list pages and kept for 60 seconds. A count stops at 1,000 rows (capped). A kind the caller may not read is denied; a kind whose source could not answer is unavailable.',
      responses: {
        200: {
          description: 'One counter per kind.',
          content: { 'application/json': { schema: DashboardResponseSchema } },
        },
        401: {
          description: 'Not signed in.',
          content: { 'application/problem+json': { schema: ProblemSchema } },
        },
      },
      handler: async (c, _input, ctx) =>
        c.json(
          await dashboard.counters({
            actorId: c.get('actor').id,
            users: ctx.visibleScopes('users:read'),
            groups: ctx.visibleScopes('groups:read'),
            lists: ctx.visibleScopes('distributionlists:read'),
            contacts: ctx.visibleScopes('contacts:read'),
          }),
          200,
        ),
    }),
  ];
}
