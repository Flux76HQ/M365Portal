// T-A-086 (R7 over HTTP: the error answers) and T-A-087 (R6, R8, R9; FR-A-080, FR-A-082, FR-A-083, E-04):
// the branding routes through the real route wrapper, the real denial audit and a migrated database.
//
// What is proven here is the contract of `contracts/phase-a-api.md` sections 4 and 6 as an HTTP
// client sees it: statuses, problem codes, the pointers of validation errors, `ETag` and `If-Match`,
// who may write and what a denial leaves in the audit trail. The pipeline behind the upload has its
// own tests; the transaction and the audit entries of the service have theirs.
import { deriveAccentTokens } from '@m365portal/shared/branding/accent';
import { LIMITS } from '@m365portal/shared/limits';
import { ProblemSchema } from '@m365portal/shared/problem';
import { UploadAssetResponseSchema } from '@m365portal/shared/schemas/assets';
import { BrandingSchema } from '@m365portal/shared/schemas/branding';
import { Validator } from '@seriousme/openapi-schema-validator';
import { describe, expect, it } from 'vitest';
import { writeRoutesOf, requestBodyFor } from '../helpers/http-app.js';
import { readJson, type HttpClient } from '../helpers/http-client.js';
import {
  createBrandingApp,
  detailOf,
  distinctPng,
  failingImages,
  solidPng,
  type BrandingApp,
} from './branding-fixture.js';

const PATH = '/api/v1/branding';
const UPLOAD = '/api/v1/branding/assets';

const body = (orgName: string, accent = '#0078d4', light: string | null = null) => ({
  orgName,
  accent,
  logos: { light, dark: null, compact: null },
});

async function put(
  client: HttpClient,
  json: unknown,
  ifMatch: string | null = '"1"',
): Promise<Response> {
  return client.put(PATH, {
    json,
    ...(ifMatch === null ? {} : { headers: { 'If-Match': ifMatch } }),
  });
}

async function upload(
  app: BrandingApp,
  bytes: Uint8Array,
  slot = 'logoLight',
  client: HttpClient = app.app.client,
): Promise<Response> {
  const form = new FormData();
  form.set('file', new Blob([bytes]), 'logo.png');
  return client.post(`${UPLOAD}?slot=${slot}`, { body: form });
}

async function stage(app: BrandingApp, seed: number, slot = 'logoLight'): Promise<string> {
  const response = await upload(app, await distinctPng(seed), slot);
  expect(response.status).toBe(201);
  return UploadAssetResponseSchema.parse(await readJson(response)).asset.hash;
}

describe('R6 GET /api/v1/branding', () => {
  it('is public: the anonymous actor gets the branding with an ETag of the revision', async () => {
    const app = await createBrandingApp({ signedIn: false });
    const response = await app.app.client.get(PATH);
    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBe('"1"');
    expect(response.headers.get('cache-control')).toContain('no-store');
    const branding = BrandingSchema.parse(await readJson(response));
    expect(branding).toMatchObject({ revision: 1, orgName: 'M365Portal', isDefaultName: true });
    expect(branding.logos).toEqual({ light: null, dark: null, compact: null });
    expect(Object.values(branding.icons).every((icon) => icon.url.startsWith('/branding/'))).toBe(
      true,
    );
  });

  it('exposes no actor identity and no internal columns', async () => {
    const app = await createBrandingApp();
    await put(app.app.client, body('Acme'));
    const text = await (await app.app.client.get(PATH)).text();
    for (const leak of ['preview', 'updated_by', 'updatedBy', 'actor', 'system']) {
      expect(text, leak).not.toContain(leak);
    }
  });

  it('answers 503 storage_unavailable when storage is unusable (degraded mode)', async () => {
    const app = await createBrandingApp();
    app.setStorageAvailable(false);
    const response = await app.app.client.get(PATH);
    expect(response.status).toBe(503);
    expect(await readJson(response)).toMatchObject({ code: 'storage_unavailable' });
    for (const write of [
      await upload(app, await distinctPng(55)),
      await put(app.app.client, body('X')),
      await app.app.client.delete(PATH, { headers: { 'If-Match': '"1"' } }),
    ]) {
      expect(write.status).toBe(503);
    }
  });

  it('carries the tokens of deriveAccentTokens for the stored accent', async () => {
    const app = await createBrandingApp();
    await put(app.app.client, body('Acme', '#CC3366'));
    const branding = BrandingSchema.parse(await readJson(await app.app.client.get(PATH)));
    expect(branding.accent).toBe('#cc3366');
    expect(branding.tokens).toEqual(deriveAccentTokens('#cc3366'));
  });
});

describe('R8 PUT /api/v1/branding', () => {
  it('applies with the right If-Match: 200, a new ETag and the new revision', async () => {
    const app = await createBrandingApp();
    const response = await put(app.app.client, body('Acme Vereniging'));
    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBe('"2"');
    const branding = BrandingSchema.parse(await readJson(response));
    expect(branding).toMatchObject({
      revision: 2,
      orgName: 'Acme Vereniging',
      isDefaultName: false,
    });
    expect(BrandingSchema.parse(await readJson(await app.app.client.get(PATH)))).toEqual(branding);
  });

  it('answers 412 branding_conflict for a stale If-Match and changes nothing', async () => {
    const app = await createBrandingApp();
    await put(app.app.client, body('First'));
    const stale = await put(app.app.client, body('Second'), '"1"');
    expect(stale.status).toBe(412);
    expect(ProblemSchema.parse(await readJson(stale))).toMatchObject({ code: 'branding_conflict' });
    expect(app.service.get().orgName).toBe('First');
  });

  it('answers 428 precondition_required when If-Match is missing', async () => {
    const app = await createBrandingApp();
    const response = await put(app.app.client, body('X'), null);
    expect(response.status).toBe(428);
    expect(await readJson(response)).toMatchObject({ code: 'precondition_required' });
    expect(app.service.revision()).toBe(1);
  });

  it.each(['3', 'W/"3"', '"03"', '*', '"3", "4"', '""', '"-1"', '"1.5"', `"${'9'.repeat(16)}"`])(
    'answers 422 validation_failed with the pointer header/If-Match for the malformed value %s',
    async (value) => {
      const app = await createBrandingApp();
      const response = await put(app.app.client, body('X'), value);
      expect(response.status).toBe(422);
      expect(await readJson(response)).toMatchObject({
        code: 'validation_failed',
        errors: [{ pointer: 'header/If-Match' }],
      });
      expect(app.service.revision()).toBe(1);
    },
  );

  it('stores #ABC as #aabbcc (E-04)', async () => {
    const app = await createBrandingApp();
    const response = await put(app.app.client, body('Acme', '#ABC'));
    expect(BrandingSchema.parse(await readJson(response)).accent).toBe('#aabbcc');
    expect(
      (app.database.sqlite.prepare('SELECT accent FROM branding').get() as { accent: string })
        .accent,
    ).toBe('#aabbcc');
  });

  it.each(['', 'blue', '#12', '#12345', '#gggggg', '0078d4', '#0078d4ff', 'rgb(0,0,0)'])(
    'answers 422 accent_invalid for the accent %j',
    async (accent) => {
      const app = await createBrandingApp();
      const response = await put(app.app.client, body('Acme', accent));
      expect(response.status).toBe(422);
      expect(await readJson(response)).toMatchObject({
        code: 'accent_invalid',
        errors: [{ pointer: '/accent', code: 'accent_invalid' }],
      });
      expect(app.service.revision()).toBe(1);
    },
  );

  it.each(['', '   ', 'x'.repeat(65), '"><img src=x onerror=alert(1)>‮', '​hidden', 'tab\there'])(
    'answers 422 org_name_invalid for the name %j',
    async (orgName) => {
      const app = await createBrandingApp();
      const response = await put(app.app.client, body(orgName));
      expect(response.status).toBe(422);
      expect(await readJson(response)).toMatchObject({
        code: 'org_name_invalid',
        errors: [{ pointer: '/orgName', code: 'org_name_invalid' }],
      });
      expect(app.service.revision()).toBe(1);
    },
  );

  it('stores a hostile-looking name as plain text', async () => {
    const app = await createBrandingApp();
    const name = '"><img src=x onerror=alert(1)>';
    const response = await put(app.app.client, body(name));
    expect(response.status).toBe(200);
    expect(BrandingSchema.parse(await readJson(response)).orgName).toBe(name);
  });

  it('answers 422 asset_unknown for a hash that is not registered', async () => {
    const app = await createBrandingApp();
    const response = await put(app.app.client, body('X', '#0078d4', 'a'.repeat(64)));
    expect(response.status).toBe(422);
    expect(await readJson(response)).toMatchObject({
      code: 'asset_unknown',
      errors: [{ pointer: '/logos/light', code: 'asset_unknown' }],
    });
  });

  it('answers 422 validation_failed for an asset too large for its slot', async () => {
    const app = await createBrandingApp();
    const response = await upload(app, await solidPng(512, 512, [9, 9, 9]), 'logoLight');
    const big = UploadAssetResponseSchema.parse(await readJson(response)).asset.hash;
    const asCompact = await put(app.app.client, {
      orgName: 'X',
      accent: '#0078d4',
      logos: { light: null, dark: null, compact: big },
    });
    expect(asCompact.status).toBe(422);
    expect(await readJson(asCompact)).toMatchObject({
      code: 'validation_failed',
      errors: [{ pointer: '/logos/compact' }],
    });
  });

  it.each([
    ['an unknown key', { ...body('X'), extra: true }],
    [
      'an unknown key in logos',
      { ...body('X'), logos: { light: null, dark: null, compact: null, x: 1 } },
    ],
    ['a missing field', { orgName: 'X', accent: '#0078d4' }],
    ['a logo that is not a hash', body('X', '#0078d4', 'not-a-hash')],
    ['a number for the name', { ...body('X'), orgName: 5 }],
    ['an array', []],
    ['null', null],
  ])('answers 422 validation_failed for %s', async (_name, json) => {
    const app = await createBrandingApp();
    const response = await put(app.app.client, json);
    expect(response.status).toBe(422);
    const problem = await readJson<{ code: string }>(response);
    expect(['validation_failed', 'org_name_invalid']).toContain(problem.code);
    expect(app.service.revision()).toBe(1);
  });

  it('answers 415 for a body that is not JSON', async () => {
    const app = await createBrandingApp();
    const response = await app.app.client.put(PATH, {
      body: JSON.stringify(body('X')),
      headers: { 'Content-Type': 'text/plain', 'If-Match': '"1"' },
    });
    expect(response.status).toBe(415);
  });

  it('applies a staged logo: the view carries it, with a derived compact', async () => {
    const app = await createBrandingApp();
    const hash = await stage(app, 40);
    const response = await put(app.app.client, body('Acme', '#0078d4', hash));
    expect(response.status).toBe(200);
    const branding = BrandingSchema.parse(await readJson(response));
    expect(branding.logos.light).toMatchObject({ hash, url: `/branding/${hash}.png` });
    expect(branding.compactDerived).toBe(true);
    expect(branding.logos.compact?.width).toBeLessThanOrEqual(LIMITS.image.compactMasterPx);
  });

  it('answers 429 image_processing_busy with Retry-After when the runner is full, and changes nothing', async () => {
    const app = await createBrandingApp({ images: failingImages('image_processing_busy') });
    const response = await put(app.app.client, body('X'));
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('5');
    expect(app.service.revision()).toBe(1);
  });
});

describe('R9 DELETE /api/v1/branding', () => {
  it('resets to the defaults at a new revision', async () => {
    const app = await createBrandingApp();
    const hash = await stage(app, 41);
    await put(app.app.client, body('Acme', '#aa3300', hash));
    const response = await app.app.client.delete(PATH, { headers: { 'If-Match': '"2"' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBe('"3"');
    expect(BrandingSchema.parse(await readJson(response))).toMatchObject({
      revision: 3,
      orgName: 'M365Portal',
      isDefaultName: true,
      accent: '#0078d4',
      logos: { light: null, dark: null, compact: null },
      compactDerived: false,
    });
  });

  it('needs If-Match like the PUT: 428 without, 412 when stale, 422 when malformed', async () => {
    const app = await createBrandingApp();
    expect((await app.app.client.delete(PATH)).status).toBe(428);
    expect((await app.app.client.delete(PATH, { headers: { 'If-Match': '"7"' } })).status).toBe(
      412,
    );
    const malformed = await app.app.client.delete(PATH, { headers: { 'If-Match': 'W/"1"' } });
    expect(malformed.status).toBe(422);
    expect(await readJson(malformed)).toMatchObject({ errors: [{ pointer: 'header/If-Match' }] });
    expect(app.service.revision()).toBe(1);
  });
});

describe('who may write (FR-A-033, FR-A-034)', () => {
  it('gives the anonymous actor an audited 401 on PUT, DELETE and the upload (was 403 in Phase A, FR-B-414)', async () => {
    const app = await createBrandingApp({ signedIn: false });
    const before = app.audit().length;
    const responses = [
      await put(app.app.client, body('X')),
      await app.app.client.delete(PATH, { headers: { 'If-Match': '"1"' } }),
      await upload(app, await distinctPng(50)),
    ];
    expect(responses.map((response) => response.status)).toEqual([401, 401, 401]);
    for (const response of responses) {
      expect(await readJson(response)).toMatchObject({ code: 'unauthenticated' });
    }
    const denied = app.audit().slice(before);
    expect(denied.map((row) => [row.action, row.outcome, row.reason_code, row.actor_kind])).toEqual(
      [
        ['branding.apply', 'denied', 'permission_missing', 'anonymous'],
        ['branding.reset', 'denied', 'permission_missing', 'anonymous'],
        ['branding.asset.stage', 'denied', 'permission_missing', 'anonymous'],
      ],
    );
    expect(detailOf(denied[0] as never)).toEqual({
      method: 'PUT',
      route: '/api/v1/branding',
      permission: 'settings:branding',
    });
    expect(app.service.revision()).toBe(1);
    expect(app.assets().filter((row) => row.unreferenced_at !== null)).toHaveLength(0);
  });

  it('lets an administrator write', async () => {
    const app = await createBrandingApp();
    expect((await put(app.app.client, body('X'))).status).toBe(200);
    expect((await app.app.client.delete(PATH, { headers: { 'If-Match': '"2"' } })).status).toBe(
      200,
    );
  });

  it('denies every write route of the table to the anonymous actor, with an audit entry (table-driven)', async () => {
    const app = await createBrandingApp({ signedIn: false });
    const routes = writeRoutesOf(app.app);
    expect(routes.map((route) => route.id).sort()).toEqual([
      'branding.apply',
      'branding.asset.stage',
      'branding.reset',
    ]);
    for (const route of routes) {
      const before = app.audit().length;
      const response = await app.app.client.request(
        route.method,
        route.path,
        requestBodyFor(route),
      );
      expect(response.status, route.id).toBe(401);
      const added = app.audit().slice(before);
      expect(added, route.id).toHaveLength(1);
      expect(added[0], route.id).toMatchObject({ action: route.id, outcome: 'denied' });
    }
  });

  it('refuses a write from another origin and without a CSRF token before it looks at permissions', async () => {
    const app = await createBrandingApp();
    const foreign = await app.app.client.put(PATH, {
      json: body('X'),
      origin: 'https://evil.example',
      headers: { 'If-Match': '"1"' },
    });
    expect(foreign.status).toBe(403);
    expect(await readJson(foreign)).toMatchObject({ code: 'origin_not_allowed' });
    const tokenless = await app.app.client.put(PATH, {
      json: body('X'),
      csrf: 'none',
      headers: { 'If-Match': '"1"' },
    });
    expect(await readJson(tokenless)).toMatchObject({ code: 'csrf_invalid' });
    expect(app.service.revision()).toBe(1);
  });
});

describe('the route table and the OpenAPI document (R6 to R9)', () => {
  it('lists the four routes with their access, rate class and audit action', async () => {
    const app = await createBrandingApp();
    const routes = app.app.http.table.routes.filter((route) => route.id.startsWith('branding.'));
    const summary = routes
      .map((route) => ({
        id: route.id,
        method: route.methods[0],
        path: route.paths[0],
        access: route.access,
        rateLimit: route.rateLimit,
        audit: route.audit,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    expect(summary).toEqual([
      {
        id: 'branding.apply',
        method: 'PUT',
        path: '/api/v1/branding',
        access: { permission: 'settings:branding' },
        rateLimit: 'write',
        audit: 'branding.apply',
      },
      {
        id: 'branding.asset.stage',
        method: 'POST',
        path: '/api/v1/branding/assets',
        access: { permission: 'settings:branding' },
        rateLimit: 'upload',
        audit: 'branding.asset.stage',
      },
      {
        id: 'branding.get',
        method: 'GET',
        path: '/api/v1/branding',
        access: { public: true },
        rateLimit: 'read',
        audit: undefined,
      },
      {
        id: 'branding.reset',
        method: 'DELETE',
        path: '/api/v1/branding',
        access: { permission: 'settings:branding' },
        rateLimit: 'write',
        audit: 'branding.reset',
      },
    ]);
  });

  it('produces a document that validates against the OpenAPI 3.1 meta-schema', async () => {
    const app = await createBrandingApp();
    const result = await new Validator().validate(app.app.http.document as never);
    expect(result.valid).toBe(true);
  });

  it('documents them with the extensions and the shared schemas', async () => {
    const app = await createBrandingApp();
    const paths = app.app.http.document.paths as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    expect(paths[PATH]?.get).toMatchObject({ 'x-public': true, 'x-rate-limit': 'read' });
    expect(paths[PATH]?.put).toMatchObject({
      'x-permission': 'settings:branding',
      'x-rate-limit': 'write',
      'x-audit': 'branding.apply',
    });
    expect(paths[PATH]?.delete).toMatchObject({
      'x-permission': 'settings:branding',
      'x-audit': 'branding.reset',
    });
    expect(paths[UPLOAD]?.post).toMatchObject({
      'x-permission': 'settings:branding',
      'x-rate-limit': 'upload',
    });
    const text = JSON.stringify(app.app.http.document);
    for (const schema of ['Branding', 'ApplyBrandingRequest', 'UploadAssetResponse']) {
      expect(text, schema).toContain(`"${schema}"`);
    }
    expect(text).toContain('multipart/form-data');
  });
});

describe('R7 POST /api/v1/branding/assets: the error answers', () => {
  it('answers 422 for a slot that is not one of the three, and for none', async () => {
    const app = await createBrandingApp();
    for (const slot of ['logo', 'LOGOLIGHT', '', 'compact,logoDark']) {
      const response = await upload(app, await distinctPng(51), slot);
      expect(response.status, slot).toBe(422);
      expect(await readJson(response), slot).toMatchObject({
        code: 'validation_failed',
        errors: [{ pointer: 'query/slot' }],
      });
    }
    const form = new FormData();
    form.set('file', new Blob([await distinctPng(51)]), 'a.png');
    const missing = await app.app.client.post(UPLOAD, { body: form });
    expect(missing.status).toBe(422);
    expect(app.assets().filter((row) => row.unreferenced_at !== null)).toHaveLength(0);
  });

  it('answers 415 unsupported_media_type for a body that is not multipart', async () => {
    const app = await createBrandingApp();
    const json = await app.app.client.post(`${UPLOAD}?slot=logoLight`, { json: { file: 'x' } });
    expect(json.status).toBe(415);
    expect(await readJson(json)).toMatchObject({ code: 'unsupported_media_type' });
    const text = await app.app.client.post(`${UPLOAD}?slot=logoLight`, {
      body: 'x',
      headers: { 'Content-Type': 'text/plain' },
    });
    expect(text.status).toBe(415);
  });

  it('answers 409 staging_quota_exceeded for the 33rd waiting file, audited, with nothing written for it', async () => {
    const app = await createBrandingApp();
    for (let seed = 0; seed < LIMITS.staging.quotaFiles; seed += 1) await stage(app, seed);
    const filesBefore = app.assets().length;
    const response = await upload(app, await distinctPng(40));
    expect(response.status).toBe(409);
    const problem = await readJson(response);
    expect(problem).toMatchObject({ code: 'staging_quota_exceeded', status: 409 });
    // The detail says which part of the quota is full, and what fills it (no hashes, no paths).
    expect((problem as { detail: string }).detail).toBe(
      'The file limit of the staging quota is full: 32 of 32 files. 32 uploaded images are waiting to be applied and 0 are kept for 24 hours so the last change can be undone.',
    );
    expect(app.assets()).toHaveLength(filesBefore);
    expect(app.audit().at(-1)).toMatchObject({
      action: 'branding.asset.stage',
      outcome: 'rejected',
      reason_code: 'staging_quota_exceeded',
    });
    // The same bytes as one that waits are still fine: they count once.
    const again = await upload(app, await distinctPng(3));
    expect(again.status).toBe(200);
  });

  it('answers 429 image_processing_busy with Retry-After and does not audit it', async () => {
    const app = await createBrandingApp({ images: failingImages('image_processing_busy') });
    const before = app.audit().length;
    const response = await upload(app, await distinctPng(52));
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('5');
    expect(await readJson(response)).toMatchObject({ code: 'image_processing_busy' });
    expect(app.audit()).toHaveLength(before);
  });

  it('answers 422 image_processing_timeout and audits it as rejected', async () => {
    const app = await createBrandingApp({ images: failingImages('image_processing_timeout') });
    const response = await upload(app, await distinctPng(53));
    expect(response.status).toBe(422);
    expect(await readJson(response)).toMatchObject({ code: 'image_processing_timeout' });
    expect(app.audit().at(-1)).toMatchObject({
      outcome: 'rejected',
      reason_code: 'image_processing_timeout',
    });
  });

  it('answers 503 shutting_down while the server stops, without touching the pipeline', async () => {
    const app = await createBrandingApp({ isShuttingDown: () => true });
    const before = app.audit().length;
    const response = await upload(app, await distinctPng(54));
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('5');
    expect(await readJson(response)).toMatchObject({ code: 'shutting_down' });
    expect(app.audit()).toHaveLength(before);
  });

  it('answers 422 for each content refusal of the pipeline and audits each as rejected', async () => {
    const app = await createBrandingApp();
    const cases: [string, Uint8Array, number, string][] = [
      ['not an image', Buffer.from('plain text'), 415, 'image_type_unsupported'],
      ['one byte', Uint8Array.of(0x41), 415, 'image_type_unsupported'],
      ['GIF', Buffer.from('GIF89a\u0001\u0000\u0001\u0000'), 415, 'image_type_unsupported'],
      [
        'SVG with a DOCTYPE',
        Buffer.from('<!DOCTYPE svg [<!ENTITY a "b">]><svg xmlns="http://www.w3.org/2000/svg"/>'),
        422,
        'svg_doctype_forbidden',
      ],
      [
        'SVG with text',
        Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><text>x</text></svg>',
        ),
        422,
        'svg_text_unsupported',
      ],
    ];
    for (const [name, bytes, status, code] of cases) {
      const response = await upload(app, bytes);
      expect(response.status, name).toBe(status);
      expect(await readJson(response), name).toMatchObject({ code });
      expect(app.audit().at(-1), name).toMatchObject({ outcome: 'rejected', reason_code: code });
    }
  });
});
