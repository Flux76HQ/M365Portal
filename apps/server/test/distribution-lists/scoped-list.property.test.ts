// T-D-118, FR-D-201, FR-D-202 (the property test of Phase C, scoped-list.test.ts, for the Exchange lists): a
// scoped list never holds a row the detail would refuse, and holds every row the detail would allow, in
// order, once, whatever the scope, the page size and the order. The "detail" side is the policy layer's
// `authorize` over the grants of the actor, which shares no code with `visibilityOf`.
//
// Seeded cases (mulberry32), so a failure can be repeated from its seed and index.
import type { Grant } from '@m365portal/shared/rbac/effective';
import type { ScopeItem } from '@m365portal/shared/rbac/scope';
import { describe, expect, it } from 'vitest';
import { createListBufferStore } from '../../src/distribution-lists/list-buffer.js';
import { createDistributionListsService } from '../../src/distribution-lists/service.js';
import { authorize, createPolicyContext } from '../../src/policy/index.js';
import { FakeExchangeClient } from '../fakes/fake-exchange-client.js';
import { FakeExchangeState } from '../fakes/fake-tenant/exchange/index.js';
import { createFakeClock } from '../helpers/fake-clock.js';
import { grantAll, testActor } from '../helpers/test-actor.js';
import { sequenceRandom } from '../integrations/support.js';

function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const WORDS = [
  'Sales',
  'Salon',
  'Board',
  'Boar',
  'Staff',
  'Étoile',
  'Ünal',
  'sales',
  'HR',
  'Hr team',
];

describe('a scoped list holds exactly the lists the detail allows (FR-D-201)', () => {
  it('for 3,000 random worlds, scopes, page sizes and orders', async () => {
    const clock = createFakeClock();
    let checked = 0;
    for (let index = 0; index < 3_000; index += 1) {
      const next = generator(0xd1_00 + index);
      const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
      const state = new FakeExchangeState();
      const count = 1 + Math.floor(next() * 14);
      const made = Array.from({ length: count }, (_, n) =>
        state.addDistributionGroup({
          name: `${pick(WORDS)} ${String(n)}`,
          alias: `${pick(WORDS).toLowerCase().replaceAll(' ', '')}${String(n)}`,
          primarySmtpAddress: `${pick(WORDS).toLowerCase().replaceAll(' ', '')}${String(n)}@x.example`,
          isDirSynced: next() < 0.15,
          ...(next() < 0.15 ? { recipientTypeDetails: 'DynamicDistributionGroup' } : {}),
        }),
      );
      const items: ScopeItem[] = Array.from({ length: Math.floor(next() * 4) }, () =>
        next() < 0.3
          ? { target: 'distributionList', match: { by: 'id', id: pick(made).guid } }
          : {
              target: 'distributionList',
              match: {
                by: 'prefix',
                attr: pick(['displayName', 'alias', 'mail'] as const),
                value: pick(WORDS).slice(0, 1 + Math.floor(next() * 4)),
              },
            },
      );
      const grant: Grant = {
        permission: 'distributionlists:read',
        qualifier: 'full',
        scope: next() < 0.15 ? 'all' : items,
      };
      const actor = testActor('user', { grants: [grant, ...grantAll('users:read')] });
      const ctx = createPolicyContext(actor);
      const service = createDistributionListsService({
        exchange: () => new FakeExchangeClient(state, { clock: { now: () => clock.nowMs() } }),
        graph: () => {
          throw new Error('Graph is not asked');
        },
        buffers: createListBufferStore({
          clock: { now: () => clock.nowMs() },
          random: sequenceRandom(),
        }),
      });

      const order = pick(['asc', 'desc'] as const);
      const limit = String(1 + Math.floor(next() * 5));
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const answer = await service.list({
          scope: ctx.visibleScopes('distributionlists:read'),
          users: ctx.visibleScopes('users:read'),
          actorId: actor.id,
          query: { kind: 'all', order, limit, ...(cursor === undefined ? {} : { cursor }) },
        });
        expect(answer.items.length, `case ${String(index)}`).toBeLessThanOrEqual(Number(limit));
        seen.push(...answer.items.map((row) => row.id));
        cursor = answer.nextCursor;
        pages += 1;
        expect(pages).toBeLessThan(40);
      } while (cursor !== undefined);

      // The reference: every list in the order asked, kept when the policy layer allows the detail.
      const sorted = [...made].sort((a, b) =>
        a.displayName.toLowerCase() < b.displayName.toLowerCase()
          ? -1
          : a.displayName.toLowerCase() > b.displayName.toLowerCase()
            ? 1
            : a.guid < b.guid
              ? -1
              : 1,
      );
      const ordered = order === 'asc' ? sorted : [...sorted].reverse();
      const allowed = ordered
        .filter(
          (list) =>
            authorize(actor, 'distributionlists:read', {
              type: 'distributionList',
              id: list.guid,
              displayName: list.displayName,
              alias: list.alias,
              mail: list.primarySmtpAddress,
            }).allow,
        )
        .map((list) => list.guid);
      expect(seen, `case ${String(index)}`).toEqual(allowed);
      checked += allowed.length;
    }
    expect(checked).toBeGreaterThan(5_000);
  }, 120_000);
});
