// T-C-011, FR-C-103, FR-C-102: `GraphHttp.requestPage` reads one page and hands the next link back
// only after the same-origin, /v1.0/-only rule has passed it; the headers of the request go out again
// with a followed link; the 5 MiB answer cap holds; `$skip` is never sent; `requestAll` is unchanged.
import { describe, expect, it } from 'vitest';
import {
  GRAPH_MAX_RESPONSE_BYTES,
  createGraphHttp,
  type GraphRequest,
} from '../../../src/integrations/graph/graph-http.js';
import { GraphBadRequestError, GraphNetworkError } from '../../../src/ports/errors.js';
import { jsonResponse } from '../../fakes/fake-tenant/index.js';
import { createTime, mountScript, rejectionOf, sequenceRandom } from '../support.js';

const ORIGIN = 'https://graph.microsoft.com/v1.0';
const ID = '3f2c1a9e-0b5d-4c61-8a77-5d9a2b7c4e10';

function harness() {
  const time = createTime();
  const http = createGraphHttp({
    token: () => Promise.resolve('fk-throwaway-token'),
    clock: time.clock,
    random: sequenceRandom([0]),
    scheduler: time.scheduler,
  });
  return http;
}

function pageRequest(extra: Partial<GraphRequest> = {}): GraphRequest {
  return {
    method: 'GET',
    route: 'users.list',
    path: '/users',
    query: { $top: '2', $count: 'true' },
    consistencyLevelEventual: true,
    ...extra,
  };
}

describe('requestPage (T-C-011)', () => {
  it('returns the items, the validated next link and the count of one page', async () => {
    const next = `${ORIGIN}/users?%24top=2&%24skiptoken=abc`;
    const script = mountScript('graph.microsoft.com', 'GET', '/v1.0/users', [
      {
        status: 200,
        body: { value: [{ id: 'a' }, { id: 'b' }], '@odata.nextLink': next, '@odata.count': 7 },
      },
    ]);
    const page = await harness().requestPage(pageRequest());
    expect(page).toEqual({ items: [{ id: 'a' }, { id: 'b' }], nextLink: next, count: 7 });
    expect(script.calls).toHaveLength(1);
    expect(script.calls[0]?.headers.get('consistencylevel')).toBe('eventual');
    expect(script.calls[0]?.query.get('$top')).toBe('2');
  });

  it('has no next link and no count at the end of a list', async () => {
    mountScript('graph.microsoft.com', 'GET', '/v1.0/users', [
      { status: 200, body: { value: [] } },
    ]);
    expect(await harness().requestPage(pageRequest())).toEqual({
      items: [],
      nextLink: null,
      count: null,
    });
  });

  it('reads the page a link names, resending the headers of the request', async () => {
    const script = mountScript('graph.microsoft.com', 'GET', '/v1.0/users', [
      { status: 200, body: { value: [{ id: 'c' }] } },
    ]);
    const link = `${ORIGIN}/users?%24top=2&%24skiptoken=abc`;
    const page = await harness().requestPage(pageRequest(), link);
    expect(page.items).toEqual([{ id: 'c' }]);
    expect(script.calls[0]?.query.get('$skiptoken')).toBe('abc');
    expect(script.calls[0]?.headers.get('consistencylevel')).toBe('eventual');
    expect(script.calls[0]?.headers.get('authorization')).toBe('Bearer fk-throwaway-token');
  });

  it.each([
    ['another origin', 'https://evil.example/v1.0/users?$skiptoken=x'],
    ['a look-alike host', 'https://graph.microsoft.com.evil.example/v1.0/users?$skiptoken=x'],
    ['plain http', 'http://graph.microsoft.com/v1.0/users?$skiptoken=x'],
    ['another version', 'https://graph.microsoft.com/beta/users?$skiptoken=x'],
    ['user information in the URL', 'https://graph.microsoft.com@evil.example/v1.0/users'],
    ['a relative link', '/v1.0/users?$skiptoken=x'],
  ])(
    'refuses a next link on %s when a page returns it, and sends nothing to it',
    async (_n, link) => {
      const script = mountScript('graph.microsoft.com', 'GET', '/v1.0/users', [
        { status: 200, body: { value: [{ id: 'a' }], '@odata.nextLink': link } },
      ]);
      const failure = await rejectionOf(harness().requestPage(pageRequest()));
      expect(failure).toBeInstanceOf(GraphBadRequestError);
      expect((failure as GraphBadRequestError).graphCode).toBe('invalid_next_link');
      expect(script.calls).toHaveLength(1);
    },
  );

  it('refuses a stored link of another origin before any request is made', async () => {
    const script = mountScript('graph.microsoft.com', 'GET', '/v1.0/users', [
      { status: 200, body: { value: [] } },
    ]);
    const failure = await rejectionOf(
      harness().requestPage(pageRequest(), 'https://evil.example/v1.0/users?$skiptoken=x'),
    );
    expect(failure).toBeInstanceOf(GraphBadRequestError);
    expect(script.calls).toHaveLength(0);
  });

  it('never sends $skip', async () => {
    const script = mountScript('graph.microsoft.com', 'GET', '/v1.0/users', [
      { status: 200, body: { value: [] } },
    ]);
    for (const name of ['$skip', '$SKIP']) {
      const failure = await rejectionOf(
        harness().requestPage(pageRequest({ query: { $top: '2', [name]: '10' } })),
      );
      expect(failure).toBeInstanceOf(GraphBadRequestError);
      expect((failure as GraphBadRequestError).graphCode).toBe('invalid_value');
    }
    expect(script.calls).toHaveLength(0);
  });

  it('reads with GET only', async () => {
    const failure = await rejectionOf(harness().requestPage(pageRequest({ method: 'POST' })));
    expect(failure).toBeInstanceOf(TypeError);
  });

  it('fails a page without a value array as unexpected_shape, carrying no body', async () => {
    mountScript('graph.microsoft.com', 'GET', '/v1.0/users', [
      { status: 200, body: { value: 'nope', secret: 'canary-body-text' } },
    ]);
    const failure = await rejectionOf(harness().requestPage(pageRequest()));
    expect(failure).toBeInstanceOf(GraphBadRequestError);
    expect((failure as GraphBadRequestError).graphCode).toBe('unexpected_shape');
    expect(JSON.stringify(failure)).not.toContain('canary-body-text');
  });

  it('refuses an answer above the 5 MiB cap', async () => {
    mountScript('graph.microsoft.com', 'GET', '/v1.0/users', [
      () =>
        jsonResponse(200, {
          value: [{ id: 'a', displayName: 'x'.repeat(GRAPH_MAX_RESPONSE_BYTES + 1024) }],
        }),
    ]);
    const failure = await rejectionOf(harness().requestPage(pageRequest()));
    expect(failure).toBeInstanceOf(GraphNetworkError);
  });

  it('does not cache a page, even for a request that asks for a cache', async () => {
    const script = mountScript('graph.microsoft.com', 'GET', '/v1.0/users', [
      { status: 200, body: { value: [] } },
    ]);
    const http = harness();
    await http.requestPage(pageRequest({ cache: { ttlMs: 60_000 } }));
    await http.requestPage(pageRequest({ cache: { ttlMs: 60_000 } }));
    expect(script.calls).toHaveLength(2);
  });

  it('leaves requestAll as it was: every page, in order', async () => {
    const second = `${ORIGIN}/users?%24skiptoken=p2`;
    mountScript('graph.microsoft.com', 'GET', '/v1.0/users', [
      { status: 200, body: { value: [{ id: ID }], '@odata.nextLink': second } },
      { status: 200, body: { value: [{ id: 'z' }] } },
    ]);
    const all = await harness().requestAll(pageRequest());
    expect(all.items).toEqual([{ id: ID }, { id: 'z' }]);
  });
});
