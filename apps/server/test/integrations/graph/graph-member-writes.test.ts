// T-D-116, FR-D-351, FR-D-353, R-D-08: what `HttpGraphClient` sends for the two member writes, and
// the one function that builds their paths. The delete path of Graph must END IN `/$ref`: without
// it Graph deletes the member object itself when the application may manage that object type. So
// there is exactly one function (`memberRefPath`), a property test that no input can make it return
// a path without the suffix, a guard that reads the source for a path built any other way (with a
// negative fixture), and a wire test against a scripted route that sees the body and the headers.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it } from 'vitest';
import { createHttpGraphClient } from '../../../src/integrations/graph/graph-client.js';
import { memberRefPath } from '../../../src/integrations/graph/member-paths.js';
import {
  GraphBadRequestError,
  GraphForbiddenError,
  GraphNotFoundError,
  GraphTransientError,
} from '../../../src/ports/errors.js';
import { fakeGuid } from '../../fakes/fake-tenant/graph/index.js';
import { fake } from '../../support/msw.js';
import {
  createTime,
  mountScript,
  rejectionOf,
  sequenceRandom,
  settle,
  staticAppTokens,
  track,
} from '../support.js';

const GRAPH = 'graph.microsoft.com';
const TOKEN = 'canary-app-token-3c9e41d07b58a2f6';
const GROUP = fakeGuid('group', 1);
const MEMBER = fakeGuid('user', 2);
/** 204 has no body, so the step is a function that makes the response itself. */
const NO_CONTENT = (): Response => new Response(null, { status: 204 });
const ADD_PATH = `/v1.0/groups/${GROUP}/members/$ref`;
const REMOVE_PATH = `/v1.0/groups/${GROUP}/members/${MEMBER}/$ref`;

function client() {
  const time = createTime();
  const tokens = staticAppTokens(TOKEN);
  return {
    time,
    client: createHttpGraphClient({
      appTokens: tokens.provider,
      clock: time.clock,
      random: sequenceRandom([0]),
      scheduler: time.scheduler,
    }),
  };
}

describe('memberRefPath: the one builder of the member paths', () => {
  it('builds the collection path for an add and the item path for a delete, both ending in /$ref', () => {
    expect(memberRefPath(GROUP)).toBe(`/groups/${GROUP}/members/$ref`);
    expect(memberRefPath(GROUP, MEMBER)).toBe(`/groups/${GROUP}/members/${MEMBER}/$ref`);
    expect(memberRefPath(GROUP.toUpperCase(), MEMBER.toUpperCase())).toBe(
      `/groups/${GROUP}/members/${MEMBER}/$ref`,
    );
  });

  it('refuses anything that is not a GUID, with nothing built', () => {
    for (const bad of [
      '',
      'x',
      '../groups',
      'a/b',
      GROUP + '/',
      `${GROUP}?x=1`,
      `${GROUP}#`,
      'a\nb',
      '%2e%2e',
    ]) {
      expect(() => memberRefPath(bad), bad).toThrow();
      expect(() => memberRefPath(GROUP, bad), bad).toThrow();
    }
  });

  it('property: for 5,000 random inputs the result is a path ending in /$ref or an exception, never a path without it', () => {
    let seed = 20_261_013;
    const next = (): number => {
      seed = (seed * 1_664_525 + 1_013_904_223) % 4_294_967_296;
      return seed / 4_294_967_296;
    };
    const alphabet = '0123456789abcdefABCDEF-/$?#%. \n';
    const noise = (): string =>
      Array.from(
        { length: Math.floor(next() * 40) },
        () => alphabet[Math.floor(next() * alphabet.length)],
      ).join('');
    let built = 0;
    for (let n = 0; n < 5_000; n += 1) {
      const group = next() < 0.5 ? GROUP : noise();
      const member = next() < 0.3 ? undefined : next() < 0.5 ? MEMBER : noise();
      try {
        const path = memberRefPath(group, member);
        built += 1;
        expect(path.endsWith('/$ref')).toBe(true);
        expect(path.startsWith('/groups/')).toBe(true);
        expect(path.includes('?') || path.includes('#')).toBe(false);
      } catch {
        // refused: fine
      }
    }
    expect(built).toBeGreaterThan(100);
  });

  /** The guard of the plan: a delete path is a path that ends in /$ref. */
  const checkDeletePath = (path: string): void => {
    if (!path.endsWith('/$ref')) throw new Error(`a delete path without /$ref: ${path}`);
  };

  it('negative: a path without /$ref fails the guard (it would delete the member object itself)', () => {
    expect(() => {
      checkDeletePath(memberRefPath(GROUP, MEMBER));
    }).not.toThrow();
    expectGuardFails(checkDeletePath, `/groups/${GROUP}/members/${MEMBER}`, {
      name: 'path without /$ref',
      reason: 'a delete path without /$ref',
    });
    expectGuardFails(checkDeletePath, `/groups/${GROUP}/members/${MEMBER}/$ref/`, {
      name: 'a trailing slash after /$ref',
      reason: 'a delete path without /$ref',
    });
  });

  it('is the only place that writes "/members/" in a request path of the client', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../../src/integrations/graph/graph-client.ts', import.meta.url)),
      'utf8',
    );
    // The read path of the members belongs to directory-query.ts; graph-client.ts builds no member path itself.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/\/members/);
    const paths = readFileSync(
      fileURLToPath(new URL('../../../src/integrations/graph/member-paths.ts', import.meta.url)),
      'utf8',
    );
    expect(paths.match(/\/members/g)?.length).toBeGreaterThan(0);
  });
});

describe('addGroupMember on the wire', () => {
  it('POSTs the reference body to /groups/{id}/members/$ref with a bearer token, and takes 204 for success', async () => {
    const { client: graph } = client();
    const route = mountScript(GRAPH, 'POST', ADD_PATH, [NO_CONTENT]);
    await expect(graph.addGroupMember(GROUP, MEMBER)).resolves.toBeUndefined();
    expect(route.calls).toHaveLength(1);
    const [call] = route.calls;
    expect(call?.method).toBe('POST');
    expect(call?.path).toBe(ADD_PATH);
    expect(call?.query.size).toBe(0);
    expect(JSON.parse(call!.body)).toEqual({
      '@odata.id': `https://graph.microsoft.com/v1.0/directoryObjects/${MEMBER}`,
    });
    expect(call?.headers.get('content-type')).toMatch(/^application\/json/);
    expect(call?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(call?.headers.get('client-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('sends nothing for ids it refuses', async () => {
    const { client: graph } = client();
    const route = mountScript(GRAPH, 'POST', /^\/v1\.0\/groups\/.*/, [NO_CONTENT]);
    expect(await rejectionOf(graph.addGroupMember('x', MEMBER))).toBeInstanceOf(
      GraphBadRequestError,
    );
    expect(await rejectionOf(graph.addGroupMember(GROUP, '../users'))).toBeInstanceOf(
      GraphBadRequestError,
    );
    expect(route.calls).toHaveLength(0);
  });

  it.each([
    [400, GraphBadRequestError],
    [403, GraphForbiddenError],
    [404, GraphNotFoundError],
  ] as const)('maps %s to its typed error and keeps no Graph message', async (status, type) => {
    const { client: graph } = client();
    mountScript(GRAPH, 'POST', ADD_PATH, [
      {
        status,
        body: {
          error: {
            code: 'Request_BadRequest',
            message: `Zoë Canary is already a member of ${GROUP}`,
          },
        },
      },
    ]);
    const failure = await rejectionOf(graph.addGroupMember(GROUP, MEMBER));
    expect(failure).toBeInstanceOf(type);
    expect(JSON.stringify(failure) + String(failure)).not.toContain('Canary');
  });

  it('does NOT repeat after a 503: an add that may have run must not be sent twice', async () => {
    const { client: graph } = client();
    const route = mountScript(GRAPH, 'POST', ADD_PATH, [{ status: 503 }, NO_CONTENT]);
    const failure = await rejectionOf(graph.addGroupMember(GROUP, MEMBER));
    expect(failure).toBeInstanceOf(GraphTransientError);
    expect(route.calls).toHaveLength(1);
  });

  it('waits Retry-After on a 429 and sends the add again', async () => {
    const { client: graph, time } = client();
    const route = mountScript(GRAPH, 'POST', ADD_PATH, [
      { status: 429, headers: { 'retry-after': '3' } },
      NO_CONTENT,
    ]);
    const done = track(graph.addGroupMember(GROUP, MEMBER));
    await settle();
    expect(route.calls).toHaveLength(1);
    time.elapse(3_000);
    await settle();
    await done.promise;
    expect(route.calls).toHaveLength(2);
  });
});

describe('removeGroupMember on the wire', () => {
  it('DELETEs /groups/{id}/members/{id}/$ref without a body, and takes 204 for success', async () => {
    const { client: graph } = client();
    const route = mountScript(GRAPH, 'DELETE', REMOVE_PATH, [NO_CONTENT]);
    await expect(graph.removeGroupMember(GROUP, MEMBER)).resolves.toBeUndefined();
    const [call] = route.calls;
    expect(call?.method).toBe('DELETE');
    expect(call?.path).toBe(REMOVE_PATH);
    expect(call?.path.endsWith('/$ref')).toBe(true);
    expect(call?.body).toBe('');
    expect(call?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it('never reaches a path without /$ref: such a route is not even mounted, and the call succeeds on the right one', async () => {
    const { client: graph } = client();
    const withoutRef = mountScript(GRAPH, 'DELETE', `/v1.0/groups/${GROUP}/members/${MEMBER}`, [
      NO_CONTENT,
    ]);
    const withRef = mountScript(GRAPH, 'DELETE', REMOVE_PATH, [NO_CONTENT]);
    await graph.removeGroupMember(GROUP, MEMBER);
    expect(withoutRef.calls).toHaveLength(0);
    expect(withRef.calls).toHaveLength(1);
  });

  it('repeats a delete after a 503 (a delete is repeatable)', async () => {
    const { client: graph, time } = client();
    const route = mountScript(GRAPH, 'DELETE', REMOVE_PATH, [{ status: 503 }, NO_CONTENT]);
    const done = track(graph.removeGroupMember(GROUP, MEMBER));
    for (let round = 0; round < 20 && !done.settled(); round += 1) {
      await settle();
      time.elapse(1_000);
    }
    await done.promise;
    expect(route.calls).toHaveLength(2);
  });

  it('maps 404 (not a member, U93) and 400 (dynamic group) to their typed errors', async () => {
    const { client: graph } = client();
    mountScript(GRAPH, 'DELETE', REMOVE_PATH, [
      { status: 404, body: { error: { code: 'Request_ResourceNotFound' } } },
    ]);
    expect(await rejectionOf(graph.removeGroupMember(GROUP, MEMBER))).toBeInstanceOf(
      GraphNotFoundError,
    );
    fake.reset();
    mountScript(GRAPH, 'DELETE', REMOVE_PATH, [
      { status: 400, body: { error: { code: 'Request_BadRequest' } } },
    ]);
    expect(await rejectionOf(graph.removeGroupMember(GROUP, MEMBER))).toBeInstanceOf(
      GraphBadRequestError,
    );
  });
});
