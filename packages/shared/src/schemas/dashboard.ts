// Dashboard schemas (Phase D, FR-D-808, P70): `GET /api/v1/dashboard`. One counter per kind of object the
// panel manages. A counter is never blank and never invented (FR-A-130): it holds a number, it says the
// caller may not read that kind, or it says the count could not be made right now.
import { z } from 'zod';

/** The counters of the dashboard, in the order the cards are shown. */
export const DASHBOARD_COUNTERS = ['users', 'groups', 'distributionLists', 'contacts'] as const;
export type DashboardCounterName = (typeof DASHBOARD_COUNTERS)[number];

/**
 * One counter. `ok`: the rows the caller may see, counted through the scoped list read; `capped` is true when
 * the count stopped at the bound and the real number is larger (the card shows "1,000+"). `denied`: the
 * caller holds no read permission for the kind. `unavailable`: Graph or Exchange could not answer.
 */
export const DashboardCounterSchema = z
  .discriminatedUnion('state', [
    z.strictObject({
      state: z.literal('ok'),
      count: z.number().int().min(0).max(1_000_000),
      capped: z.boolean(),
    }),
    z.strictObject({ state: z.literal('denied') }),
    z.strictObject({ state: z.literal('unavailable') }),
  ])
  .meta({ id: 'DashboardCounter' });

/** `GET /api/v1/dashboard` (P70). */
export const DashboardResponseSchema = z
  .strictObject({
    users: DashboardCounterSchema,
    groups: DashboardCounterSchema,
    distributionLists: DashboardCounterSchema,
    contacts: DashboardCounterSchema,
  })
  .meta({ id: 'DashboardResponse' });

export type DashboardCounter = z.infer<typeof DashboardCounterSchema>;
export type DashboardResponse = z.infer<typeof DashboardResponseSchema>;
