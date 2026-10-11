// The Appearance page on the real route tree with a fake branding server behind it (T-A-214, T-A-215).
// Not a test file. The server keeps one branding in memory and answers the routes the page calls the way
// the real one does: `If-Match` against the revision (412 `branding_conflict`), +1 per accepted change,
// the answer carries the whole `Branding`. A test can change the branding "from elsewhere" (`bumpFromElsewhere`).
import { deriveAccentTokens } from '@m365portal/shared/branding/accent';
import { monogramFor } from '@m365portal/shared/branding/monogram';
import { tryNormalizeAccent } from '@m365portal/shared/branding/accent';
import { tryNormalizeOrgName } from '@m365portal/shared/branding/org-name';
import { BrandingSchema, type Branding } from '@m365portal/shared/schemas/branding';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryHistory } from '@tanstack/react-router';
import { RootProviders } from '../../src/components/pages/root-providers';
import type { MeResponse } from '../../src/lib/boot-data';
import { createLanguageController } from '../../src/lib/locale';
import { createAppQueryClient, seedQueryClient } from '../../src/lib/query';
import { createStorage } from '../../src/lib/storage';
import { createAppRouter } from '../../src/router';
import { sampleBranding, sampleMe } from '../helpers/boot-fixtures';
import { fakeApi, jsonResponse, problemResponse, type RecordedCall } from './helpers';

export const HASH_A = 'a'.repeat(64);
export const HASH_B = 'b'.repeat(64);

export const assetRef = (hash: string, luminance: number | null = 0.4) => ({
  hash,
  url: `/branding/${hash}.png`,
  width: 240,
  height: 80,
  luminance,
});

export interface BrandingOverrides {
  readonly revision?: number;
  readonly orgName?: string;
  readonly accent?: string;
  readonly logos?: Partial<Branding['logos']>;
  readonly compactDerived?: boolean;
}

/** A valid `Branding` with the derived members computed by the real shared code. */
export function brandingWith(overrides: BrandingOverrides = {}): Branding {
  const base = sampleBranding(overrides.orgName ?? 'Acme');
  const accent = overrides.accent ?? base.accent;
  const logos = { ...base.logos, ...overrides.logos };
  return BrandingSchema.parse({
    ...base,
    revision: overrides.revision ?? 1,
    accent,
    tokens: deriveAccentTokens(accent),
    logos,
    compactDerived: overrides.compactDerived ?? false,
    monogram: monogramFor(base.orgName),
  });
}

export type Problem = readonly [status: number, code: string, extra?: Record<string, unknown>];

export interface FakeServer {
  current: Branding;
  readonly calls: RecordedCall[];
  /** A problem to answer the next write with, once. */
  failNext: Problem | 'network' | null;
  /** Somebody else saved: the revision moves on. */
  bumpFromElsewhere: (overrides?: BrandingOverrides) => Branding;
  /** What `POST /api/v1/branding/import` answers. */
  importAnswer: ((dryRun: boolean) => unknown) | null;
}

const bodyOf = (call: RecordedCall): Record<string, unknown> =>
  JSON.parse(typeof call.body === 'string' ? call.body : '{}') as Record<string, unknown>;

export function createFakeServer(initial: Branding): {
  server: FakeServer;
  handler: (call: RecordedCall) => Response | Promise<Response>;
} {
  const known = new Map<string, ReturnType<typeof assetRef>>([
    [HASH_A, assetRef(HASH_A)],
    [HASH_B, assetRef(HASH_B)],
  ]);
  const server: FakeServer = {
    current: initial,
    calls: [],
    failNext: null,
    bumpFromElsewhere(overrides = {}) {
      server.current = brandingWith({
        revision: server.current.revision + 1,
        orgName: server.current.orgName,
        accent: server.current.accent,
        ...overrides,
      });
      return server.current;
    },
    importAnswer: null,
  };

  const handler = (call: RecordedCall): Response | Promise<Response> => {
    const path = new URL(call.url, 'http://panel.test').pathname;
    server.calls.push(call);
    if (call.method === 'GET' && path === '/api/v1/branding') return jsonResponse(server.current);

    if (call.method !== 'GET' && server.failNext !== null) {
      const failure = server.failNext;
      server.failNext = null;
      if (failure === 'network') return Promise.reject(new TypeError('Failed to fetch'));
      return problemResponse(failure[0], failure[1], failure[2] ?? {});
    }

    const ifMatch = call.headers.get('If-Match');
    const isImportDryRun = path === '/api/v1/branding/import' && call.url.includes('dryRun=true');
    if (!isImportDryRun && ifMatch !== `"${String(server.current.revision)}"`) {
      return problemResponse(412, 'branding_conflict');
    }

    if (call.method === 'PUT' && path === '/api/v1/branding') {
      const request = bodyOf(call) as {
        orgName: string;
        accent: string;
        logos: Record<'light' | 'dark' | 'compact', string | null>;
      };
      const logoOf = (hash: string | null) => (hash === null ? null : (known.get(hash) ?? null));
      server.current = brandingWith({
        revision: server.current.revision + 1,
        orgName: tryNormalizeOrgName(request.orgName) ?? 'M365Portal',
        accent: tryNormalizeAccent(request.accent) ?? server.current.accent,
        logos: {
          light: logoOf(request.logos.light),
          dark: logoOf(request.logos.dark),
          compact: logoOf(request.logos.compact),
        },
      });
      return jsonResponse(server.current, {
        headers: { ETag: `"${String(server.current.revision)}"` },
      });
    }
    if (call.method === 'DELETE' && path === '/api/v1/branding') {
      server.current = brandingWith({
        revision: server.current.revision + 1,
        orgName: 'M365Portal',
      });
      return jsonResponse(server.current);
    }
    if (call.method === 'POST' && path === '/api/v1/branding/import') {
      const dryRun = isImportDryRun;
      if (server.importAnswer === null) return problemResponse(422, 'import_invalid');
      const answer = server.importAnswer(dryRun);
      if (!dryRun) {
        const applied = answer as { branding: Branding };
        server.current = brandingWith({
          revision: server.current.revision + 1,
          orgName: applied.branding.orgName,
          accent: applied.branding.accent,
        });
        return jsonResponse({ ...applied, branding: server.current });
      }
      return jsonResponse(answer);
    }
    return problemResponse(404, 'not_found');
  };
  return { server, handler };
}

export interface RenderAppearanceOptions {
  readonly branding?: Branding;
  readonly me?: MeResponse;
  readonly language?: 'en' | 'nl';
  readonly path?: string;
}

export async function renderAppearance(options: RenderAppearanceOptions = {}) {
  const initial = options.branding ?? brandingWith();
  const { server, handler } = createFakeServer(initial);
  const { api, calls, writes } = fakeApi(handler);
  const queryClient = createAppQueryClient();
  const me = options.me ?? sampleMe({ permissions: ['settings:branding'] });
  seedQueryClient(queryClient, { me, branding: initial }, api);
  const language = createLanguageController({
    storage: createStorage(null),
    languages: [options.language ?? 'en'],
    root: document.createElement('html'),
  });
  const history = createMemoryHistory({ initialEntries: [options.path ?? '/settings/appearance'] });
  const router = createAppRouter(history, { queryClient, api });
  const user = userEvent.setup();
  const view = render(
    <RootProviders router={router} queryClient={queryClient} language={language} />,
  );
  await router.load();
  return { ...view, user, router, queryClient, server, api, calls, writes };
}

/**
 * Watches for a `style="..."` string. happy-dom mirrors every CSSOM write into the attribute by calling
 * setAttribute('style') from inside setProperty and removeProperty; a browser does not. Those mirrored
 * calls are not a violation, a setAttribute('style', ...) from anywhere else is.
 */
export function watchStyleStrings(vi: typeof import('vitest').vi): {
  readonly violations: unknown[];
  readonly cssomProperties: string[];
} {
  let insideCssom = 0;
  const violations: unknown[] = [];
  const cssomProperties: string[] = [];
  const prototype = CSSStyleDeclaration.prototype;
  for (const method of ['setProperty', 'removeProperty'] as const) {
    const original = Reflect.get(prototype, method) as (...args: unknown[]) => unknown;
    vi.spyOn(prototype, method).mockImplementation(function (
      this: CSSStyleDeclaration,
      ...args: unknown[]
    ) {
      if (method === 'setProperty') cssomProperties.push(String(args[0]));
      insideCssom += 1;
      try {
        return original.apply(this, args);
      } finally {
        insideCssom -= 1;
      }
    });
  }
  const originalSetAttribute = Reflect.get(Element.prototype, 'setAttribute');
  vi.spyOn(Element.prototype, 'setAttribute').mockImplementation(function (
    this: Element,
    name: string,
    value: string,
  ) {
    if (name.toLowerCase() === 'style' && insideCssom === 0) violations.push([name, value]);
    originalSetAttribute.call(this, name, value);
  });
  return { violations, cssomProperties };
}
