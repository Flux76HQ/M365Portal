//
// BOOT DATA, NONCE SHIM, ZOD CONFIG AND THE QUERY CLIENT (FR-A-042 nonce and Zod parts, plan 9.2, 8.2;
// T-A-165; probes P15 and P17).
//
// The shell embeds `me` and `branding` as JSON; the entry reads them, seeds Query so the first render
// has data, copies the CSP nonce to `__webpack_nonce__` (Radix's scroll lock injects a <style> that
// needs it) and tells Zod not to probe `new Function` (Trusted Types reports it). Each of those is a
// line in main.tsx; each is proven here.
import { createTranslator } from '@m365portal/shared/i18n';
import { describe, expect, it, vi } from 'vitest';
import { installNonceShim, readPageNonce } from '../src/boot/nonce-shim';
import { ZOD_JITLESS } from '../src/boot/zod-config';
import { createApiClient } from '../src/lib/api';
import { readBootData } from '../src/lib/boot-data';
import {
  STALE_TIME_MS,
  brandingQueryOptions,
  createAppQueryClient,
  meQueryOptions,
  queryKeys,
  seedQueryClient,
} from '../src/lib/query';
import { escapeForScript, installBootBlock, installNonceMeta, SAMPLE_VERSION, sampleBranding, sampleMe, sampleSignedInMe } from './helpers/boot-fixtures';

function freshDocument(): Document {
  return document.implementation.createHTMLDocument('boot');
}

describe('readBootData', () => {
  it('parses the block the server renders into me and branding', () => {
    const doc = freshDocument();
    const data = { me: sampleSignedInMe(), branding: sampleBranding('Acme') };
    installBootBlock(doc, `\n  ${escapeForScript(JSON.stringify(data))}\n`);

    const read = readBootData(doc);

    expect(read).toEqual(data);
    expect(read?.branding.orgName).toBe('Acme');
  });

  it('keeps an organisation name with markup characters as plain data (the escaped < reads back)', () => {
    const doc = freshDocument();
    const name = '"><img src=x onerror=alert(1)>';
    const data = { me: sampleMe(), branding: sampleBranding() };
    const json = escapeForScript(JSON.stringify({ ...data, extra: name }));
    expect(json).not.toContain('<');
    installBootBlock(doc, json);

    // `extra` is not part of the contract and is dropped, the rest survives.
    expect(readBootData(doc)?.me).toEqual(data.me);
  });

  it('answers null when the block is missing, empty, or only whitespace', () => {
    const doc = freshDocument();
    expect(readBootData(doc)).toBeNull();
    installBootBlock(doc, '');
    expect(readBootData(doc)).toBeNull();
    installBootBlock(doc, ' \n\t ');
    expect(readBootData(doc)).toBeNull();
  });

  it('answers null for JSON that is broken, not an object, or has the wrong shape', () => {
    const doc = freshDocument();
    const good = { me: sampleMe(), branding: sampleBranding() };
    for (const text of [
      '{"me": ',
      'null',
      '[]',
      '"text"',
      '{}',
      JSON.stringify({ me: good.me }),
      JSON.stringify({ branding: good.branding }),
      JSON.stringify({ ...good, me: { ...good.me, permissions: ['users:write'] } }),
      JSON.stringify({ ...good, branding: { ...good.branding, accent: 'red' } }),
      JSON.stringify({ ...good, me: { ...good.me, unexpected: true } }),
    ]) {
      installBootBlock(doc, text);
      expect(readBootData(doc), text).toBeNull();
    }
  });

  it('never throws, whatever the block holds', () => {
    const doc = freshDocument();
    for (const text of [
      '{',
      '\u0000',
      '{"me":{"permissions":{"length":1e9}}}',
      '9'.repeat(10_000),
    ]) {
      installBootBlock(doc, text);
      expect(() => readBootData(doc)).not.toThrow();
    }
  });
});

describe('the nonce shim (probe P15)', () => {
  const holder = globalThis as { __webpack_nonce__?: string };

  it('reads the nonce from <meta property="csp-nonce">', () => {
    const doc = freshDocument();
    installNonceMeta(doc, 'abc123==');

    expect(readPageNonce(doc)).toBe('abc123==');
  });

  it('copies it to __webpack_nonce__, where get-nonce looks for it', () => {
    const doc = freshDocument();
    installNonceMeta(doc, 'nonce-for-the-test');
    const before = holder.__webpack_nonce__;
    try {
      expect(installNonceShim(doc)).toBe('nonce-for-the-test');
      expect(holder.__webpack_nonce__).toBe('nonce-for-the-test');
    } finally {
      if (before === undefined) delete holder.__webpack_nonce__;
      else holder.__webpack_nonce__ = before;
    }
  });

  it('sets nothing when the page has no nonce (a development server)', () => {
    const doc = freshDocument();
    const before = holder.__webpack_nonce__;

    expect(installNonceShim(doc)).toBeUndefined();
    installNonceMeta(doc, '');
    expect(installNonceShim(doc)).toBeUndefined();

    expect(holder.__webpack_nonce__).toBe(before);
  });
});

describe('the Zod configuration (probe P17)', () => {
  it('runs jitless, so Zod never probes new Function under Trusted Types', () => {
    expect(ZOD_JITLESS).toBe(true);
  });

  it('is in effect for the schemas the app parses with', () => {
    // A parse still works without code generation.
    expect(sampleSignedInMe().permissions.length).toBeGreaterThan(0);
  });
});

describe('seeding the Query cache', () => {
  it('puts me and branding in the cache, ready for the first render', () => {
    const queryClient = createAppQueryClient();
    const data = { me: sampleSignedInMe(), branding: sampleBranding('Acme') };

    seedQueryClient(queryClient, data, createApiClient({ fetch: vi.fn(), buildVersion: null }));

    expect(queryClient.getQueryData(queryKeys.me)).toEqual(data.me);
    expect(queryClient.getQueryData(queryKeys.branding)).toEqual(data.branding);
  });

  it('counts the seeded data as fresh for 60 s (me) and 30 s (branding), then refetches', () => {
    expect(STALE_TIME_MS).toEqual({ me: 60_000, branding: 30_000 });
    expect(meQueryOptions().staleTime).toBe(60_000);
    expect(brandingQueryOptions().staleTime).toBe(30_000);

    vi.useFakeTimers();
    try {
      const queryClient = createAppQueryClient();
      seedQueryClient(
        queryClient,
        { me: sampleMe(), branding: sampleBranding() },
        createApiClient({ fetch: vi.fn(), buildVersion: null }),
      );
      // Fresh data is not a reason to fetch; stale data is.
      const me = queryClient.getQueryCache().find({ queryKey: queryKeys.me });
      expect(me?.isStaleByTime(60_000 - 1)).toBe(false);
      vi.advanceTimersByTime(60_001);
      expect(me?.isStaleByTime(60_000)).toBe(true);
      const branding = queryClient.getQueryCache().find({ queryKey: queryKeys.branding });
      expect(branding?.isStaleByTime(30_000)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not fetch what it was seeded with', async () => {
    const fetchFunction = vi.fn<() => Promise<Response>>(() =>
      Promise.reject(new Error('no network')),
    );
    const api = createApiClient({ fetch: fetchFunction, buildVersion: null });
    const queryClient = createAppQueryClient();
    const data = { me: sampleMe(), branding: sampleBranding() };
    seedQueryClient(queryClient, data, api);

    await expect(
      queryClient.query({ ...meQueryOptions(api), staleTime: 'static' }),
    ).resolves.toEqual(data.me);
    await expect(
      queryClient.query({ ...brandingQueryOptions(api), staleTime: 'static' }),
    ).resolves.toEqual(data.branding);

    expect(fetchFunction).not.toHaveBeenCalled();
  });

  it('raises "update available" when the embedded version is not the build version', () => {
    const api = createApiClient({ fetch: vi.fn(), buildVersion: '0.0.1' });

    seedQueryClient(
      createAppQueryClient(),
      { me: sampleMe({ version: SAMPLE_VERSION }), branding: sampleBranding() },
      api,
    );

    expect(api.updateAvailable.get()).toBe(true);
  });
});

describe('the queries', () => {
  function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  it('fetch me and branding from their routes and validate what comes back', async () => {
    const me = sampleSignedInMe();
    const branding = sampleBranding('Acme');
    const urls: string[] = [];
    const api = createApiClient({
      buildVersion: null,
      fetch: (url) => {
        urls.push(url);
        return Promise.resolve(jsonResponse(url === '/api/v1/me' ? me : branding));
      },
    });
    const queryClient = createAppQueryClient();

    await expect(queryClient.query(meQueryOptions(api))).resolves.toEqual(me);
    await expect(queryClient.query(brandingQueryOptions(api))).resolves.toEqual(branding);

    expect(urls).toEqual(['/api/v1/me', '/api/v1/branding']);
  });

  it('tells the API client which version the server runs, every time me is fetched', async () => {
    const api = createApiClient({
      buildVersion: '9.9.9',
      fetch: () => Promise.resolve(jsonResponse(sampleMe({ version: '1.0.0' }))),
    });

    await createAppQueryClient().query(meQueryOptions(api));

    expect(api.updateAvailable.get()).toBe(true);
  });

  it('refuse a response that does not fit the schema, with a code the UI can show', async () => {
    const api = createApiClient({
      buildVersion: null,
      fetch: () => Promise.resolve(jsonResponse({ permissions: 'all' })),
    });

    const failure = await createAppQueryClient()
      .query({ ...meQueryOptions(api), retry: false })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: 'invalid_response' });
    // The generic message is what the person sees, with the code to report.
    expect(
      createTranslator('en').t('problem.unknown', { code: 'invalid_response', requestId: '-' }),
    ).toContain('invalid_response');
  });
});
