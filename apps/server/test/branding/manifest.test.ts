// T-A-090 (R13 manifest, R14 and R15 icon redirects; FR-A-094; E-12; PA-13): the manifest is generated
// from the applied branding, the organisation name is only ever a JSON string value, and the two
// conventional icon paths redirect to the hashed files.
import { shortOrgName } from '@m365portal/shared/branding/org-name';
import { SURFACES } from '@m365portal/shared/tokens';
import { ProblemSchema } from '@m365portal/shared/problem';
import { WebManifestSchema } from '@m365portal/shared/schemas/manifest';
import { Validator } from '@seriousme/openapi-schema-validator';
import { describe, expect, it } from 'vitest';
import { degradedBranding } from '../../src/branding/defaults.js';
import { buildManifest } from '../../src/branding/manifest.js';
import { pwaRoutes } from '../../src/branding/routes/pwa.js';
import { readJson } from '../helpers/http-client.js';
import { type BrandingApp } from './branding-fixture.js';
import { createOutputsApp } from './outputs-fixture.js';

const app = (preview = false) =>
  createOutputsApp({
    preview,
    routes: (storage) => pwaRoutes({ service: storage.service }),
  });

const STAFF = { actor: { kind: 'preview', id: 'preview' } } as const;

async function rename(
  storage: BrandingApp,
  orgName: string,
  accent = '#0078d4',
): Promise<ReturnType<BrandingApp['service']['get']>> {
  const current = storage.service.get();
  return storage.service.apply(
    { orgName, accent, logos: { light: null, dark: null, compact: null } },
    current.revision,
    STAFF,
  );
}

describe('R13 GET /manifest.webmanifest', () => {
  it('is application/manifest+json, revalidated, with the ETag of the revision', async () => {
    const storage = await app();
    const response = await storage.app.client.get('/manifest.webmanifest');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/manifest+json');
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(response.headers.get('etag')).toBe('"1"');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');

    const same = await storage.app.client.get('/manifest.webmanifest', {
      headers: { 'If-None-Match': '"1"' },
    });
    expect(same.status).toBe(304);

    await rename(storage, 'Contoso');
    const next = await storage.app.client.get('/manifest.webmanifest', {
      headers: { 'If-None-Match': '"1"' },
    });
    expect(next.status).toBe(200);
    expect(next.headers.get('etag')).toBe('"2"');
  });

  it('holds the branding: name, short name, effective light accent, neutral background, icons', async () => {
    const storage = await app();
    const branding = await rename(storage, 'Contoso Netherlands B.V.', '#3b82f6');
    const manifest = WebManifestSchema.parse(
      await readJson(await storage.app.client.get('/manifest.webmanifest')),
    );
    expect(manifest).toEqual({
      id: '/',
      name: 'Contoso Netherlands B.V.',
      short_name: 'Contoso Neth',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      theme_color: branding.tokens.light.accent,
      background_color: SURFACES.light.page,
      icons: [
        { src: branding.icons.pwa192.url, sizes: '192x192', type: 'image/png' },
        { src: branding.icons.pwa512.url, sizes: '512x512', type: 'image/png' },
        {
          src: branding.icons.maskable512.url,
          sizes: '512x512',
          type: 'image/png',
          purpose: 'maskable',
        },
      ],
    });
    // The server holds no second cut: it is the shared function.
    expect(manifest.short_name).toBe(shortOrgName(manifest.name));
  });

  it('uses the adjusted accent when the chosen one cannot carry text (the effective colour)', async () => {
    const storage = await app();
    const branding = await rename(storage, 'Bright', '#ffff00');
    const manifest = WebManifestSchema.parse(
      await readJson(await storage.app.client.get('/manifest.webmanifest')),
    );
    expect(manifest.theme_color).toBe(branding.tokens.light.accent);
  });

  const hostile = [
    '"><img src=x onerror=alert(1)>',
    '</title><script>alert(1)</script>',
    '\\"},"icons":[{"src":"//evil"}],"x":{"y":"',
    '$& $` $\' __M365_NONCE__',
    '<!-- -->\u202e'.replace('\u202e', ''),
  ];
  it.each(hostile)('serialises the name %j as data: valid JSON, one string value', async (name) => {
    const storage = await app();
    await rename(storage, name);
    const response = await storage.app.client.get('/manifest.webmanifest');
    const text = await response.text();
    const parsed = WebManifestSchema.parse(JSON.parse(text));
    expect(parsed.name).toBe(name);
    expect(Object.keys(parsed).sort()).toEqual(
      [
        'background_color',
        'display',
        'icons',
        'id',
        'name',
        'scope',
        'short_name',
        'start_url',
        'theme_color',
      ].sort(),
    );
    expect(parsed.icons).toHaveLength(3);
  });

  it('cuts the short name at a grapheme boundary: a ZWJ emoji at the cut stays whole', async () => {
    const storage = await app();
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
    const name = `abcdefghijk${family}tail`;
    await rename(storage, name);
    const manifest = WebManifestSchema.parse(
      await readJson(await storage.app.client.get('/manifest.webmanifest')),
    );
    expect(manifest.short_name).toBe(`abcdefghijk${family}`);
    expect([...new Intl.Segmenter().segment(manifest.short_name)]).toHaveLength(12);
    // And a name that is already short is returned unchanged.
    await rename(storage, 'Acme');
    const short = WebManifestSchema.parse(
      await readJson(await storage.app.client.get('/manifest.webmanifest')),
    );
    expect(short.short_name).toBe('Acme');
  });

  it('answers with the defaults and no icons in degraded mode', async () => {
    const storage = await app();
    await rename(storage, 'Contoso');
    storage.setStorageAvailable(false);
    const response = await storage.app.client.get('/manifest.webmanifest');
    expect(response.status).toBe(200);
    const manifest = WebManifestSchema.parse(await readJson(response));
    expect(manifest).toMatchObject({
      name: 'M365Portal',
      short_name: 'M365Portal',
      theme_color: degradedBranding().tokens.light.accent,
    });
    expect(manifest.icons).toEqual([]);
    expect(response.headers.get('etag')).toBe('"0"');
  });

  it('builds the same manifest from the pure function', () => {
    const manifest = buildManifest(degradedBranding());
    expect(WebManifestSchema.safeParse(manifest).success).toBe(true);
    expect(manifest.icons).toEqual([]);
  });
});

describe('R14 and R15 the conventional icon paths', () => {
  it('redirect with 307 to the hashed favicon and apple touch icon, revalidated', async () => {
    const storage = await app();
    const { icons } = await rename(storage, 'Contoso');
    const favicon = await storage.app.client.get('/favicon.ico');
    expect(favicon.status).toBe(307);
    expect(favicon.headers.get('location')).toBe(icons.favicon32.url);
    expect(favicon.headers.get('cache-control')).toBe('no-cache');
    const apple = await storage.app.client.get('/apple-touch-icon.png');
    expect(apple.status).toBe(307);
    expect(apple.headers.get('location')).toBe(icons.appleTouch180.url);
    expect(apple.headers.get('cache-control')).toBe('no-cache');
    // The target is a relative path of this origin, never built from the request.
    const hostile = await storage.app.client.get('/favicon.ico', {
      headers: { 'X-Forwarded-Host': 'evil.example' },
    });
    expect(hostile.headers.get('location')).toBe(icons.favicon32.url);
  });

  it('follow the applied branding when it changes', async () => {
    const storage = await app();
    const first = storage.service.get();
    const second = await rename(storage, 'Other name');
    const response = await storage.app.client.get('/favicon.ico');
    expect(response.headers.get('location')).toBe(second.icons.favicon32.url);
    expect(second.icons.favicon32.url).not.toBe(first.icons.favicon32.url);
  });

  it('answer 404 not_found in degraded mode', async () => {
    const storage = await app();
    storage.setStorageAvailable(false);
    for (const path of ['/favicon.ico', '/apple-touch-icon.png']) {
      const response = await storage.app.client.get(path);
      expect(response.status).toBe(404);
      expect(ProblemSchema.parse(await readJson(response)).code).toBe('not_found');
    }
  });
});

describe('R13 to R15 in the route table and the OpenAPI document', () => {
  it('are three public read routes without an audit action', async () => {
    const storage = await app();
    const routes = pwaRoutes({ service: storage.service });
    expect(routes.map((route) => [route.id, route.method, route.path])).toEqual([
      ['pwa.manifest', 'GET', '/manifest.webmanifest'],
      ['pwa.favicon', 'GET', '/favicon.ico'],
      ['pwa.appleTouchIcon', 'GET', '/apple-touch-icon.png'],
    ]);
    for (const route of routes) {
      expect(route.access).toEqual({ public: true });
      expect(route.rateLimit).toBe('read');
      expect(route.audit).toBeUndefined();
    }
    const document = storage.app.app.http.document;
    const result = await new Validator().validate(document as never);
    expect(result.valid).toBe(true);
    const paths = document.paths as Record<string, Record<string, Record<string, unknown>>>;
    expect(paths['/manifest.webmanifest']?.get).toMatchObject({ 'x-public': true });
    expect(paths['/favicon.ico']?.get).toMatchObject({ 'x-public': true });
    expect(paths['/apple-touch-icon.png']?.get).toMatchObject({ 'x-public': true });
  });
});
