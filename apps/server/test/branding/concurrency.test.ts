// T-A-085 (FR-A-083, invariants I-1 and I-2, E-11): optimistic concurrency of the branding.
//
// The branding is one row with a revision. Every accepted change moves it by exactly one, in one
// statement that names the revision it expects; a writer that expected another one gets 412
// `branding_conflict` and changes nothing. A missing precondition is 428. Staged uploads of identical
// bytes converge. The races below are real interleavings of asynchronous work (each apply awaits the
// image job before it takes the write lock), not sequential calls with a pretend conflict.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createBrandingService } from '../../src/branding/service.js';
import { readJson } from '../helpers/http-client.js';
import {
  createBrandingApp,
  createBrandingStorage,
  distinctPng,
  inProcessImages,
  type BrandingImages,
} from './branding-fixture.js';

const PREVIEW = { actor: { kind: 'preview', id: 'preview' } } as const;
const choice = (orgName: string, light: string | null = null) =>
  ({ orgName, accent: '#0078d4', logos: { light, dark: null, compact: null } }) as const;

/** Images that wait for the test before they answer, so that two applies are both in flight. */
function gatedImages(): { images: BrandingImages; release: () => void; started: () => number } {
  const inner = inProcessImages();
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let started = 0;
  return {
    images: {
      process: (input) => inner.process(input),
      deriveVariants: async (input) => {
        started += 1;
        await gate;
        return inner.deriveVariants(input);
      },
    },
    release: open,
    started: () => started,
  };
}

describe('two writers on the same revision (FR-A-083, E-11)', () => {
  it('give one winner and one branding_conflict, and nothing of the loser is stored', async () => {
    const gated = gatedImages();
    // The default row is made with plain images; the two writers then share the gated ones.
    const storage = await createBrandingStorage();
    const racing = createBrandingService({
      requireDatabase: () => storage.database,
      now: () => storage.clock.nowMs(),
      assets: storage.store,
      images: gated.images,
    });
    const first = racing.apply(choice('First writer'), 1, PREVIEW);
    const second = racing.apply(choice('Second writer'), 1, PREVIEW);
    // Both are past the revision check and waiting for the image job.
    await new Promise((resolve) => setImmediate(resolve));
    expect(gated.started()).toBe(2);
    gated.release();

    const results = await Promise.allSettled([first, second]);
    const winners = results.filter((result) => result.status === 'fulfilled');
    const losers = results.filter((result) => result.status === 'rejected');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]).toMatchObject({ reason: { code: 'branding_conflict' } });

    const now = racing.get();
    expect(now.revision).toBe(2);
    const winnerName = (winners[0] as PromiseFulfilledResult<{ orgName: string }>).value.orgName;
    expect(now.orgName).toBe(winnerName);
    // Exactly one apply entry, and the chain is intact.
    expect(storage.audit().filter((row) => row.action === 'branding.apply')).toHaveLength(1);
  });

  it('works across two connections to the same file (two writers of one database)', async () => {
    const storage = await createBrandingStorage();
    const other = storage.connect();
    const second = createBrandingService({
      requireDatabase: () => other,
      now: () => storage.clock.nowMs(),
      assets: storage.store,
      images: inProcessImages(),
    });
    const results = await Promise.allSettled([
      storage.service.apply(choice('Via connection one'), 1, PREVIEW),
      second.apply(choice('Via connection two'), 1, PREVIEW),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(storage.service.revision()).toBe(2);
  });

  it('refuses a stale revision before any image work is done', async () => {
    const gated = gatedImages();
    gated.release();
    const storage = await createBrandingStorage({ images: gated.images });
    const startedBefore = gated.started();
    await expect(storage.service.apply(choice('Late'), 7, PREVIEW)).rejects.toMatchObject({
      code: 'branding_conflict',
    });
    await expect(storage.service.reset(0, PREVIEW)).rejects.toMatchObject({
      code: 'branding_conflict',
    });
    expect(gated.started()).toBe(startedBefore);
    expect(storage.service.revision()).toBe(1);
    expect(storage.audit()).toHaveLength(1);
  });

  it('decides apply against reset the same way: one winner', async () => {
    const storage = await createBrandingStorage();
    const results = await Promise.allSettled([
      storage.service.apply(choice('Applied'), 1, PREVIEW),
      storage.service.reset(1, PREVIEW),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(storage.service.revision()).toBe(2);
    const entries = storage.audit().map((row) => row.action);
    expect(entries.filter((action) => action !== 'branding.init')).toHaveLength(1);
  });
});

describe('the revision (I-2)', () => {
  it('increases by exactly one per accepted change and never otherwise', async () => {
    const storage = await createBrandingStorage();
    const seen: number[] = [storage.service.revision()];
    const accepted = async (action: Promise<unknown>): Promise<void> => {
      await action;
      seen.push(storage.service.revision());
    };

    await accepted(storage.service.apply(choice('One'), 1, PREVIEW));
    await accepted(storage.service.apply(choice('One'), 2, PREVIEW)); // identical values: still a change
    await accepted(storage.service.reset(3, PREVIEW));
    await accepted(storage.service.apply(choice('Four'), 4, PREVIEW));
    expect(seen).toEqual([1, 2, 3, 4, 5]);

    // Rejected attempts leave the revision where it is: stale, invalid name, invalid accent, unknown asset.
    const unknown = createHash('sha256').update('nothing').digest('hex');
    for (const attempt of [
      storage.service.apply(choice('Stale'), 4, PREVIEW),
      storage.service.apply(choice(''), 5, PREVIEW),
      storage.service.apply({ ...choice('Bad accent'), accent: 'blue' }, 5, PREVIEW),
      storage.service.apply(choice('Unknown asset', unknown), 5, PREVIEW),
    ]) {
      await expect(attempt).rejects.toBeDefined();
    }
    expect(storage.service.revision()).toBe(5);
  });

  it('starts at revision 1 with one row (I-1), and the default is created once', async () => {
    const storage = await createBrandingStorage();
    expect(storage.service.revision()).toBe(1);
    const rows = storage.database.sqlite.prepare('SELECT id, revision FROM branding').all();
    expect(rows).toEqual([{ id: 1, revision: 1 }]);
    expect(await storage.service.ensureDefault()).toEqual({ created: false });
    expect(storage.service.revision()).toBe(1);
    expect(storage.audit().filter((row) => row.action === 'branding.init')).toHaveLength(1);
  });
});

describe('over HTTP: the precondition and identical uploads', () => {
  const upload = async (
    app: Awaited<ReturnType<typeof createBrandingApp>>,
    bytes: Uint8Array,
  ): Promise<Response> => {
    const form = new FormData();
    form.set('file', new Blob([bytes]), 'logo.png');
    return app.app.client.post('/api/v1/branding/assets?slot=logoLight', { body: form });
  };

  it('answers 428 precondition_required when If-Match is missing and changes nothing', async () => {
    const app = await createBrandingApp();
    const response = await app.app.client.put('/api/v1/branding', {
      json: choice('No precondition'),
    });
    expect(response.status).toBe(428);
    expect(await readJson(response)).toMatchObject({ code: 'precondition_required' });
    const reset = await app.app.client.delete('/api/v1/branding');
    expect(reset.status).toBe(428);
    expect(app.service.revision()).toBe(1);
  });

  it('answers 412 for a stale If-Match and 200 for the current one', async () => {
    const app = await createBrandingApp();
    const stale = await app.app.client.put('/api/v1/branding', {
      json: choice('Stale'),
      headers: { 'If-Match': '"9"' },
    });
    expect(stale.status).toBe(412);
    expect(await readJson(stale)).toMatchObject({ code: 'branding_conflict' });
    const fine = await app.app.client.put('/api/v1/branding', {
      json: choice('Current'),
      headers: { 'If-Match': '"1"' },
    });
    expect(fine.status).toBe(200);
    expect(fine.headers.get('etag')).toBe('"2"');
  });

  it('lets identical simultaneous uploads converge: one 201, one 200, one file, one row', async () => {
    const app = await createBrandingApp();
    const bytes = await distinctPng(21);
    const rowsBefore = app.assets().length;
    const [first, second] = await Promise.all([upload(app, bytes), upload(app, bytes)]);
    expect([first.status, second.status].sort()).toEqual([200, 201]);
    const hashes = new Set(
      [
        await readJson<{ asset: { hash: string } }>(first),
        await readJson<{ asset: { hash: string } }>(second),
      ].map((body) => body.asset.hash),
    );
    expect(hashes.size).toBe(1);
    expect(app.assets()).toHaveLength(rowsBefore + 1);
    expect(app.usage().files).toBe(1);
  });
});
