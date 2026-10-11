// The branding data layer (T-A-210; FR-A-132, FR-A-083 client, FR-A-112; E-11, E-14): typed calls over the
// S4 API client, a 412 as a typed conflict, the expected origin of origin_not_allowed, lazy Zod schemas,
// and the branding query invalidated after apply, reset and import. The network is a fake `fetch`.
import { expectGuardFails } from '@m365portal/shared/testing';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it, vi, type MockInstance } from 'vitest';
import { ApiError, createApiClient, type FetchFunction } from '../../src/lib/api';
import { queryKeys } from '../../src/lib/query';
import {
  BRANDING_EXPORT_PATH,
  BrandingConflictError,
  createBrandingApi,
  expectedOriginOf,
  isBrandingConflict,
} from '../../src/features/branding/api';
import {
  useApplyBranding,
  useImportBranding,
  useResetBranding,
  useStageAsset,
} from '../../src/features/branding/queries';
import { sampleBranding } from '../helpers/boot-fixtures';

// ---------------------------------------------------------------------------------------------
// A fake network
// ---------------------------------------------------------------------------------------------

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: BodyInit | null | undefined;
}

function network(handler: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetchFunction: FetchFunction = (input, init) => {
    const call: Call = {
      url: input,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: init?.body,
    };
    calls.push(call);
    const path = new URL(input, 'http://panel.test').pathname;
    if (path === '/api/v1/csrf') {
      return Promise.resolve(
        json({ token: 'throwaway-token-value', expiresAt: '2099-01-01T00:00:00.000Z' }),
      );
    }
    return Promise.resolve(handler(call));
  };
  return { fetch: fetchFunction, calls, writes: () => calls.filter((c) => c.method !== 'GET') };
}

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  return new Response(JSON.stringify(body), { status: 200, ...init, headers });
}

function problem(status: number, code: string, extra: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      type: `urn:m365portal:problem:${code}`,
      title: 'English title',
      status,
      detail: 'English detail',
      code,
      requestId: 'req-0123456789',
      ...extra,
    }),
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  );
}

const HASH_A = 'a'.repeat(64);
const REQUEST = {
  orgName: 'Acme',
  accent: '#0078d4',
  logos: { light: HASH_A, dark: null, compact: null },
} as const;

function clientFor(handler: (call: Call) => Response) {
  const net = network(handler);
  const branding = createBrandingApi(createApiClient({ fetch: net.fetch, buildVersion: null }));
  return { net, branding };
}

const urlOf = (call: Call): URL => new URL(call.url, 'http://panel.test');

// ---------------------------------------------------------------------------------------------
// Typed calls
// ---------------------------------------------------------------------------------------------

describe('typed calls', () => {
  it('gets the branding and checks it against the shared schema', async () => {
    const current = sampleBranding('Acme');
    const { net, branding } = clientFor(() => json(current, { headers: { ETag: '"1"' } }));
    await expect(branding.get()).resolves.toEqual(current);
    expect(net.calls[0]?.method).toBe('GET');
    expect(urlOf(net.calls[0]!).pathname).toBe('/api/v1/branding');
  });

  it('refuses an answer that does not fit the schema (invalid_response)', async () => {
    const { branding } = clientFor(() => json({ revision: 'one' }));
    await expect(branding.get()).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('stages a file as multipart with exactly one `file` part and the slot in the query', async () => {
    const response = {
      asset: {
        hash: HASH_A,
        url: `/branding/${HASH_A}.png`,
        width: 64,
        height: 32,
        luminance: 0.5,
        bytes: 1200,
        created: true,
      },
      warnings: [{ code: 'animation_flattened' }],
    };
    const { net, branding } = clientFor(() => json(response, { status: 201 }));
    const file = new File([new Uint8Array([1, 2, 3])], 'logo.png', { type: 'image/png' });

    const result = await branding.stage('logoDark', file);

    expect(result).toEqual(response);
    const call = net.writes()[0]!;
    expect(call.method).toBe('POST');
    expect(urlOf(call).pathname).toBe('/api/v1/branding/assets');
    expect(urlOf(call).searchParams.get('slot')).toBe('logoDark');
    expect([...urlOf(call).searchParams.keys()]).toEqual(['slot']);
    expect(call.body).toBeInstanceOf(FormData);
    const form = call.body as FormData;
    expect([...form.keys()]).toEqual(['file']);
    expect(call.headers.get('X-CSRF-Token')).toBe('throwaway-token-value');
    // The browser sets the multipart boundary; the client must not set a content type of its own.
    expect(call.headers.get('Content-Type')).toBeNull();
  });

  it('applies with If-Match "<revision>" and the request as JSON', async () => {
    const next = { ...sampleBranding('Acme'), revision: 4 };
    const { net, branding } = clientFor(() => json(next));
    await expect(branding.apply(REQUEST, 3)).resolves.toEqual(next);
    const call = net.writes()[0]!;
    expect(call.method).toBe('PUT');
    expect(urlOf(call).pathname).toBe('/api/v1/branding');
    expect(call.headers.get('If-Match')).toBe('"3"');
    expect(JSON.parse(call.body as string)).toEqual(REQUEST);
  });

  it('resets with If-Match and no body', async () => {
    const { net, branding } = clientFor(() => json(sampleBranding()));
    await branding.reset(7);
    const call = net.writes()[0]!;
    expect(call.method).toBe('DELETE');
    expect(call.headers.get('If-Match')).toBe('"7"');
    expect(call.body).toBeUndefined();
  });

  it('exports through a plain link (no request is made)', () => {
    expect(BRANDING_EXPORT_PATH).toBe('/api/v1/branding/export');
  });

  const IMPORT_TEXT = JSON.stringify({
    schemaVersion: 1,
    orgName: 'Acme',
    accent: '#0078d4',
    images: { logoLight: null, logoDark: null, compact: null },
  });
  const dryRunResult = {
    dryRun: true,
    applied: false,
    orgName: 'Acme',
    accent: '#0078d4',
    images: { logoLight: null, logoDark: null, compact: null },
    branding: null,
  };

  it('imports a dry run with ?dryRun=true, the text unchanged and no If-Match', async () => {
    const { net, branding } = clientFor(() => json(dryRunResult));
    await expect(branding.importDocument(IMPORT_TEXT, { dryRun: true })).resolves.toEqual(
      dryRunResult,
    );
    const call = net.writes()[0]!;
    expect(call.method).toBe('POST');
    expect(urlOf(call).pathname).toBe('/api/v1/branding/import');
    expect(urlOf(call).searchParams.get('dryRun')).toBe('true');
    expect(call.headers.has('If-Match')).toBe(false);
    expect(call.body).toBeInstanceOf(Blob);
    expect(await (call.body as Blob).text()).toBe(IMPORT_TEXT);
  });

  it('imports for real with ?dryRun=false and the If-Match of the loaded revision', async () => {
    const applied = {
      ...dryRunResult,
      dryRun: false,
      applied: true,
      branding: { ...sampleBranding('Acme'), revision: 2 },
    };
    const { net, branding } = clientFor(() => json(applied));
    await branding.importDocument(IMPORT_TEXT, { dryRun: false, revision: 1 });
    const call = net.writes()[0]!;
    expect(urlOf(call).searchParams.get('dryRun')).toBe('false');
    expect(call.headers.get('If-Match')).toBe('"1"');
  });

  it('refuses a real import without a revision before any request is made', async () => {
    const { net, branding } = clientFor(() => json(dryRunResult));
    await expect(branding.importDocument(IMPORT_TEXT, { dryRun: false })).rejects.toThrow();
    expect(net.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------------------------

describe('typed errors', () => {
  it('turns a 412 branding_conflict into a BrandingConflictError that is still an ApiError', async () => {
    const { branding } = clientFor(() => problem(412, 'branding_conflict'));
    const error: unknown = await branding.apply(REQUEST, 1).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BrandingConflictError);
    expect(error).toBeInstanceOf(ApiError);
    expect(isBrandingConflict(error)).toBe(true);
    expect(error).toMatchObject({
      code: 'branding_conflict',
      status: 412,
      requestId: 'req-0123456789',
    });
  });

  it('does not call another 412 or another error a conflict', async () => {
    const { branding } = clientFor(() => problem(422, 'org_name_invalid'));
    const error: unknown = await branding.apply(REQUEST, 1).catch((caught: unknown) => caught);
    expect(error).not.toBeInstanceOf(BrandingConflictError);
    expect(isBrandingConflict(error)).toBe(false);
    expect(isBrandingConflict(new Error('x'))).toBe(false);
  });

  it('exposes the expected origin of origin_not_allowed', async () => {
    const { branding } = clientFor(() =>
      problem(403, 'origin_not_allowed', { expectedOrigin: 'https://panel.example.com' }),
    );
    const error: unknown = await branding.reset(1).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(expectedOriginOf(error)).toBe('https://panel.example.com');
    expect(expectedOriginOf(new Error('x'))).toBeNull();
    expect(
      expectedOriginOf(
        new ApiError({
          code: 'permission_denied',
          status: 403,
          requestId: null,
          errors: [],
          expectedOrigin: null,
          retryAfterSeconds: null,
        }),
      ),
    ).toBeNull();
  });

  it('keeps Retry-After on image_processing_busy for the retry offer', async () => {
    const { branding } = clientFor(
      () =>
        new Response(
          JSON.stringify({ code: 'image_processing_busy', requestId: 'req-0123456789' }),
          {
            status: 429,
            headers: { 'Content-Type': 'application/problem+json', 'Retry-After': '4' },
          },
        ),
    );
    const file = new File([new Uint8Array([1])], 'a.png');
    await expect(branding.stage('compact', file)).rejects.toMatchObject({
      code: 'image_processing_busy',
      retryAfterSeconds: 4,
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Zod schemas are imported lazily
// ---------------------------------------------------------------------------------------------

interface SourceFile {
  readonly path: string;
  readonly text: string;
}

const BRANDING_SOURCE = join(import.meta.dirname, '..', '..', 'src', 'features', 'branding');

function sourcesIn(directory: string): SourceFile[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => {
      const path = join(entry.parentPath, entry.name);
      return { path: relative(directory, path), text: readFileSync(path, 'utf8') };
    });
}

/** Comments are not code. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** A value import (not `import type`, not a type-only specifier list) of a shared schemas module. */
const STATIC_SCHEMA_IMPORT =
  /(?:^|\n)\s*(?:import|export)\s+(?!type\b)(?:[^'";]*?\sfrom\s+)?['"]@m365portal\/shared\/schemas\//;

function assertNoStaticSchemaImport(files: readonly SourceFile[]): void {
  const offenders = files
    .filter((file) => STATIC_SCHEMA_IMPORT.test(stripComments(file.text)))
    .map((file) => file.path);
  if (offenders.length > 0) {
    throw new Error(`static import of @m365portal/shared/schemas/* in: ${offenders.join(', ')}`);
  }
}

describe('lazy schemas', () => {
  it('no module of the branding feature imports a shared schema statically', () => {
    const files = sourcesIn(BRANDING_SOURCE);
    expect(files.length).toBeGreaterThan(0);
    assertNoStaticSchemaImport(files);
  });

  it('the data layer does import them, dynamically', () => {
    const api = readFileSync(join(BRANDING_SOURCE, 'api.ts'), 'utf8');
    expect(api).toMatch(/import\(\s*['"]@m365portal\/shared\/schemas\/branding['"]\s*\)/);
  });

  it('negative fixtures: a static value import fails the scan, a type import does not', () => {
    for (const text of [
      "import { BrandingSchema } from '@m365portal/shared/schemas/branding';",
      "import * as schemas from '@m365portal/shared/schemas/assets';",
      "import '@m365portal/shared/schemas/branding';",
      "export { BrandingSchema } from '@m365portal/shared/schemas/branding';",
      "import { type Branding, BrandingSchema } from '@m365portal/shared/schemas/branding';",
    ]) {
      expectGuardFails(assertNoStaticSchemaImport, [{ path: 'Sneaky.ts', text }], {
        name: 'assertNoStaticSchemaImport',
        reason: 'static import',
      });
    }
    expect(() => {
      assertNoStaticSchemaImport([
        {
          path: 'Fine.ts',
          text: "import type { Branding } from '@m365portal/shared/schemas/branding';\n// import { X } from '@m365portal/shared/schemas/branding';\nconst m = () => import('@m365portal/shared/schemas/branding');",
        },
      ]);
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------
// The branding query is invalidated
// ---------------------------------------------------------------------------------------------

function harness(handler: (call: Call) => Response) {
  const net = network(handler);
  const api = createApiClient({ fetch: net.fetch, buildVersion: null });
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  queryClient.setQueryData(queryKeys.branding, sampleBranding('Acme'));
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  const wrapper = ({ children }: { readonly children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  return { net, api, queryClient, invalidate, wrapper };
}

const brandingInvalidated = (invalidate: MockInstance<QueryClient['invalidateQueries']>): boolean =>
  invalidate.mock.calls.some(
    ([filters]) =>
      JSON.stringify((filters as { queryKey?: unknown } | undefined)?.queryKey) ===
      JSON.stringify(queryKeys.branding),
  );

describe('query invalidation', () => {
  it('after apply: the cache holds the answer and the branding query is invalidated', async () => {
    const next = { ...sampleBranding('Acme Two'), revision: 2 };
    const { api, queryClient, invalidate, wrapper } = harness(() => json(next));
    const { result } = renderHook(() => useApplyBranding(api), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ request: REQUEST, revision: 1 });
    });
    expect(queryClient.getQueryData(queryKeys.branding)).toEqual(next);
    expect(brandingInvalidated(invalidate)).toBe(true);
  });

  it('after reset', async () => {
    const fresh = { ...sampleBranding(), revision: 3 };
    const { api, queryClient, invalidate, wrapper } = harness(() => json(fresh));
    const { result } = renderHook(() => useResetBranding(api), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ revision: 2 });
    });
    expect(queryClient.getQueryData(queryKeys.branding)).toEqual(fresh);
    expect(brandingInvalidated(invalidate)).toBe(true);
  });

  it('after an applied import, but not after a dry run', async () => {
    const applied = {
      dryRun: false,
      applied: true,
      orgName: 'Imported',
      accent: '#0078d4',
      images: { logoLight: null, logoDark: null, compact: null },
      branding: { ...sampleBranding('Imported'), revision: 2 },
    };
    const dry = { ...applied, dryRun: true, applied: false, branding: null };
    let answer: unknown = dry;
    const { api, queryClient, invalidate, wrapper } = harness(() => json(answer));
    const { result } = renderHook(() => useImportBranding(api), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ text: '{}', dryRun: true });
    });
    expect(brandingInvalidated(invalidate)).toBe(false);
    expect(queryClient.getQueryData(queryKeys.branding)).toEqual(sampleBranding('Acme'));

    answer = applied;
    await act(async () => {
      await result.current.mutateAsync({ text: '{}', dryRun: false, revision: 1 });
    });
    expect(brandingInvalidated(invalidate)).toBe(true);
    expect(queryClient.getQueryData(queryKeys.branding)).toEqual(applied.branding);
  });

  it('a failed apply leaves the cache alone and invalidates nothing', async () => {
    const { api, queryClient, invalidate, wrapper } = harness(() =>
      problem(412, 'branding_conflict'),
    );
    const { result } = renderHook(() => useApplyBranding(api), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ request: REQUEST, revision: 1 }).catch(() => undefined);
    });
    await waitFor(() => {
      expect(result.current.error).toBeInstanceOf(BrandingConflictError);
    });
    expect(brandingInvalidated(invalidate)).toBe(false);
    expect(queryClient.getQueryData(queryKeys.branding)).toEqual(sampleBranding('Acme'));
  });

  it('staging does not touch the branding query', async () => {
    const response = {
      asset: {
        hash: HASH_A,
        url: `/branding/${HASH_A}.png`,
        width: 8,
        height: 8,
        luminance: null,
        bytes: 10,
        created: false,
      },
      warnings: [],
    };
    const { api, invalidate, wrapper } = harness(() => json(response));
    const { result } = renderHook(() => useStageAsset(api), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({
        slot: 'logoLight',
        file: new File([new Uint8Array([1])], 'a.png'),
      });
    });
    expect(brandingInvalidated(invalidate)).toBe(false);
  });
});
