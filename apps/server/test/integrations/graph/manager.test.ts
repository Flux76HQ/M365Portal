// T-C-016, FR-C-107, EC-C5, EC-C6, U66: the manager is best effort. 404 is "none"; a refusal (403),
// a bad request (400) and an answer of an unexpected shape are "not available"; a throttle or an
// outage is NOT swallowed by the client (the service decides what the page does with it).
import { describe, expect, it } from 'vitest';
import { createHttpGraphClient } from '../../../src/integrations/graph/graph-client.js';
import { GraphThrottledError, GraphTransientError } from '../../../src/ports/errors.js';
import { fakeGuid } from '../../fakes/fake-tenant/graph/index.js';
import {
  createTime,
  mountScript,
  rejectionOf,
  sequenceRandom,
  staticAppTokens,
} from '../support.js';

const USER = fakeGuid('manager-user', 1);
const MANAGER = fakeGuid('manager-boss', 1);

function client() {
  const time = createTime();
  return createHttpGraphClient({
    appTokens: staticAppTokens('fk-throwaway-token').provider,
    clock: time.clock,
    random: sequenceRandom([0]),
    scheduler: time.scheduler,
  });
}

function script(step: Parameters<typeof mountScript>[3][number]) {
  return mountScript('graph.microsoft.com', 'GET', `/v1.0/users/${USER}/manager`, [step]);
}

describe('getUserManager on the wire', () => {
  it('is present for a user object, parsed through the allow-list', async () => {
    const calls = script({
      status: 200,
      body: {
        '@odata.type': '#microsoft.graph.user',
        id: MANAGER,
        displayName: 'Boss',
        mail: 'boss@contoso-fake.example',
        userPrincipalName: 'boss@contoso-fake.example',
        jobTitle: 'not on the list',
      },
    });
    const result = await client().getUserManager(USER);
    expect(result).toEqual({
      state: 'present',
      manager: {
        id: MANAGER,
        kind: 'user',
        displayName: 'Boss',
        mail: 'boss@contoso-fake.example',
        userPrincipalName: 'boss@contoso-fake.example',
        department: null,
        mailNickname: null,
      },
    });
    expect(calls.calls[0]?.query.get('$select')).toBe(
      'id,displayName,mail,userPrincipalName,department,mailNickname',
    );
  });

  it.each([
    ['404 (no manager)', 404, 'none'],
    ['403 (the application may not, U66)', 403, 'unavailable'],
    ['400', 400, 'unavailable'],
  ] as const)('maps %s to %s', async (_name, status, state) => {
    script({
      status,
      body: { error: { code: 'Request_ResourceNotFound', message: 'canary text' } },
    });
    expect(await client().getUserManager(USER)).toEqual({ state });
  });

  it.each([
    ['an object without an id', { displayName: 'Boss' }],
    ['an id that is not a GUID', { id: 'nope' }],
    ['a body that is not an object', 'text'],
  ])('is not available for %s', async (_name, body) => {
    script({ status: 200, body });
    expect(await client().getUserManager(USER)).toEqual({ state: 'unavailable' });
  });

  it('lets a throttle that outlasts the budget through', async () => {
    script({ status: 429, headers: { 'retry-after': '120' }, body: {} });
    expect(await rejectionOf(client().getUserManager(USER))).toBeInstanceOf(GraphThrottledError);
  });

  it('lets a persistent outage through', async () => {
    script({ status: 500, body: {} });
    expect(await rejectionOf(client().getUserManager(USER))).toBeInstanceOf(GraphTransientError);
  });
});
