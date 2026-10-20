// The dashboard service (FR-D-808, P70): the counters of the home page. Nothing here reads Graph or
// Exchange itself: each counter pages through the SAME scoped list read the list pages use, so a counter
// can never hold a row the caller's list would not show (FR-C-401). The services take the capability of
// the policy layer as an argument; a route that never asked `ctx` cannot call this (ADR-0175).
//
// A count is bounded: `scanPagesMax` pages of `pageLimitMax` rows (1,000 rows). Beyond that the counter says
// `capped` and the card shows "1,000+" instead of a number it does not know. A source that fails makes ONE
// counter `unavailable`; the other counters still answer. The answers are kept for 60 seconds per caller
// and per set of visible scopes (FR-D-808), so a role change shows within a minute and a reload costs nothing.
// Nothing here logs a name, an address or an id (FR-D-107).
import { LIMITS } from '@m365portal/shared/limits';
import type {
  DashboardCounter,
  DashboardCounterName,
  DashboardResponse,
} from '@m365portal/shared/schemas/dashboard';
import { seesNothing } from '../directory/scoped-list.js';
import type { Logger } from '../logging/logger.js';
import type { VisibleScope } from '../policy/index.js';
import type { ContactsService } from '../contacts/service.js';
import type { DistributionListsService } from '../distribution-lists/service.js';
import type { GroupsService } from '../directory/groups-service.js';
import type { UsersService } from '../directory/users-service.js';

/** FR-D-808: how long an answer is kept. */
export const DASHBOARD_CACHE_MS = 60_000;
/** Answers kept at most; the oldest goes first. Far above the number of administrators of one tenant. */
const CACHE_ENTRIES = 256;

export interface DashboardServiceDeps {
  readonly users: Pick<UsersService, 'list'>;
  readonly groups: Pick<GroupsService, 'list'>;
  readonly lists: Pick<DistributionListsService, 'list'>;
  readonly contacts: Pick<ContactsService, 'list'>;
  readonly now: () => number;
  readonly log: Pick<Logger, 'warn'>;
}

export interface DashboardService {
  counters(input: {
    readonly actorId: string;
    readonly users: VisibleScope<'user'>;
    readonly groups: VisibleScope<'group'>;
    readonly lists: VisibleScope<'distributionList'>;
    readonly contacts: VisibleScope<'contact'>;
  }): Promise<DashboardResponse>;
}

interface Page {
  readonly items: readonly unknown[];
  readonly nextCursor?: string | undefined;
}

export function createDashboardService(deps: DashboardServiceDeps): DashboardService {
  const limit = String(LIMITS.directory.pageLimitMax);
  const cache = new Map<string, { readonly at: number; readonly value: DashboardResponse }>();

  /** Pages through a scoped list read, at most `scanPagesMax` pages. */
  async function count(
    scope: VisibleScope,
    name: DashboardCounterName,
    read: (cursor: string | undefined) => Promise<Page>,
  ): Promise<DashboardCounter> {
    if (seesNothing(scope.scopes)) return { state: 'denied' };
    try {
      let total = 0;
      let cursor: string | undefined;
      for (let pages = 1; ; pages += 1) {
        const page = await read(cursor);
        total += page.items.length;
        if (page.nextCursor === undefined) return { state: 'ok', count: total, capped: false };
        if (pages >= LIMITS.directory.scanPagesMax)
          return { state: 'ok', count: total, capped: true };
        cursor = page.nextCursor;
      }
    } catch {
      // The reason stays out of the line: it can name an object. The request log has the code.
      deps.log.warn({ event: 'dashboard_counter_unavailable', counter: name }, 'dashboard_counter');
      return { state: 'unavailable' };
    }
  }

  return {
    async counters({ actorId, users, groups, lists, contacts }) {
      const key = JSON.stringify([
        actorId,
        users.scopes,
        groups.scopes,
        lists.scopes,
        contacts.scopes,
      ]);
      const now = deps.now();
      const hit = cache.get(key);
      if (hit !== undefined && now - hit.at < DASHBOARD_CACHE_MS) return hit.value;

      const query = { limit, order: 'asc' } as const;
      const [usersCounter, groupsCounter, listsCounter, contactsCounter] = await Promise.all([
        count(users, 'users', (cursor) =>
          deps.users.list({
            scope: users,
            actorId,
            query: { ...query, enabled: 'all', type: 'all', ...(cursor ? { cursor } : {}) },
          }),
        ),
        count(groups, 'groups', (cursor) =>
          deps.groups.list({
            scope: groups,
            actorId,
            query: { ...query, kind: 'all', ...(cursor ? { cursor } : {}) },
          }),
        ),
        count(lists, 'distributionLists', (cursor) =>
          deps.lists.list({
            scope: lists,
            users,
            actorId,
            query: { ...query, kind: 'all', ...(cursor ? { cursor } : {}) },
          }),
        ),
        count(contacts, 'contacts', (cursor) =>
          deps.contacts.list({
            scope: contacts,
            actorId,
            query: { ...query, ...(cursor ? { cursor } : {}) },
          }),
        ),
      ]);
      const value: DashboardResponse = {
        users: usersCounter,
        groups: groupsCounter,
        distributionLists: listsCounter,
        contacts: contactsCounter,
      };
      // A failed source is not kept: the next reload tries again instead of repeating the failure for a minute.
      const failed = Object.values(value).some((counter) => counter.state === 'unavailable');
      if (!failed) {
        const oldest = cache.keys().next();
        if (cache.size >= CACHE_ENTRIES && oldest.done !== true) cache.delete(oldest.value);
        cache.set(key, { at: now, value });
      }
      return value;
    },
  };
}
