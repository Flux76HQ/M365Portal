// THE BOOT RE-CHECK OF THE SESSION (T-B-296; PB-15, FR-B-413 web half, RB-11; plan 12.2).
//
// A navigation that starts on another site (a link in mail or chat) does not carry a `SameSite=Strict`
// cookie, so the server renders the shell for an anonymous actor although the person has a session. When
// the embedded actor is anonymous and the setup is not `unconfigured`, the client therefore sends ONE
// same-origin `GET /api/v1/me` before any gating redirect: a signed-in answer replaces the boot data, an
// anonymous answer goes on to the gate. The wait is capped at 800 ms, with the static shell on screen.
// The clock is fake and the network is a fake `fetch`; nothing here sleeps.
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RECHECK_CAP_MS, recheckBootSession } from '../src/boot/recheck';
import { createSessionStore } from '../src/features/auth/session-store';
import { createApiClient, type FetchFunction } from '../src/lib/api';
import { readBootData, type BootData, type MeResponse } from '../src/lib/boot-data';
import { createAppQueryClient, queryKeys, seedQueryClient } from '../src/lib/query';
import { createAppRouter } from '../src/router';
import {
  escapeForScript,
  installBootBlock,
  sampleBranding,
  sampleMe,
  sampleSignedInMe,
} from './helpers/boot-fixtures';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  document.getElementById('m365-boot')?.remove();
});

interface Pending {
  readonly url: string;
  readonly method: string;
  readonly credentials: RequestCredentials | undefined;
  readonly resolve: (response: Response) => void;
}

/** A network whose answers the test gives by hand, one request at a time. */
function manualNetwork() {
  const requests: Pending[] = [];
  const fetchFunction: FetchFunction = (input, init) =>
    new Promise<Response>((resolve) => {
      requests.push({
        url: input,
        method: init?.method ?? 'GET',
        credentials: init?.credentials,
        resolve,
      });
    });
  return { fetch: fetchFunction, requests };
}

function meResponse(me: MeResponse, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(me), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function setup(boot: BootData | null) {
  const net = manualNetwork();
  const api = createApiClient({ fetch: net.fetch, buildVersion: null });
  const queryClient = createAppQueryClient();
  if (boot) seedQueryClient(queryClient, boot, api);
  const store = createSessionStore();
  const run = () => recheckBootSession({ boot, queryClient, api, store });
  return { net, api, queryClient, store, run };
}

const bootOf = (me: MeResponse): BootData => ({ me, branding: sampleBranding('Acme') });
const cachedMe = (queryClient: QueryClient) => queryClient.getQueryData<MeResponse>(queryKeys.me);

describe('when the check is made', () => {
  it('sends exactly one same-origin GET /api/v1/me when the boot actor is anonymous and the setup is not unconfigured', async () => {
    for (const state of ['in_progress', 'awaiting_first_signin', 'completed'] as const) {
      const { net, run } = setup(bootOf(sampleMe({ setupState: state })));
      const result = run();
      await vi.advanceTimersByTimeAsync(0);
      expect(net.requests, state).toHaveLength(1);
      expect(net.requests[0]).toMatchObject({
        url: '/api/v1/me',
        method: 'GET',
        credentials: 'same-origin',
      });
      net.requests[0]?.resolve(meResponse(sampleMe({ setupState: state })));
      await expect(result).resolves.toMatchObject({ outcome: 'anonymous' });
      expect(net.requests, state).toHaveLength(1);
    }
  });

  it('sends nothing when the setup is unconfigured: nobody has a session yet', async () => {
    const { net, run } = setup(bootOf(sampleMe({ setupState: 'unconfigured' })));
    await expect(run()).resolves.toEqual({ outcome: 'skipped' });
    expect(net.requests).toEqual([]);
  });

  it('sends nothing when the boot actor is signed in, whatever the kind', async () => {
    for (const me of [
      sampleSignedInMe(),
      sampleMe({ kind: 'setup', setupState: 'in_progress' }),
      sampleMe({ kind: 'break_glass', breakGlass: true }),
    ]) {
      const { net, run } = setup(bootOf(me));
      await expect(run(), me.actor.kind).resolves.toEqual({ outcome: 'skipped' });
      expect(net.requests, me.actor.kind).toEqual([]);
    }
  });
});

describe('the answer', () => {
  it('replaces the boot data when the answer is a signed-in actor, so the first paint has the persona', async () => {
    const { net, run, queryClient, store } = setup(bootOf(sampleMe()));
    expect(cachedMe(queryClient)?.actor.kind).toBe('anonymous');
    const result = run();
    await vi.advanceTimersByTimeAsync(0);
    const signedIn = sampleSignedInMe({ label: 'Alice Example' });
    net.requests[0]?.resolve(
      meResponse(signedIn, { 'X-Session-Idle-Expires': '2026-10-12T12:30:00.000Z' }),
    );
    await expect(result).resolves.toEqual({ outcome: 'signed_in' });
    expect(cachedMe(queryClient)).toEqual(signedIn);
    // The deadline of the idle timeout is known from the first moment (the body only seeds it).
    expect(store.getSnapshot().idleExpiresAt).not.toBeNull();
  });

  it('goes on with the boot data when the answer is anonymous', async () => {
    const boot = bootOf(sampleMe());
    const { net, run, queryClient } = setup(boot);
    const result = run();
    await vi.advanceTimersByTimeAsync(0);
    net.requests[0]?.resolve(meResponse(sampleMe()));
    await expect(result).resolves.toEqual({ outcome: 'anonymous' });
    expect(cachedMe(queryClient)?.actor.kind).toBe('anonymous');
  });

  it('goes on with the boot data when the request fails or answers something that is not a me', async () => {
    for (const response of [
      new Response('{}', { status: 500, headers: { 'Content-Type': 'application/problem+json' } }),
      new Response('<html>proxy</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
      new Response(JSON.stringify({ actor: 'nobody' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ]) {
      const { net, run, queryClient } = setup(bootOf(sampleMe()));
      const result = run();
      await vi.advanceTimersByTimeAsync(0);
      net.requests[0]?.resolve(response);
      await expect(result).resolves.toEqual({ outcome: 'failed' });
      expect(cachedMe(queryClient)?.actor.kind).toBe('anonymous');
    }
  });
});

describe('the cap of 800 ms', () => {
  it('is 800 ms', () => {
    expect(RECHECK_CAP_MS).toBe(800);
  });

  it('stops waiting at 800 ms and goes on with the boot data, not a millisecond earlier', async () => {
    const { net, run } = setup(bootOf(sampleMe()));
    let settled: string | undefined;
    void run().then((result) => {
      settled = result.outcome;
    });
    await vi.advanceTimersByTimeAsync(799);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe('timeout');
    expect(net.requests).toHaveLength(1);
  });

  it('applies a signed-in answer that arrives after the cap, so a slow server does not hide the session', async () => {
    const { net, run, queryClient } = setup(bootOf(sampleMe()));
    const result = run();
    await vi.advanceTimersByTimeAsync(800);
    await expect(result).resolves.toEqual({ outcome: 'timeout' });
    expect(cachedMe(queryClient)?.actor.kind).toBe('anonymous');
    const signedIn = sampleSignedInMe();
    await act(async () => {
      net.requests[0]?.resolve(meResponse(signedIn));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(cachedMe(queryClient)).toEqual(signedIn);
  });

  it('does not let a late anonymous answer replace anything', async () => {
    const { net, run, queryClient } = setup(bootOf(sampleMe()));
    const result = run();
    await vi.advanceTimersByTimeAsync(800);
    await result;
    await act(async () => {
      net.requests[0]?.resolve(meResponse(sampleMe({ version: '9.9.9' })));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(cachedMe(queryClient)?.version).toBe(sampleMe().version);
  });
});

describe('a boot block that is missing or malformed', () => {
  it('is read as no boot data, and the check then asks for the actor once', async () => {
    installBootBlock(document, escapeForScript('{"me": {"actor": "x"}, "branding": 7}'));
    expect(readBootData(document)).toBeNull();
    const { net, run, queryClient } = setup(null);
    const result = run();
    await vi.advanceTimersByTimeAsync(0);
    expect(net.requests).toHaveLength(1);
    net.requests[0]?.resolve(meResponse(sampleSignedInMe()));
    await expect(result).resolves.toEqual({ outcome: 'signed_in' });
    expect(cachedMe(queryClient)?.actor.kind).toBe('user');
  });

  it('falls back to the anonymous gate when that one request fails too', async () => {
    const { net, run, queryClient } = setup(null);
    const result = run();
    await vi.advanceTimersByTimeAsync(0);
    net.requests[0]?.resolve(new Response('', { status: 502 }));
    await expect(result).resolves.toEqual({ outcome: 'failed' });
    expect(cachedMe(queryClient)).toBeUndefined();
  });
});

describe('before the gate (the cross-site entry of PB-15)', () => {
  function appWith(boot: BootData, path: string) {
    const net = manualNetwork();
    const api = createApiClient({ fetch: net.fetch, buildVersion: null });
    const queryClient = createAppQueryClient();
    seedQueryClient(queryClient, boot, api);
    const store = createSessionStore();
    const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }), {
      queryClient,
      api,
    });
    return { net, api, queryClient, store, router };
  }

  it('does not bounce a signed-in person: the signed-in answer comes before the gate looks at the actor', async () => {
    const boot = bootOf(sampleMe());
    const { net, api, queryClient, store, router } = appWith(boot, '/users');
    const check = recheckBootSession({ boot, queryClient, api, store });
    await vi.advanceTimersByTimeAsync(0);
    net.requests[0]?.resolve(meResponse(sampleSignedInMe()));
    await check;
    await router.load();
    expect(router.state.location.pathname).toBe('/users');
  });

  it('sends an anonymous answer on to /signin?returnTo=<the path>', async () => {
    const boot = bootOf(sampleMe());
    const { net, api, queryClient, store, router } = appWith(boot, '/users');
    const check = recheckBootSession({ boot, queryClient, api, store });
    await vi.advanceTimersByTimeAsync(0);
    net.requests[0]?.resolve(meResponse(sampleMe()));
    await check;
    await router.load();
    expect(router.state.location.pathname).toBe('/signin');
    expect(router.state.location.search).toEqual({ returnTo: '/users' });
  });
});
