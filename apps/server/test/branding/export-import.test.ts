// T-A-088 (R10 export, R11 import; FR-A-093, FR-A-044 audited GET; E-22; H-42): the export is the JSON
// of FR-A-093; the import is hostile input. It is read by a parser of our own that refuses duplicate,
// `__proto__` and `constructor` keys and absurd nesting before anything is built, validated with the
// strict shared schema, every image goes through the COMPLETE pipeline, and the whole document is
// applied in one transaction or not at all.
import { LIMITS } from '@m365portal/shared/limits';
import { ProblemSchema } from '@m365portal/shared/problem';
import { BrandingSchema } from '@m365portal/shared/schemas/branding';
import {
  BrandingExportSchema,
  ImportResultSchema,
  type BrandingExport,
} from '@m365portal/shared/schemas/export-import';
import { rm } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../src/branding/asset-store.js';
import { scanImportJson } from '../../src/branding/export-import.js';
import { exportImportRoutes } from '../../src/branding/routes/export-import.js';
import { withTransaction } from '../../src/db/index.js';
import { readJson, type HttpClient } from '../helpers/http-client.js';
import {
  detailOf,
  distinctPng,
  solidPng,
  type BrandingApp,
  type BrandingStorage,
} from './branding-fixture.js';
import { createOutputsApp } from './outputs-fixture.js';

const EXPORT = '/api/v1/branding/export';
const IMPORT = '/api/v1/branding/import';
const STAFF = { actor: { kind: 'preview', id: 'preview' } } as const;

interface Counted extends BrandingApp {
  /** How often the export document was built. */
  readonly exportsBuilt: { count: number };
}

async function app(preview = true): Promise<Counted> {
  const exportsBuilt = { count: 0 };
  const built = await createOutputsApp({
    preview,
    withBrandingRoutes: true,
    routes: (storage) =>
      exportImportRoutes({
        requireDatabase: storage.requireDatabase,
        now: () => storage.clock.nowMs(),
        assets: storage.store,
        images: storage.images,
        service: {
          ...storage.service,
          get: () => {
            exportsBuilt.count += 1;
            return storage.service.get();
          },
        },
      }),
  });
  return Object.assign(built, { exportsBuilt });
}

/** Stage a PNG as the upload does (the file and an unreferenced row), return its hash. */
async function stage(storage: BrandingStorage, png: Buffer): Promise<string> {
  const processed = await storage.images.process({ bytes: png, slot: 'logoLight' });
  const hash = await storage.store.write(processed.png);
  withTransaction(storage.requireDatabase(), (tx) =>
    storage.store.registerStaged(tx, {
      sha256: hash,
      bytes: processed.png.length,
      width: processed.width,
      height: processed.height,
      luminance: processed.luminance,
    }),
  );
  return hash;
}

async function applyLogos(
  storage: BrandingStorage,
  logos: { light?: Buffer; dark?: Buffer; compact?: Buffer },
  orgName = 'Contoso',
  accent = '#0078d4',
) {
  const hashes = {
    light: logos.light === undefined ? null : await stage(storage, logos.light),
    dark: logos.dark === undefined ? null : await stage(storage, logos.dark),
    compact: logos.compact === undefined ? null : await stage(storage, logos.compact),
  };
  const current = storage.service.get();
  return storage.service.apply({ orgName, accent, logos: hashes }, current.revision, STAFF);
}

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

function document(overrides: Record<string, unknown> = {}, images: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    orgName: 'Imported Org',
    accent: '#d83b01',
    images: { logoLight: null, logoDark: null, compact: null, ...images },
    ...overrides,
  };
}

async function post(
  client: HttpClient,
  body: string | Uint8Array | object,
  options: { ifMatch?: string | null; dryRun?: boolean } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  const ifMatch = options.ifMatch === undefined ? '"1"' : options.ifMatch;
  if (ifMatch !== null) headers['If-Match'] = ifMatch;
  return client.post(
    options.dryRun === undefined ? IMPORT : `${IMPORT}?dryRun=${String(options.dryRun)}`,
    {
      headers: { 'Content-Type': 'application/json', ...headers },
      body: typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body),
    },
  );
}

const problemCode = async (response: Response): Promise<string> =>
  ProblemSchema.parse(await readJson(response)).code;

async function problemOf(response: Response) {
  return ProblemSchema.parse(await readJson(response));
}

/** Everything an import must leave alone when it fails. */
function snapshot(storage: BrandingStorage) {
  return {
    branding: storage.service.get(),
    assets: storage.assets().map((row) => row.sha256),
    audit: storage.audit().length,
  };
}

describe('R10 GET /api/v1/branding/export', () => {
  it('is the JSON of FR-A-093 with the stored master PNGs as base64, and only the explicit compact', async () => {
    const storage = await app();
    const light = await distinctPng(1);
    const dark = await distinctPng(2);
    const branding = await applyLogos(storage, { light, dark }, 'Contoso', '#3b82f6');
    expect(branding.compactDerived).toBe(true);

    const response = await storage.app.client.get(EXPORT);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="m365portal-branding-20261010.json"',
    );
    const exported = BrandingExportSchema.parse(await readJson(response));
    expect(Object.keys(exported)).toEqual(['schemaVersion', 'orgName', 'accent', 'images']);
    expect(exported).toMatchObject({ schemaVersion: 1, orgName: 'Contoso', accent: '#3b82f6' });
    const stored = async (hash: string | undefined): Promise<string | null> =>
      hash === undefined ? null : b64(await storage.store.read(hash));
    expect(exported.images.logoLight).toBe(await stored(branding.logos.light?.hash));
    expect(exported.images.logoDark).toBe(await stored(branding.logos.dark?.hash));
    // The derived compact is not exported: it is made again on import.
    expect(exported.images.compact).toBeNull();
  });

  it('exports an explicit compact logo and a branding without logos', async () => {
    const storage = await app();
    const empty = BrandingExportSchema.parse(await readJson(await storage.app.client.get(EXPORT)));
    expect(empty.images).toEqual({ logoLight: null, logoDark: null, compact: null });
    expect(empty).toMatchObject({ orgName: 'M365Portal' });
    const branding = await applyLogos(storage, { compact: await distinctPng(5, 48) });
    const exported = BrandingExportSchema.parse(
      await readJson(await storage.app.client.get(EXPORT)),
    );
    expect(exported.images.compact).toBe(
      b64(await storage.store.read(branding.logos.compact?.hash ?? '')),
    );
  });

  it('dates the file name with the clock of the server, in UTC', async () => {
    const storage = await app();
    storage.clock.set('2027-01-02T23:59:59.000Z');
    const response = await storage.app.client.get(EXPORT);
    expect(response.headers.get('content-disposition')).toContain(
      'm365portal-branding-20270102.json',
    );
  });

  it('is audited as branding.export (a read that writes an audit row)', async () => {
    const storage = await app();
    const before = storage.audit().length;
    const response = await storage.app.client.get(EXPORT, {
      headers: { 'x-request-id': 'export-0001-test' },
    });
    const text = await response.text();
    const rows = storage.audit().slice(before);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'branding.export',
      outcome: 'success',
      actor_kind: 'preview',
      target_type: 'branding',
      target_id: '1',
      request_id: 'export-0001-test',
    });
    expect(detailOf(rows[0] as never)).toEqual({
      schemaVersion: 1,
      bytes: Buffer.byteLength(text),
    });
    // The audit row holds no image.
    expect(rows[0]?.detail).not.toMatch(/iVBOR/);
  });

  // Open point s2f-2, decided in T-A-093: a master file that is gone is a 500 `internal_error`, not a
  // 409. A 409 says the request conflicts with state the client can change, and the problem
  // catalogue has no code for it (31 codes, fixed by contract section 6); this is damaged storage,
  // which an operator must see as a server fault. The answer holds neither the hash nor a path.
  // The attempt is audited as `error`, so the log shows who asked, and no half document is sent.
  // The state can be repaired from the UI: applying or resetting the branding drops the reference.
  it('answers 500 internal_error when a master file is gone: no partial document, an error row, repairable', async () => {
    const storage = await app();
    const light = await distinctPng(1);
    const dark = await distinctPng(2);
    const branding = await applyLogos(storage, { light, dark });
    const gone = branding.logos.dark?.hash ?? '';
    await rm(storage.store.pathOf(gone));
    const before = storage.audit().length;

    const response = await storage.app.client.get(EXPORT);
    expect(response.status).toBe(500);
    expect(response.headers.get('content-disposition')).toBeNull();
    const text = await response.text();
    expect(text).not.toContain(gone);
    expect(text).not.toContain(storage.dataDir);
    expect(JSON.parse(text)).toMatchObject({ code: 'internal_error', status: 500 });

    const rows = storage.audit().slice(before);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'branding.export',
      outcome: 'error',
      reason_code: 'internal_error',
      actor_kind: 'preview',
    });
    expect(rows[0]?.detail).not.toContain(gone);

    // Repair: the branding is reset, the reference to the lost file goes, the export works again.
    await storage.service.reset(storage.service.get().revision, STAFF);
    expect((await storage.app.client.get(EXPORT)).status).toBe(200);
  });

  it('refuses a cross-site request before any audit row or export is made', async () => {
    const storage = await app();
    const before = storage.audit().length;
    for (const site of ['cross-site', 'same-site']) {
      const response = await storage.app.client.get(EXPORT, {
        headers: { 'Sec-Fetch-Site': site },
      });
      expect(response.status).toBe(403);
      expect(await problemCode(response)).toBe('origin_not_allowed');
    }
    expect(storage.audit()).toHaveLength(before);
    expect(storage.exportsBuilt.count).toBe(0);
    for (const site of ['same-origin', 'none']) {
      expect(
        (await storage.app.client.get(EXPORT, { headers: { 'Sec-Fetch-Site': site } })).status,
      ).toBe(200);
    }
  });

  it('answers a denied read with 403 and does not audit it (PA-15)', async () => {
    const storage = await app(false);
    const before = storage.audit().length;
    const response = await storage.app.client.get(EXPORT);
    expect(response.status).toBe(403);
    expect(await problemCode(response)).toBe('permission_denied');
    expect(storage.audit()).toHaveLength(before);
    expect(storage.exportsBuilt.count).toBe(0);
  });

  it('answers 503 storage_unavailable without storage', async () => {
    const storage = await app();
    storage.setStorageAvailable(false);
    const response = await storage.app.client.get(EXPORT);
    expect(response.status).toBe(503);
  });
});

describe('the parser of the import (H-42)', () => {
  const valid = JSON.stringify(document());

  it('accepts an ordinary document and any whitespace around it', () => {
    expect(scanImportJson(valid)).toBeNull();
    expect(scanImportJson(` \n\t${valid}\r\n `)).toBeNull();
    expect(scanImportJson('{"a":{"b":[1,2,{"c":"x\\"y"}]}}')).toBeNull();
  });

  it.each([
    ['a duplicate key', '{"a":1,"a":2}', 'duplicate_key'],
    ['a duplicate key written with an escape', '{"a":1,"\\u0061":2}', 'duplicate_key'],
    ['a duplicate key in a nested object', '{"o":{"x":1,"x":1}}', 'duplicate_key'],
    ['__proto__', '{"__proto__":{}}', 'forbidden_key'],
    ['__proto__ written with an escape', '{"\\u005f_proto__":{}}', 'forbidden_key'],
    ['constructor', '{"constructor":{"prototype":{}}}', 'forbidden_key'],
    ['__proto__ nested', '{"images":{"__proto__":null}}', 'forbidden_key'],
    ['__proto__ nested in an array', '{"a":[{"__proto__":1}]}', 'forbidden_key'],
    ['nesting of 10,000 arrays', '['.repeat(10_000) + ']'.repeat(10_000), 'too_deep'],
    ['nesting of 10,000 objects', '{"a":'.repeat(10_000) + '1' + '}'.repeat(10_000), 'too_deep'],
    ['nesting of 9 levels', '['.repeat(9) + ']'.repeat(9), 'too_deep'],
  ])('refuses %s', (_label, text, reason) => {
    expect(scanImportJson(text)).toBe(reason);
  });

  it('does not take the same key in two different objects for a duplicate', () => {
    expect(scanImportJson('{"a":{"x":1},"b":{"x":2},"c":[{"x":1},{"x":2}]}')).toBeNull();
  });

  it('does not take a string value that looks like a key for one', () => {
    expect(scanImportJson('{"a":"__proto__","b":["constructor","a"],"c":"a"}')).toBeNull();
    expect(scanImportJson('{"a":"x\\":\\"__proto__"}')).toBeNull();
  });

  it('is linear on a document of 9 MiB and does not overflow the stack at any depth', () => {
    const big = `{"a":"${'x'.repeat(9_000_000)}"}`;
    const started = Date.now();
    expect(scanImportJson(big)).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(scanImportJson('['.repeat(2_000_000))).toBe('too_deep');
  });
});

describe('R11 POST /api/v1/branding/import: hostile documents are rejected, nothing is applied', () => {
  const light = async () => b64(await distinctPng(11));

  const cases: [
    string,
    () => Promise<string | Uint8Array> | string | Uint8Array,
    number,
    string,
  ][] = [
    [
      'duplicate keys',
      () =>
        '{"schemaVersion":1,"schemaVersion":1,"orgName":"A","accent":"#0078d4","images":{"logoLight":null,"logoDark":null,"compact":null}}',
      422,
      'import_invalid',
    ],
    [
      'a duplicate key in images',
      () =>
        '{"schemaVersion":1,"orgName":"A","accent":"#0078d4","images":{"logoLight":null,"logoLight":null,"logoDark":null,"compact":null}}',
      422,
      'import_invalid',
    ],
    [
      '__proto__ at the top',
      () =>
        '{"__proto__":{"polluted":true},"schemaVersion":1,"orgName":"A","accent":"#0078d4","images":{"logoLight":null,"logoDark":null,"compact":null}}',
      422,
      'import_invalid',
    ],
    [
      'constructor in images',
      () =>
        '{"schemaVersion":1,"orgName":"A","accent":"#0078d4","images":{"constructor":{},"logoLight":null,"logoDark":null,"compact":null}}',
      422,
      'import_invalid',
    ],
    ['an unknown key', () => JSON.stringify(document({ extra: 1 })), 422, 'import_invalid'],
    [
      'an unknown key in images',
      () => JSON.stringify(document({}, { logoMedium: null })),
      422,
      'import_invalid',
    ],
    [
      'a missing image member',
      () =>
        JSON.stringify({
          schemaVersion: 1,
          orgName: 'A',
          accent: '#0078d4',
          images: { logoLight: null, logoDark: null },
        }),
      422,
      'import_invalid',
    ],
    [
      'a media type member',
      async () =>
        JSON.stringify(
          document({}, { logoLight: { mediaType: 'image/png', data: await light() } }),
        ),
      422,
      'import_invalid',
    ],
    [
      'invalid base64 (characters)',
      () => JSON.stringify(document({}, { logoLight: '!!!!not-base64!!!!' })),
      422,
      'import_invalid',
    ],
    [
      'invalid base64 (padding)',
      () => JSON.stringify(document({}, { logoLight: 'AAAA=' })),
      422,
      'import_invalid',
    ],
    [
      'a data URI instead of base64',
      async () =>
        JSON.stringify(document({}, { logoLight: `data:image/png;base64,${await light()}` })),
      422,
      'import_invalid',
    ],
    [
      'base64 with a line break',
      async () =>
        JSON.stringify(
          document(
            {},
            { logoLight: `${(await light()).slice(0, 8)}\n${(await light()).slice(8)}` },
          ),
        ),
      422,
      'import_invalid',
    ],
    ['a document that is an array', () => '[]', 422, 'import_invalid'],
    ['a document that is a string', () => '"x"', 422, 'import_invalid'],
    ['text that is not JSON', () => '{"schemaVersion":', 422, 'import_invalid'],
    ['an empty body', () => '', 422, 'import_invalid'],
    [
      'bytes that are not UTF-8',
      () => new Uint8Array([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d]),
      422,
      'import_invalid',
    ],
    ['a BOM', () => `\uFEFF${JSON.stringify(document())}`, 422, 'import_invalid'],
    [
      'nesting depth 10,000',
      () =>
        `{"schemaVersion":1,"orgName":"A","accent":"#0078d4","images":{"logoLight":${'['.repeat(10_000)}${']'.repeat(10_000)},"logoDark":null,"compact":null}}`,
      422,
      'import_invalid',
    ],
    [
      'an unknown schemaVersion',
      () => JSON.stringify(document({ schemaVersion: 2 })),
      422,
      'import_unsupported_version',
    ],
    [
      'a newer schemaVersion',
      () => JSON.stringify(document({ schemaVersion: 999 })),
      422,
      'import_unsupported_version',
    ],
    [
      'schemaVersion 0',
      () => JSON.stringify(document({ schemaVersion: 0 })),
      422,
      'import_invalid',
    ],
    [
      'a missing schemaVersion',
      () =>
        JSON.stringify({
          orgName: 'A',
          accent: '#0078d4',
          images: { logoLight: null, logoDark: null, compact: null },
        }),
      422,
      'import_invalid',
    ],
    [
      'a text schemaVersion',
      () => JSON.stringify(document({ schemaVersion: '1' })),
      422,
      'import_unsupported_version',
    ],
  ];

  it.each(cases)('rejects %s', async (_label, body, status, code) => {
    const storage = await app();
    const before = snapshot(storage);
    const response = await post(storage.app.client, await body());
    expect(response.status).toBe(status);
    expect(await problemCode(response)).toBe(code);
    const after = snapshot(storage);
    expect(after.branding).toEqual(before.branding);
    expect(after.assets).toEqual(before.assets);
    // A rejected import is audited as rejected, with the stable code.
    const rows = storage.audit().slice(before.audit);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'branding.import',
      outcome: 'rejected',
      reason_code: code,
    });
  });

  it('rejects 9,437,185 bytes with 413 payload_too_large and writes nothing', async () => {
    const storage = await app();
    const before = snapshot(storage);
    const limit = LIMITS.body.importRequestBytes;
    const head = '{"schemaVersion":1,"orgName":"A","accent":"#0078d4","images":{"logoLight":"';
    const tail = '","logoDark":null,"compact":null}}';
    const fill = (length: number): string => 'A'.repeat(length - head.length - tail.length);
    const over = head + fill(limit + 1) + tail;
    expect(over.length).toBe(limit + 1);
    const refused = await post(storage.app.client, over);
    expect(refused.status).toBe(413);
    expect(await problemCode(refused)).toBe('payload_too_large');
    expect(snapshot(storage).branding).toEqual(before.branding);
    expect(storage.audit()).toHaveLength(before.audit);
    // At exactly the limit the body is let in (and then refused by the schema: the image is too long).
    const exact = await post(storage.app.client, head + fill(limit) + tail);
    expect(exact.status).toBe(422);
    expect(await problemCode(exact)).toBe('import_invalid');
  });

  it('refuses an invalid name and an invalid accent with import_invalid and a pointer', async () => {
    const storage = await app();
    const name = await post(storage.app.client, document({ orgName: 'bad‮name' }));
    expect(name.status).toBe(422);
    const named = await problemOf(name);
    expect(named.code).toBe('import_invalid');
    expect(named.errors).toEqual([{ pointer: '/orgName', code: 'org_name_invalid' }]);

    const accent = await post(storage.app.client, document({ accent: 'red' }));
    const accented = await problemOf(accent);
    expect(accented.code).toBe('import_invalid');
    expect(accented.errors).toEqual([{ pointer: '/accent', code: 'accent_invalid' }]);

    const both = await problemOf(
      await post(storage.app.client, document({ orgName: '   ', accent: '#12' })),
    );
    expect(both.errors?.map((error) => error.pointer).sort()).toEqual(['/accent', '/orgName']);
  });

  it('points at the image that is not valid base64', async () => {
    const storage = await app();
    const problem = await problemOf(
      await post(storage.app.client, document({}, { logoDark: 'AAA' })),
    );
    expect(problem.code).toBe('import_invalid');
    expect(problem.errors?.[0]?.pointer).toBe('/images/logoDark');
  });
});

describe('R11 every image runs through the complete pipeline', () => {
  it('refuses bytes that are no image, naming the slot, and applies nothing', async () => {
    const storage = await app();
    const before = snapshot(storage);
    const response = await post(
      storage.app.client,
      document(
        {},
        {
          logoLight: b64(await distinctPng(1)),
          compact: b64(Buffer.from('plain text, no image at all')),
        },
      ),
    );
    expect(response.status).toBe(415);
    const problem = await problemOf(response);
    expect(problem.code).toBe('image_type_unsupported');
    expect(problem.errors).toEqual([
      { pointer: '/images/compact', code: 'image_type_unsupported' },
    ]);
    const after = snapshot(storage);
    expect(after.branding).toEqual(before.branding);
    // The first image was fine, but nothing was staged: all or nothing.
    expect(after.assets).toEqual(before.assets);
    expect(storage.audit().slice(before.audit)).toMatchObject([
      { action: 'branding.import', outcome: 'rejected', reason_code: 'image_type_unsupported' },
    ]);
  });

  it('fails the whole import for one tampered image (a PNG cut in the middle)', async () => {
    const storage = await app();
    const good = await distinctPng(3);
    const tampered = good.subarray(0, Math.floor(good.length / 2));
    const before = snapshot(storage);
    const response = await post(
      storage.app.client,
      document({}, { logoLight: b64(good), logoDark: b64(tampered) }),
    );
    expect(response.status).toBe(422);
    const problem = await problemOf(response);
    expect(['image_corrupt', 'image_type_unsupported']).toContain(problem.code);
    expect(problem.errors?.[0]?.pointer).toBe('/images/logoDark');
    expect(snapshot(storage).assets).toEqual(before.assets);
    expect(snapshot(storage).branding).toEqual(before.branding);
  });

  it('refuses a media type that does not match the bytes: JPEG bytes under a PNG name are judged by the bytes', async () => {
    const storage = await app();
    // A document has no media type member; the bytes decide. Bytes that are neither are refused.
    const response = await post(
      storage.app.client,
      document({}, { logoLight: b64(Buffer.from('GIF89a-not-really')) }),
    );
    expect(await problemCode(response)).toBe('image_type_unsupported');
  });

  it('refuses an SVG with a script by the same allowlist as the upload: the script is removed, never kept', async () => {
    const storage = await app();
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><script>alert(1)</script><rect width="64" height="64" fill="#0078d4"/></svg>',
    );
    const dry = await post(storage.app.client, document({}, { logoLight: b64(svg) }), {
      dryRun: true,
    });
    expect(dry.status).toBe(200);
    const result = ImportResultSchema.parse(await readJson(dry));
    expect(result.images.logoLight?.warnings.map((warning) => warning.code)).toContain(
      'svg_content_removed',
    );
    // What would be stored is a PNG of the pipeline, not the SVG.
    expect(result.images.logoLight?.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('R11 dry run', () => {
  it('stores nothing, returns the outcome and is audited with dryRun true', async () => {
    const storage = await app();
    const before = snapshot(storage);
    const png = await distinctPng(7);
    const response = await post(
      storage.app.client,
      document({ orgName: '  Dry   Run  ', accent: '#ABC' }, { logoLight: b64(png) }),
      { dryRun: true, ifMatch: null },
    );
    expect(response.status).toBe(200);
    const result = ImportResultSchema.parse(await readJson(response));
    expect(result).toMatchObject({
      dryRun: true,
      applied: false,
      orgName: 'Dry Run',
      accent: '#aabbcc',
      branding: null,
    });
    expect(result.images.logoLight).toMatchObject({ width: 64, height: 64 });
    expect(result.images.logoDark).toBeNull();
    expect(result.images.compact).toBeNull();
    const after = snapshot(storage);
    expect(after.branding).toEqual(before.branding);
    expect(after.assets).toEqual(before.assets);
    const rows = storage.audit().slice(before.audit);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'branding.import', outcome: 'success' });
    expect(detailOf(rows[0] as never)).toMatchObject({ dryRun: true, schemaVersion: 1 });
  });

  it('does not need If-Match, and ignores one', async () => {
    const storage = await app();
    expect(
      (await post(storage.app.client, document(), { dryRun: true, ifMatch: null })).status,
    ).toBe(200);
    expect(
      (await post(storage.app.client, document(), { dryRun: true, ifMatch: '"99"' })).status,
    ).toBe(200);
    expect(
      (await post(storage.app.client, document(), { dryRun: false, ifMatch: null })).status,
    ).toBe(428);
  });

  it('reports the same hashes a real import then stores', async () => {
    const storage = await app();
    const png = await distinctPng(8);
    const body = document({}, { logoLight: b64(png) });
    const dry = ImportResultSchema.parse(
      await readJson(await post(storage.app.client, body, { dryRun: true })),
    );
    const real = ImportResultSchema.parse(await readJson(await post(storage.app.client, body)));
    expect(real.images.logoLight?.hash).toBe(dry.images.logoLight?.hash);
    expect(real.branding?.logos.light?.hash).toBe(dry.images.logoLight?.hash);
  });
});

describe('R11 applying an import', () => {
  it('requires If-Match: 428 when missing, 422 when malformed, 412 when stale; nothing changes', async () => {
    const storage = await app();
    const before = snapshot(storage);
    const missing = await post(storage.app.client, document(), { ifMatch: null });
    expect(missing.status).toBe(428);
    expect(await problemCode(missing)).toBe('precondition_required');
    const malformed = await post(storage.app.client, document(), { ifMatch: 'W/"1"' });
    expect(malformed.status).toBe(422);
    expect((await problemOf(malformed)).errors).toEqual([
      { pointer: 'header/If-Match', code: 'invalid_etag' },
    ]);
    const stale = await post(storage.app.client, document(), { ifMatch: '"7"' });
    expect(stale.status).toBe(412);
    expect(await problemCode(stale)).toBe('branding_conflict');
    expect(snapshot(storage).branding).toEqual(before.branding);
  });

  it('applies name, accent and images in one step: a new revision, an ETag, branding.import in the audit', async () => {
    const storage = await app();
    const before = snapshot(storage);
    const response = await post(
      storage.app.client,
      document(
        { orgName: ' Imported \u00a0 Org ', accent: '#D83B01' },
        { logoLight: b64(await distinctPng(21)), logoDark: b64(await distinctPng(22)) },
      ),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBe('"2"');
    const result = ImportResultSchema.parse(await readJson(response));
    expect(result).toMatchObject({
      dryRun: false,
      applied: true,
      orgName: 'Imported Org',
      accent: '#d83b01',
    });
    expect(BrandingSchema.parse(result.branding)).toEqual(storage.service.get());
    expect(result.branding).toMatchObject({
      revision: 2,
      orgName: 'Imported Org',
      accent: '#d83b01',
      compactDerived: true,
    });
    expect(result.branding?.logos.light?.hash).toBe(result.images.logoLight?.hash);
    expect(result.branding?.logos.dark?.hash).toBe(result.images.logoDark?.hash);
    const rows = storage.audit().slice(before.audit);
    expect(rows.map((row) => [row.action, row.outcome])).toEqual([['branding.import', 'success']]);
    const detail = detailOf(rows[0] as never);
    expect(detail).toMatchObject({
      dryRun: false,
      schemaVersion: 1,
      fromRevision: 1,
      toRevision: 2,
      orgNameNew: 'Imported Org',
      accentNew: '#d83b01',
    });
    expect(JSON.stringify(detail)).not.toMatch(/iVBOR/);
  });

  it('lets a concurrent change win: 412, and the staged images stay unreferenced', async () => {
    const storage = await app();
    const response = await post(
      storage.app.client,
      document({}, { logoLight: b64(await distinctPng(31)) }),
      {
        ifMatch: '"1"',
      },
    );
    expect(response.status).toBe(200);
    const again = await post(
      storage.app.client,
      document({}, { logoLight: b64(await distinctPng(32)) }),
      {
        ifMatch: '"1"',
      },
    );
    expect(again.status).toBe(412);
    expect(storage.service.get().revision).toBe(2);
    const loser = storage.assets().filter((row) => row.unreferenced_at !== null);
    expect(loser.length).toBeGreaterThan(0);
  });

  it('answers 403 and audits the denial for the anonymous actor; nothing is parsed', async () => {
    const storage = await app(false);
    const before = storage.audit().length;
    const response = await post(storage.app.client, '{not even json');
    expect(response.status).toBe(403);
    expect(await problemCode(response)).toBe('permission_denied');
    const rows = storage.audit().slice(before);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'denied' });
  });

  it('refuses a request that is not JSON with 415', async () => {
    const storage = await app();
    const response = await storage.app.client.post(IMPORT, {
      headers: { 'Content-Type': 'text/plain', 'If-Match': '"1"' },
      body: JSON.stringify(document()),
    });
    expect(response.status).toBe(415);
  });

  it('refuses a dryRun value that is not true or false', async () => {
    const storage = await app();
    const response = await storage.app.client.post(`${IMPORT}?dryRun=yes`, {
      headers: { 'Content-Type': 'application/json', 'If-Match': '"1"' },
      body: JSON.stringify(document()),
    });
    expect(response.status).toBe(422);
  });
});

describe('export then import reproduces the original', () => {
  it('gives the same name, accent and logo hashes, and a derived compact again', async () => {
    const storage = await app();
    const original = await applyLogos(
      storage,
      { light: await distinctPng(41), dark: await solidPng(80, 40, [10, 10, 10]) },
      'Round Trip BV',
      '#107c10',
    );
    const exported = await readJson<BrandingExport>(await storage.app.client.get(EXPORT));

    // Wipe the branding, then bring it back from the file.
    const reset = await storage.app.client.delete('/api/v1/branding', {
      headers: { 'If-Match': `"${String(storage.service.get().revision)}"` },
    });
    expect(reset.status).toBe(200);
    expect(storage.service.get().orgName).toBe('M365Portal');

    const restored = await post(storage.app.client, exported, {
      ifMatch: `"${String(storage.service.get().revision)}"`,
    });
    expect(restored.status).toBe(200);
    const branding = ImportResultSchema.parse(await readJson(restored)).branding;
    expect(branding).toMatchObject({
      orgName: original.orgName,
      accent: original.accent,
      compactDerived: original.compactDerived,
      tokens: original.tokens,
      monogram: original.monogram,
    });
    expect(branding?.logos.light?.hash).toBe(original.logos.light?.hash);
    expect(branding?.logos.dark?.hash).toBe(original.logos.dark?.hash);
    expect(branding?.icons).toEqual(original.icons);

    // And the second export is the first one.
    const second = await readJson<BrandingExport>(await storage.app.client.get(EXPORT));
    expect(second).toEqual(exported);
    expect(sha256Hex(Buffer.from(JSON.stringify(second)))).toBe(
      sha256Hex(Buffer.from(JSON.stringify(exported))),
    );
  });
});

describe('R10 and R11 in the route table', () => {
  it('are registered with their permission, rate class, audit action and documented', async () => {
    const storage = await app();
    const routes = exportImportRoutes({
      requireDatabase: storage.requireDatabase,
      now: () => storage.clock.nowMs(),
      assets: storage.store,
      images: storage.images,
      service: storage.service,
    });
    expect(
      routes.map((route) => [route.id, route.method, route.path, route.rateLimit, route.audit]),
    ).toEqual([
      ['branding.export', 'GET', '/api/v1/branding/export', 'read', 'branding.export'],
      ['branding.import', 'POST', '/api/v1/branding/import', 'upload', 'branding.import'],
    ]);
    for (const route of routes) expect(route.access).toEqual({ permission: 'settings:branding' });
    const paths = storage.app.app.http.document.paths as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    expect(paths[EXPORT]?.get).toMatchObject({
      'x-permission': 'settings:branding',
      'x-audit': 'branding.export',
    });
    expect(paths[IMPORT]?.post).toMatchObject({
      'x-rate-limit': 'upload',
      'x-audit': 'branding.import',
    });
  });
});
