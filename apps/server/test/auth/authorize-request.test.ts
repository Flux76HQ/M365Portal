// T-B-182: FR-B-402, FR-B-415 (class), EB-16, US-B5 item 1, CD-01, SB-22. The login transaction and
// `GET /auth/login`: what a transaction holds (random values from the injected source), its bounds
// (1,000 in total, 20 per client, 600 s, single use), and the redirect to Entra with exactly the
// parameter list of the spec, the Lax transaction cookie, and the refusals that create nothing.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createLoginTransactions,
  type LoginTransactions,
} from '../../src/auth/login-transactions.js';
import type { RandomSource } from '../../src/ports/clock.js';
import { expectGuardFails } from '@m365portal/shared/testing';
import { seedSession } from '../helpers/signed-in.js';
import { fake, testClock } from '../support/msw.js';
import { startSignInScene } from './support/signin-scene.js';

const SECOND = 1000;

/** Bytes from a counter, remembering how many bytes each draw asked for. */
function recordingRandom(): RandomSource & { readonly draws: number[] } {
  const draws: number[] = [];
  return {
    draws,
    bytes(length) {
      draws.push(length);
      // Distinct for every draw: the hash of the draw's number.
      return new Uint8Array(createHash('sha256').update(`draw-${String(draws.length)}`).digest()).slice(0, length);
    },
    float: () => 0.5,
  };
}

function store(now: { value: number }, random: RandomSource = recordingRandom()): LoginTransactions {
  return createLoginTransactions({ clock: { now: () => now.value }, random });
}

const SIGN_IN = {
  purpose: 'signin',
  returnTo: '/',
  stepUpSessionHash: null,
  clientKey: '203.0.113.1',
} as const;

describe('the login transaction (FR-B-402)', () => {
  it('holds id, state, nonce and verifier of 32 random bytes each (43 base64url characters)', () => {
    const random = recordingRandom();
    const transaction = store({ value: 0 }, random).start(SIGN_IN);
    expect(random.draws).toEqual([32, 32, 32, 32]);
    for (const value of [
      transaction.id,
      transaction.state,
      transaction.nonce,
      transaction.codeVerifier,
    ]) {
      expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
    expect(new Set([transaction.id, transaction.state, transaction.nonce, transaction.codeVerifier]).size)
      .toBe(4);
    expect(transaction.startedAt).toBe(0);
    expect(transaction.stepUpSessionHash).toBeNull();
  });

  it('is single use', () => {
    const transactions = store({ value: 0 });
    const { id } = transactions.start(SIGN_IN);
    expect(transactions.take(id)?.id).toBe(id);
    expect(transactions.take(id)).toBeUndefined();
  });

  it('lives 600 seconds: valid at 599.999 s, gone at 600 s', () => {
    const now = { value: 1_000_000 };
    const transactions = store(now);
    const early = transactions.start(SIGN_IN);
    const late = transactions.start(SIGN_IN);
    now.value += 600 * SECOND - 1;
    expect(transactions.take(early.id)).toBeDefined();
    now.value += 1;
    expect(transactions.take(late.id)).toBeUndefined();
  });

  it('keeps 20 per client address: the 21st evicts the oldest of that client only', () => {
    const now = { value: 0 };
    const transactions = store(now);
    const other = transactions.start({ ...SIGN_IN, clientKey: '203.0.113.99' });
    const mine = Array.from({ length: 20 }, () => {
      now.value += 1;
      return transactions.start(SIGN_IN);
    });
    now.value += 1;
    const newest = transactions.start(SIGN_IN);
    expect(transactions.take(mine[0]?.id ?? '')).toBeUndefined();
    expect(transactions.take(mine[1]?.id ?? '')).toBeDefined();
    expect(transactions.take(newest.id)).toBeDefined();
    expect(transactions.take(other.id)).toBeDefined();
  });

  it('keeps 1,000 in total: the 1,001st evicts the oldest overall', () => {
    const transactions = store({ value: 0 });
    const first = transactions.start({ ...SIGN_IN, clientKey: 'client-0' });
    for (let index = 1; index < 1000; index += 1) {
      transactions.start({ ...SIGN_IN, clientKey: `client-${String(index)}` });
    }
    expect(transactions.size).toBe(1000);
    transactions.start({ ...SIGN_IN, clientKey: 'client-new' });
    expect(transactions.size).toBe(1000);
    expect(transactions.take(first.id)).toBeUndefined();
  });

  it('sweeps the expired ones and no others', () => {
    const now = { value: 0 };
    const transactions = store(now);
    transactions.start(SIGN_IN);
    now.value = 300 * SECOND;
    const young = transactions.start(SIGN_IN);
    now.value = 600 * SECOND;
    expect(transactions.sweep()).toBe(1);
    expect(transactions.size).toBe(1);
    expect(transactions.take(young.id)).toBeDefined();
  });

  it('negative: a store that never evicts fails the per-client bound', () => {
    function assertPerClientBound(make: (now: { value: number }) => LoginTransactions): void {
      const transactions = make({ value: 0 });
      const ids = Array.from({ length: 21 }, () => transactions.start(SIGN_IN).id);
      if (transactions.take(ids[0] ?? '') !== undefined) {
        throw new Error('the 21st transaction of a client did not evict the oldest');
      }
    }
    assertPerClientBound(store);
    const unbounded = (now: { value: number }): LoginTransactions => {
      const kept = new Map<string, ReturnType<LoginTransactions['start']>>();
      const inner = store(now);
      return {
        start: (input) => {
          const transaction = inner.start({ ...input, clientKey: `${input.clientKey}-${String(kept.size)}` });
          kept.set(transaction.id, transaction);
          return transaction;
        },
        take: (id) => inner.take(id),
        sweep: () => inner.sweep(),
        get size() {
          return inner.size;
        },
      };
    };
    expectGuardFails(assertPerClientBound, unbounded, {
      name: 'per-client bound',
      reason: 'did not evict',
    });
  });
});

describe('GET /auth/login (P01)', () => {
  it('answers 303 to the tenant-pinned authorize URL with exactly the listed parameters', async () => {
    const scene = await startSignInScene();
    const result = await scene.browser().navigate('/auth/login?returnTo=/users', {
      maxRedirects: 0,
    });
    expect(result.status).toBe(303);
    const location = new URL(result.headers.get('location') ?? '');
    expect(`${location.origin}${location.pathname}`).toBe(
      `https://login.microsoftonline.com/${scene.world.tenantId}/oauth2/v2.0/authorize`,
    );
    expect([...location.searchParams.keys()].sort()).toEqual(
      [
        'client_id',
        'code_challenge',
        'code_challenge_method',
        'nonce',
        'redirect_uri',
        'response_mode',
        'response_type',
        'scope',
        'state',
      ].sort(),
    );
    const params = location.searchParams;
    expect(params.get('client_id')).toBe(scene.world.app.appId);
    expect(params.get('response_type')).toBe('code');
    expect(params.get('response_mode')).toBe('query');
    expect(params.get('scope')).toBe('openid profile');
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('redirect_uri')).toBe(`${scene.origin}/auth/callback`);
    expect(params.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(params.get('nonce')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(params.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    for (const forbidden of ['max_age', 'claims', 'login_hint', 'offline_access']) {
      expect(location.href).not.toContain(forbidden);
    }
    expect(result.headers.get('cache-control')).toBe('no-store');
  });

  it('sets the Lax transaction cookie, 600 s, HttpOnly, no Domain, and nothing else', async () => {
    const scene = await startSignInScene();
    const result = await scene.browser().navigate('/auth/login', { maxRedirects: 0 });
    expect(result.setCookies).toHaveLength(1);
    const cookie = result.setCookies[0] ?? '';
    expect(cookie).toMatch(/^m365portal_oidc=[A-Za-z0-9_-]{43};/);
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Max-Age=600');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Path=/');
    expect(cookie).not.toMatch(/Domain/i);
    expect(cookie).not.toContain('Secure');
  });

  it('gives every login its own state, nonce and transaction', async () => {
    const scene = await startSignInScene();
    const one = await scene.browser().navigate('/auth/login', { maxRedirects: 0 });
    const two = await scene.browser().navigate('/auth/login', { maxRedirects: 0 });
    const stateOf = (location: string | null): string | null =>
      new URL(location ?? '').searchParams.get('state');
    expect(stateOf(one.headers.get('location'))).not.toBe(stateOf(two.headers.get('location')));
    expect(one.setCookies[0]).not.toBe(two.setCookies[0]);
  });

  it('passes prompt=login and prompt=select_account and drops every other value', async () => {
    const scene = await startSignInScene();
    const promptOf = async (query: string): Promise<string | null> => {
      const result = await scene.browser().navigate(`/auth/login${query}`, { maxRedirects: 0 });
      return new URL(result.headers.get('location') ?? '').searchParams.get('prompt');
    };
    expect(await promptOf('?prompt=login')).toBe('login');
    expect(await promptOf('?prompt=select_account')).toBe('select_account');
    expect(await promptOf('?prompt=none')).toBeNull();
    expect(await promptOf('?prompt=consent')).toBeNull();
    expect(await promptOf('?prompt=')).toBeNull();
    expect(await promptOf('')).toBeNull();
  });

  it('treats a purpose other than stepup as a sign-in', async () => {
    const scene = await startSignInScene();
    const result = await scene.browser().navigate('/auth/login?purpose=admin', { maxRedirects: 0 });
    expect(result.status).toBe(303);
    expect(result.headers.get('location')).toContain('login.microsoftonline.com');
  });

  it('step-up without a user session redirects to the sign-in page with session_expired', async () => {
    const scene = await startSignInScene();
    const result = await scene
      .browser()
      .navigate('/auth/login?purpose=stepup&returnTo=/settings/connection', { maxRedirects: 0 });
    expect(result.status).toBe(303);
    expect(result.headers.get('location')).toBe(
      '/signin?error=session_expired&returnTo=%2Fsettings%2Fconnection',
    );
    expect(result.setCookies).toEqual([]);
    expect(fake.calls.all().filter((call) => call.path.includes('/authorize'))).toHaveLength(0);
  });

  it('step-up with a break-glass session is refused the same way', async () => {
    const scene = await startSignInScene();
    const database = scene.database();
    const seeded = seedSession(database, scene.origin, {
      kind: 'break_glass',
      now: testClock.nowMs(),
    });
    const browser = scene.browser();
    browser.setCookie('m365portal_session', seeded.value);
    const result = await browser.navigate('/auth/login?purpose=stepup', { maxRedirects: 0 });
    expect(result.headers.get('location')).toBe('/signin?error=session_expired');
    expect(result.setCookies).toEqual([]);
  });

  it('step-up with a user session starts: prompt=login, no other prompt', async () => {
    const scene = await startSignInScene();
    const database = scene.database();
    const seeded = seedSession(database, scene.origin, {
      oid: scene.userId,
      now: testClock.nowMs(),
      mfa: true,
    });
    const browser = scene.browser();
    browser.setCookie('m365portal_session', seeded.value);
    const result = await browser.navigate('/auth/login?purpose=stepup&prompt=select_account', {
      maxRedirects: 0,
    });
    expect(result.status).toBe(303);
    const location = new URL(result.headers.get('location') ?? '');
    expect(location.searchParams.get('prompt')).toBe('login');
  });
});

describe('refusals create no transaction (SB-22)', () => {
  it.each(['unconfigured', 'in_progress'] as const)(
    'while the state is %s: 303 to /signin?error=setup_required and no cookie',
    async (state) => {
      const scene = await startSignInScene({ state });
      const result = await scene.browser().navigate('/auth/login', { maxRedirects: 0 });
      expect(result.status).toBe(303);
      expect(result.headers.get('location')).toBe('/signin?error=setup_required');
      expect(result.setCookies).toEqual([]);
    },
  );

  it('without a pinned tenant: setup_required', async () => {
    const scene = await startSignInScene({ state: 'awaiting_first_signin', pinned: false });
    const result = await scene.browser().navigate('/auth/login', { maxRedirects: 0 });
    expect(result.headers.get('location')).toBe('/signin?error=setup_required');
    expect(result.setCookies).toEqual([]);
  });

  it('from awaiting_first_signin on, sign-in starts', async () => {
    const scene = await startSignInScene({ state: 'awaiting_first_signin' });
    const result = await scene.browser().navigate('/auth/login', { maxRedirects: 0 });
    expect(result.headers.get('location')).toContain('/oauth2/v2.0/authorize');
  });

  it('while the secrets are unavailable: secrets_unavailable and no cookie', async () => {
    const scene = await startSignInScene({ secrets: { status: 'key_missing' } });
    const result = await scene.browser().navigate('/auth/login', { maxRedirects: 0 });
    expect(result.status).toBe(303);
    expect(result.headers.get('location')).toBe('/signin?error=secrets_unavailable');
    expect(result.setCookies).toEqual([]);
  });

  it('is rated in the auth class: ten in a burst, then 429', async () => {
    const scene = await startSignInScene();
    const statuses: number[] = [];
    for (let index = 0; index < 12; index += 1) {
      statuses.push((await scene.browser().navigate('/auth/login', { maxRedirects: 0 })).status);
    }
    expect(statuses.slice(0, 10).every((status) => status === 303)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });
});
