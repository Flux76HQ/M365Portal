// T-A-089 (R12 GET /branding/{file}; FR-A-090, FR-A-096; E-05, E-27; H-43): the branding files through
// the real route pipeline. Only a registered `<64 hex>.png` is served, with the headers that make an
// image inert; an asset the applied branding does not reference is for `settings:branding` only and
// looks like a 404 to everyone else; a file that is gone is a 404, not a crash.
import { ProblemSchema } from '@m365portal/shared/problem';
import { describe, expect, it } from 'vitest';
import { checkReferencedAssets } from '../../src/branding/sweepers.js';
import { referencedHashes } from '../../src/branding/repository.js';
import { sha256Hex } from '../../src/branding/asset-store.js';
import { assetServingRoutes } from '../../src/branding/routes/serve-assets.js';
import { withTransaction } from '../../src/db/index.js';
import { createReadiness } from '../../src/lifecycle/readiness.js';
import { createStorageProbe } from '../../src/lifecycle/storage-probe.js';
import { defaultPaths } from '../../scripts/schema-snapshot.js';
import { readJson } from '../helpers/http-client.js';
import { distinctPng, type BrandingStorage } from './branding-fixture.js';
import { createOutputsApp } from './outputs-fixture.js';

const app = (preview = true) =>
  createOutputsApp({
    preview,
    routes: (storage) =>
      assetServingRoutes({ requireDatabase: storage.requireDatabase, assets: storage.store }),
  });

/** Stage one image the way an upload does: the file and an unreferenced row. */
async function stageOne(storage: BrandingStorage, seed: number): Promise<string> {
  const png = await distinctPng(seed);
  const hash = await storage.store.write(png);
  withTransaction(storage.requireDatabase(), (tx) =>
    storage.store.registerStaged(tx, {
      sha256: hash,
      bytes: png.length,
      width: 64,
      height: 64,
      luminance: 0.5,
    }),
  );
  return hash;
}

const STRICT_CSP = "default-src 'none'; frame-ancestors 'none'; sandbox";

describe('R12 serve a referenced asset', () => {
  it('answers 200 with the bytes of the file and the headers of an inert image', async () => {
    const { app: fixture, service, store } = await app(false);
    const hash = service.get().icons.favicon32.hash;
    const response = await fixture.client.get(`/branding/${hash}.png`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toBe(STRICT_CSP);
    expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(response.headers.get('etag')).toBe(`"${hash}"`);
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(sha256Hex(bytes)).toBe(hash);
    expect(bytes.equals(await store.read(hash))).toBe(true);
  });

  it('answers 304 without a body when If-None-Match names the hash', async () => {
    const { app: fixture, service } = await app(false);
    const hash = service.get().icons.pwa192.hash;
    const response = await fixture.client.get(`/branding/${hash}.png`, {
      headers: { 'If-None-Match': `"${hash}"` },
    });
    expect(response.status).toBe(304);
    expect(response.headers.get('etag')).toBe(`"${hash}"`);
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect((await response.arrayBuffer()).byteLength).toBe(0);
    const other = await fixture.client.get(`/branding/${hash}.png`, {
      headers: { 'If-None-Match': `"${'0'.repeat(64)}"` },
    });
    expect(other.status).toBe(200);
  });
});

describe('R12 names that are not a registered hash (H-43)', () => {
  const hex = 'a'.repeat(64);
  const names: [string, string][] = [
    ['an unknown hash', `${hex}.png`],
    ['uppercase hex', `${'A'.repeat(64)}.png`],
    ['63 characters', `${'a'.repeat(63)}.png`],
    ['65 characters', `${'a'.repeat(65)}.png`],
    ['a double extension', `${hex}.png.exe`],
    ['another extension', `${hex}.jpg`],
    ['an upper case extension', `${hex}.PNG`],
    ['no extension', hex],
    ['a NUL byte', `${hex}%00.png`],
    ['a NUL before the extension', `${'a'.repeat(63)}%00.png`],
    ['an encoded traversal', `%2e%2e%2f%2e%2e%2fetc%2fpasswd`],
    ['an encoded slash', `..%2f${hex}.png`],
    ['a backslash', `..%5c${hex}.png`],
    ['a double encoded dot', `%252e%252e%252f${hex}.png`],
    ['a trailing space', `${hex}.png%20`],
    ['the directory name', '.'],
    ['a dotfile', '.env'],
  ];

  it.each(names)('answers 404 not_found for %s', async (_label, name) => {
    const { app: fixture } = await app();
    const response = await fixture.client.get(`/branding/${name}`);
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    expect(ProblemSchema.parse(await readJson(response)).code).toBe('not_found');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('never reads a file outside the branding directory, whatever the name', async () => {
    const { app: fixture, dataDir } = await app();
    const { writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    await writeFile(join(dataDir, `${hex}.png`), 'outside');
    const response = await fixture.client.get(`/branding/..%2f${hex}.png`);
    expect(response.status).toBe(404);
  });

  it('refuses a name that is a registered hash of another case or a path of two segments', async () => {
    const { app: fixture, service } = await app();
    const hash = service.get().icons.favicon32.hash;
    expect((await fixture.client.get(`/branding/${hash.toUpperCase()}.png`)).status).toBe(404);
    for (const suffix of ['', '.PNG', '.jpg', '.png.exe', '.png%20', '.pngx', '.png.']) {
      expect((await fixture.client.get(`/branding/${hash}${suffix}`)).status).toBe(404);
    }
    expect((await fixture.client.get(`/branding/${hash}.png`)).status).toBe(200);
    expect((await fixture.client.get(`/branding/x/${hash}.png`)).status).toBe(404);
    expect((await fixture.client.get(`/branding/${hash}.png/`)).status).toBe(404);
  });
});

describe('R12 assets the applied branding does not reference', () => {
  it('are a 404 to the anonymous actor, indistinguishable from an unknown hash', async () => {
    const storage = await app(false);
    const staged = await stageOne(storage, 1);
    const unknown = 'b'.repeat(64);
    const hidden = await storage.app.client.get(`/branding/${staged}.png`);
    const missing = await storage.app.client.get(`/branding/${unknown}.png`);
    expect(hidden.status).toBe(404);
    expect(missing.status).toBe(404);
    const [a, b] = [
      ProblemSchema.parse(await readJson(hidden)),
      ProblemSchema.parse(await readJson(missing)),
    ];
    expect({ ...a, requestId: '' }).toEqual({ ...b, requestId: '' });
    expect(hidden.headers.get('cache-control')).toBe(missing.headers.get('cache-control'));
    // A conditional request does not reveal it either.
    const conditional = await storage.app.client.get(`/branding/${staged}.png`, {
      headers: { 'If-None-Match': `"${staged}"` },
    });
    expect(conditional.status).toBe(404);
  });

  it('are served to an actor holding settings:branding, private and immutable', async () => {
    const storage = await app(true);
    const staged = await stageOne(storage, 2);
    const response = await storage.app.client.get(`/branding/${staged}.png`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(response.headers.get('etag')).toBe(`"${staged}"`);
    expect(response.headers.get('content-security-policy')).toBe(STRICT_CSP);
    const again = await storage.app.client.get(`/branding/${staged}.png`, {
      headers: { 'If-None-Match': `"${staged}"` },
    });
    expect(again.status).toBe(304);
    expect(again.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
  });

  it('become public once an apply references them', async () => {
    const storage = await app(false);
    const staged = await stageOne(storage, 3);
    expect((await storage.app.client.get(`/branding/${staged}.png`)).status).toBe(404);
    const current = storage.service.get();
    await storage.service.apply(
      {
        orgName: current.orgName,
        accent: current.accent,
        logos: { light: staged, dark: null, compact: null },
      },
      current.revision,
      { actor: { kind: 'preview', id: 'preview' } },
    );
    const response = await storage.app.client.get(`/branding/${staged}.png`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });
});

describe('R12 a file that is gone (FR-A-096)', () => {
  it('is a 404, a branding_asset_missing warning at start, and the other files still work', async () => {
    const storage = await app(false);
    const { service, store, database, clock } = storage;
    const branding = service.get();
    const gone = branding.icons.favicon32.hash;
    const kept = branding.icons.pwa512.hash;
    await store.remove(gone);

    const response = await storage.app.client.get(`/branding/${gone}.png`);
    expect(response.status).toBe(404);
    expect(ProblemSchema.parse(await readJson(response)).code).toBe('not_found');
    expect((await storage.app.client.get(`/branding/${kept}.png`)).status).toBe(200);

    const lines: Record<string, unknown>[] = [];
    const missing = await checkReferencedAssets({
      store,
      database: () => database,
      now: () => clock.nowMs(),
      log: { warn: (fields) => lines.push(fields) },
    });
    expect(missing).toEqual([gone]);
    expect(lines).toEqual([{ event: 'branding_asset_missing', sha256: gone }]);
    expect(referencedHashes(database)).toContain(gone);
  });

  it('keeps readiness ready while a referenced file is missing', async () => {
    const storage = await app(false);
    await storage.store.remove(storage.service.get().icons.favicon32.hash);
    const readiness = createReadiness({
      now: () => storage.clock.nowMs(),
      probe: createStorageProbe(storage.dataDir),
      database: () => storage.database,
      startFailure: () => undefined,
      migrationsFolder: defaultPaths().migrationsFolder,
    });
    expect(readiness.check().status).toBe('ready');
  });
});

describe('R12 storage', () => {
  it('answers 503 storage_unavailable when the database is unusable', async () => {
    const storage = await app(false);
    const hash = storage.service.get().icons.favicon32.hash;
    storage.setStorageAvailable(false);
    const response = await storage.app.client.get(`/branding/${hash}.png`);
    expect(response.status).toBe(503);
    expect(ProblemSchema.parse(await readJson(response)).code).toBe('storage_unavailable');
  });
});

describe('R12 in the route table', () => {
  it('is one public read route without an audit action', async () => {
    const storage = await app();
    const routes = assetServingRoutes({
      requireDatabase: storage.requireDatabase,
      assets: storage.store,
    });
    expect(routes.map((route) => route.id)).toEqual(['assets.serve']);
    expect(routes[0]).toMatchObject({
      method: 'GET',
      path: '/branding/{file}',
      access: { public: true },
      rateLimit: 'read',
    });
    expect(routes[0]?.audit).toBeUndefined();
  });
});
