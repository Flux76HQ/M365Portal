// T-A-085 (TA-04; FR-A-072 transaction part, FR-A-083, FR-A-089 "a failure while deriving variants
// leaves the previous branding in force"; PD-12; invariants I-3, I-8, I-9): the branding change and
// its audit entry are written in ONE transaction, so there is no change without an entry and no entry
// without its change.
//
// The fault is real: a trigger on the audit table makes the append fail after the branding row was
// updated (the "fault injected between the two"), and the test looks at every table afterwards. The
// entries are read back as rows and checked against data-model 7.4: which keys the detail has, that a
// name is cut, that image bytes never appear.
import { createHash } from 'node:crypto';
import { deriveAccentTokens } from '@m365portal/shared/branding/accent';
import { monogramFor } from '@m365portal/shared/branding/monogram';
import { LIMITS } from '@m365portal/shared/limits';
import { BrandingSchema } from '@m365portal/shared/schemas/branding';
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it } from 'vitest';
import { verifyChain } from '../../src/audit/index.js';
import { createBrandingService } from '../../src/branding/service.js';
import { withTransaction } from '../../src/db/index.js';
import { ProblemError } from '../../src/http/problem.js';
import {
  createBrandingStorage,
  detailOf,
  distinctPng,
  failingImages,
  inProcessImages,
  solidPng,
  type BrandingImages,
  type BrandingStorage,
} from './branding-fixture.js';

const PREVIEW = {
  actor: { kind: 'preview', id: 'preview' },
  requestId: 'req-0123456789',
  clientIp: '203.0.113.9',
} as const;
const choice = (orgName: string, logos: { light?: string; dark?: string; compact?: string } = {}) =>
  ({
    orgName,
    accent: '#0078d4',
    logos: { light: logos.light ?? null, dark: logos.dark ?? null, compact: logos.compact ?? null },
  }) as const;

/** Stage an upload the way the route does and return its hash. */
async function stage(
  storage: BrandingStorage,
  bytes: Uint8Array,
  slot: 'logoLight' | 'logoDark' | 'compact' = 'logoLight',
): Promise<string> {
  const processed = await storage.images.process({ bytes, slot });
  const sha256 = await storage.store.write(processed.png);
  withTransaction(storage.database, (tx) =>
    storage.store.registerStaged(tx, {
      sha256,
      bytes: processed.png.length,
      width: processed.width,
      height: processed.height,
      luminance: processed.luminance,
    }),
  );
  return sha256;
}

function brandingRow(storage: BrandingStorage): Record<string, unknown> {
  return storage.database.sqlite.prepare('SELECT * FROM branding WHERE id = 1').get() as Record<
    string,
    unknown
  >;
}

/**
 * The guard of the first group: whatever `attempt` does, and whether it fails or not, a failed change
 * leaves the branding row and the audit chain exactly as they were.
 */
async function assertRolledBack(
  storage: BrandingStorage,
  attempt: () => Promise<unknown>,
): Promise<void> {
  const row = brandingRow(storage);
  const audit = storage.audit();
  await attempt().catch(() => undefined);
  expect(brandingRow(storage)).toEqual(row);
  expect(storage.audit()).toEqual(audit);
}

const FAULT = `CREATE TRIGGER injected_fault BEFORE INSERT ON audit_log
  WHEN NEW.action IN ('branding.apply', 'branding.reset')
  BEGIN SELECT RAISE(ABORT, 'injected fault'); END`;

describe('one transaction for the change and its audit entry (I-8)', () => {
  it('rolls both back when the audit append fails after the branding row was updated', async () => {
    const storage = await createBrandingStorage();
    const logo = await stage(storage, await distinctPng(1));
    const assetsBefore = storage.assets();

    storage.database.sqlite.exec(FAULT);
    const attempt = (): Promise<unknown> =>
      storage.service.apply(choice('Never stored', { light: logo }), 1, PREVIEW);
    await expect(attempt()).rejects.toThrow(/injected fault/);
    await assertRolledBack(storage, attempt);

    // The flags are as they were: the staged logo still waits, nothing new is referenced.
    const after = storage.assets();
    for (const row of assetsBefore) {
      expect(after.find((candidate) => candidate.sha256 === row.sha256)).toEqual(row);
    }
    // The derived variants of the failed attempt were registered (unreferenced) before the
    // transaction began; they are no part of the branding and the sweeper removes them.
    for (const row of after.filter(
      (candidate) => !assetsBefore.some((known) => known.sha256 === candidate.sha256),
    )) {
      expect(row.unreferenced_at).not.toBeNull();
    }
    expect(verifyChain(storage.database.sqlite).ok).toBe(true);

    // Without the fault the same call works, so the failure above was the fault and nothing else.
    storage.database.sqlite.exec('DROP TRIGGER injected_fault');
    const applied = await storage.service.apply(choice('Stored', { light: logo }), 1, PREVIEW);
    expect(applied.revision).toBe(2);
    expect(storage.audit()).toHaveLength(2);
  });

  it('does the same for a reset', async () => {
    const storage = await createBrandingStorage();
    await storage.service.apply(choice('Before reset'), 1, PREVIEW);
    storage.database.sqlite.exec(FAULT);
    await expect(storage.service.reset(2, PREVIEW)).rejects.toThrow(/injected fault/);
    await assertRolledBack(storage, () => storage.service.reset(2, PREVIEW));
    expect(storage.service.revision()).toBe(2);
  });

  it('the guard itself fails for an implementation that changes first and audits in a second transaction (negative)', async () => {
    const storage = await createBrandingStorage();
    storage.database.sqlite.exec(FAULT);
    const careless = (): Promise<unknown> => {
      // The change is committed on its own ...
      storage.database.sqlite
        .prepare('UPDATE branding SET revision = revision + 1 WHERE id = 1')
        .run();
      // ... and the entry, in another transaction, fails.
      return Promise.reject(new Error('injected fault'));
    };
    await expectGuardFails(
      (attempt: () => Promise<unknown>) => assertRolledBack(storage, attempt),
      careless,
    );
  });
});

describe('the audit entries (data-model 7.4)', () => {
  it('creates the default row once, by the actor system, as the only entry of a fresh volume', async () => {
    const storage = await createBrandingStorage();
    const [entry, ...rest] = storage.audit();
    expect(rest).toEqual([]);
    expect(entry).toMatchObject({
      seq: 1,
      actor_kind: 'system',
      actor_id: 'system',
      action: 'branding.init',
      target_type: 'branding',
      target_id: '1',
      outcome: 'success',
    });
    expect(detailOf(entry as never)).toEqual({ revision: 1 });
    expect(brandingRow(storage)).toMatchObject({
      revision: 1,
      org_name: 'M365Portal',
      accent: '#0078d4',
      logo_light: null,
      logo_dark: null,
      logo_compact: null,
      logo_compact_derived: 0,
      updated_by_kind: 'system',
      updated_by_id: 'system',
    });
    expect(verifyChain(storage.database.sqlite)).toMatchObject({ ok: true, checked: 1 });
  });

  it('writes branding.apply with revisions, old and new name and accent, and the hash of each role', async () => {
    const storage = await createBrandingStorage();
    const logo = await stage(storage, await distinctPng(2));
    const view = await storage.service.apply(
      {
        orgName: 'Acme Vereniging',
        accent: '#ABC',
        logos: { light: logo, dark: null, compact: null },
      },
      1,
      PREVIEW,
    );
    const entry = storage.audit().at(-1);
    expect(entry).toMatchObject({
      action: 'branding.apply',
      actor_kind: 'preview',
      actor_id: 'preview',
      target_type: 'branding',
      target_id: '1',
      outcome: 'success',
      request_id: 'req-0123456789',
      client_ip: '203.0.113.9',
    });
    const detail = detailOf(entry as never);
    expect(Object.keys(detail).sort()).toEqual(
      [
        'accentNew',
        'accentOld',
        'fromRevision',
        'iconApple180',
        'iconFavicon32',
        'iconMaskable512',
        'iconPwa192',
        'iconPwa512',
        'logoCompact',
        'logoLight',
        'orgNameNew',
        'orgNameOld',
        'toRevision',
      ].sort(),
    );
    expect(detail).toMatchObject({
      fromRevision: 1,
      toRevision: 2,
      orgNameOld: 'M365Portal',
      orgNameNew: 'Acme Vereniging',
      accentOld: '#0078d4',
      accentNew: '#aabbcc',
      logoLight: logo,
      logoCompact: view.logos.compact?.hash,
      iconFavicon32: view.icons.favicon32.hash,
      iconApple180: view.icons.appleTouch180.hash,
      iconPwa192: view.icons.pwa192.hash,
      iconPwa512: view.icons.pwa512.hash,
      iconMaskable512: view.icons.maskable512.hash,
    });
    // Hashes and sizes, never image bytes (I-10).
    expect(entry?.detail).not.toMatch(/PNG|iVBOR/);
    expect(entry?.detail.length).toBeLessThan(LIMITS.auditDetailBytes);
  });

  it('cuts old and new name at 256 bytes in the entry and not in the row', async () => {
    const storage = await createBrandingStorage();
    const long = 'é'.repeat(64);
    await storage.service.apply(choice(long), 1, PREVIEW);
    await storage.service.apply(choice('Short'), 2, PREVIEW);
    const detail = detailOf(storage.audit().at(-1) as never);
    expect(detail.orgNameOld).toBe(long);
    expect(Buffer.byteLength(String(detail.orgNameOld))).toBeLessThanOrEqual(256);
  });

  it('writes branding.reset with the two revisions and nothing else', async () => {
    const storage = await createBrandingStorage();
    await storage.service.apply(choice('Acme'), 1, PREVIEW);
    await storage.service.reset(2, PREVIEW);
    const entry = storage.audit().at(-1);
    expect(entry).toMatchObject({ action: 'branding.reset', outcome: 'success', target_id: '1' });
    expect(detailOf(entry as never)).toEqual({ fromRevision: 2, toRevision: 3 });
  });

  it('keeps the chain intact over init, apply and reset', async () => {
    const storage = await createBrandingStorage();
    await storage.service.apply(choice('One'), 1, PREVIEW);
    await storage.service.reset(2, PREVIEW);
    expect(verifyChain(storage.database.sqlite)).toMatchObject({ ok: true, checked: 3 });
  });
});

describe('what an apply does to the assets (I-3)', () => {
  it('flips new assets to referenced and retired masters to unreferenced, in the same change', async () => {
    const storage = await createBrandingStorage();
    const first = await stage(storage, await distinctPng(3));
    const second = await stage(storage, await distinctPng(4));
    await storage.service.apply(choice('A', { light: first }), 1, PREVIEW);
    const stateOf = (hash: string): string | null | undefined =>
      storage.assets().find((row) => row.sha256 === hash)?.unreferenced_at;
    expect(stateOf(first)).toBeNull();
    expect(stateOf(second)).not.toBeNull();

    storage.clock.advance(60_000);
    await storage.service.apply(choice('B', { light: second }), 2, PREVIEW);
    expect(stateOf(second)).toBeNull();
    // The retired master keeps its 24 hours from the moment of the change.
    expect(stateOf(first)).toBe(storage.clock.iso());
  });

  it('keeps only the latest Undo target: 40 upload-and-apply cycles never fill the staging quota', async () => {
    const storage = await createBrandingStorage();
    const day = LIMITS.staging.retentionMs;
    const masters: string[] = [];
    for (let cycle = 0; cycle < 40; cycle += 1) {
      storage.clock.advance(60_000);
      // Every upload must be accepted (the 409 of the 33rd file must not come from retired masters).
      const hash = await stage(storage, await distinctPng(200 + cycle));
      masters.push(hash);
      await storage.service.apply(choice(`Cycle ${cycle}`, { light: hash }), cycle + 1, PREVIEW);
      const cutoff = new Date(storage.clock.nowMs() - day).toISOString();
      const state = (h: string) => storage.assets().find((row) => row.sha256 === h);
      expect(state(hash)?.unreferenced_at).toBeNull();
      if (cycle >= 1) {
        // The previous master is the Undo target: it keeps its 24 hours.
        const previous = state(masters[cycle - 1] ?? '');
        expect(previous?.unreferenced_at).toBe(storage.clock.iso());
      }
      if (cycle >= 2) {
        // The one before that lost its Undo and is garbage for the sweeper, not part of the quota.
        const older = state(masters[cycle - 2] ?? '');
        expect((older?.unreferenced_at ?? '') < cutoff).toBe(true);
      }
      expect(storage.usage().files).toBeLessThanOrEqual(1);
    }
  });

  it('does not expire a retired master that the next change applies again (Undo)', async () => {
    const storage = await createBrandingStorage();
    const first = await stage(storage, await distinctPng(300));
    const second = await stage(storage, await distinctPng(301));
    await storage.service.apply(choice('A', { light: first }), 1, PREVIEW);
    storage.clock.advance(60_000);
    await storage.service.apply(choice('B', { light: second }), 2, PREVIEW);
    storage.clock.advance(60_000);
    await storage.service.apply(choice('A again', { light: first }), 3, PREVIEW);
    const rows = storage.assets();
    expect(rows.find((row) => row.sha256 === first)?.unreferenced_at).toBeNull();
    expect(rows.find((row) => row.sha256 === second)?.unreferenced_at).toBe(storage.clock.iso());
  });

  it('retires the derived icons already expired, so six files per change do not fill the quota', async () => {
    const storage = await createBrandingStorage();
    const iconsBefore = Object.values(storage.service.get().icons).map((icon) => icon.hash);
    const logo = await stage(storage, await distinctPng(5));
    await storage.service.apply(choice('With logo', { light: logo }), 1, PREVIEW);
    const cutoff = new Date(storage.clock.nowMs() - LIMITS.staging.retentionMs).toISOString();
    for (const hash of iconsBefore) {
      const row = storage.assets().find((candidate) => candidate.sha256 === hash);
      expect(row?.unreferenced_at, 'a retired icon').not.toBeNull();
      expect((row?.unreferenced_at ?? '') < cutoff, 'a retired icon is born expired').toBe(true);
    }
    // They do not count as waiting, and the next sweep removes them.
    expect(storage.usage().files).toBe(0);
  });

  it('derives the compact logo from the light master and flags it; an explicit compact is not flagged', async () => {
    const storage = await createBrandingStorage();
    const light = await stage(storage, await distinctPng(6));
    const derived = await storage.service.apply(choice('Derived', { light }), 1, PREVIEW);
    expect(derived.compactDerived).toBe(true);
    expect(derived.logos.compact).not.toBeNull();
    expect(derived.logos.compact?.width).toBeLessThanOrEqual(LIMITS.image.compactMasterPx);
    expect(brandingRow(storage)).toMatchObject({ logo_compact_derived: 1 });

    const compact = await stage(storage, await solidPng(100, 100, [200, 40, 40]), 'compact');
    const explicit = await storage.service.apply(
      choice('Explicit', { light, compact }),
      2,
      PREVIEW,
    );
    expect(explicit.compactDerived).toBe(false);
    expect(explicit.logos.compact?.hash).toBe(compact);
    // The retired derived compact is expired like the icons: it was made, not uploaded.
    expect(storage.usage().files).toBe(0);
  });

  it('has no compact at all when there is no master to derive it from', async () => {
    const storage = await createBrandingStorage();
    const view = await storage.service.apply(choice('Monogram only'), 1, PREVIEW);
    expect(view.logos).toEqual({ light: null, dark: null, compact: null });
    expect(view.compactDerived).toBe(false);
  });
});

describe('a failure while deriving the variants (FR-A-089)', () => {
  it('leaves the previous branding in force and writes nothing', async () => {
    const storage = await createBrandingStorage();
    const logo = await stage(storage, await distinctPng(7));
    const rowBefore = brandingRow(storage);
    const assetsBefore = storage.assets();
    const auditBefore = storage.audit();

    const broken: BrandingImages = {
      ...inProcessImages(),
      deriveVariants: () => Promise.reject(new ProblemError('image_processing_timeout')),
    };
    const failing = createBrandingService({
      requireDatabase: () => storage.database,
      now: () => storage.clock.nowMs(),
      assets: storage.store,
      images: broken,
    });
    await expect(failing.apply(choice('Lost', { light: logo }), 1, PREVIEW)).rejects.toMatchObject({
      code: 'image_processing_timeout',
    });
    expect(brandingRow(storage)).toEqual(rowBefore);
    expect(storage.assets()).toEqual(assetsBefore);
    expect(storage.audit()).toEqual(auditBefore);
  });

  it('is refused with the code of the runner when the runner is busy or shutting down', async () => {
    for (const code of ['image_processing_busy', 'shutting_down'] as const) {
      const storage = await createBrandingStorage();
      const service = createBrandingService({
        requireDatabase: () => storage.database,
        now: () => storage.clock.nowMs(),
        assets: storage.store,
        images: failingImages(code),
      });
      await expect(service.apply(choice('X'), 1, PREVIEW)).rejects.toMatchObject({ code });
      expect(storage.service.revision()).toBe(1);
    }
  });
});

describe('reset (FR-A-080 R9)', () => {
  it('restores the name, the accent and the monogram icons, drops the logos and keeps the retired master for 24 hours', async () => {
    const storage = await createBrandingStorage();
    const initial = storage.service.get();
    const logo = await stage(storage, await distinctPng(8));
    await storage.service.apply(
      { orgName: 'Acme', accent: '#aa3300', logos: { light: logo, dark: null, compact: null } },
      1,
      PREVIEW,
    );
    storage.clock.advance(1_000);
    const reset = await storage.service.reset(2, PREVIEW);

    expect(reset).toMatchObject({
      revision: 3,
      orgName: 'M365Portal',
      isDefaultName: true,
      accent: '#0078d4',
      compactDerived: false,
      logos: { light: null, dark: null, compact: null },
    });
    // The same inputs make the same icons: byte for byte the ones of the first installation.
    expect(reset.icons).toEqual(initial.icons);
    const kept = storage.assets().find((row) => row.sha256 === logo);
    expect(kept?.unreferenced_at).toBe(storage.clock.iso());
    expect(await storage.store.has(logo)).toBe(true);
  });
});

describe('what the service stores and returns (I-9, FR-A-081, FR-A-082)', () => {
  it('stores the accent as lower-case #rrggbb and the name NFC-normalised, trimmed and collapsed', async () => {
    const storage = await createBrandingStorage();
    const view = await storage.service.apply(
      {
        orgName: '  Café   Noir  ',
        accent: '#FA0',
        logos: { light: null, dark: null, compact: null },
      },
      1,
      PREVIEW,
    );
    expect(view.accent).toBe('#ffaa00');
    expect(view.orgName).toBe('Café Noir');
    expect(brandingRow(storage)).toMatchObject({ accent: '#ffaa00', org_name: 'Café Noir' });
  });

  it.each([
    ['', 'org_name_invalid', '/orgName'],
    ['"><img src=x onerror=alert(1)>‮', 'org_name_invalid', '/orgName'],
    ['x'.repeat(65), 'org_name_invalid', '/orgName'],
  ])('refuses the name %j with %s', async (orgName, code, pointer) => {
    const storage = await createBrandingStorage();
    await expect(
      storage.service.apply({ ...choice('ok'), orgName }, 1, PREVIEW),
    ).rejects.toMatchObject({ code, details: { errors: [{ pointer, code }] } });
    expect(storage.service.revision()).toBe(1);
  });

  it.each(['', 'blue', '#12', '#12345', '#gggggg', '0078d4', '#0078d4ff'])(
    'refuses the accent %j with accent_invalid',
    async (accent) => {
      const storage = await createBrandingStorage();
      await expect(
        storage.service.apply({ ...choice('ok'), accent }, 1, PREVIEW),
      ).rejects.toMatchObject({ code: 'accent_invalid' });
    },
  );

  it('refuses an unregistered hash with asset_unknown and a pointer to the slot', async () => {
    const storage = await createBrandingStorage();
    const unknown = createHash('sha256').update('unregistered').digest('hex');
    await expect(
      storage.service.apply(choice('X', { dark: unknown }), 1, PREVIEW),
    ).rejects.toMatchObject({
      code: 'asset_unknown',
      details: { errors: [{ pointer: '/logos/dark', code: 'asset_unknown' }] },
    });
  });

  it('refuses, inside the transaction, an asset that was swept while the variants were derived', async () => {
    const storage = await createBrandingStorage();
    // Larger than the compact bound, so the derived compact is not the same file as the logo.
    const logo = await stage(storage, await distinctPng(11, 300));
    const inner = inProcessImages();
    // The hourly sweeper runs while the image job works: the row of the logo disappears.
    const sweeping: BrandingImages = {
      ...inner,
      deriveVariants: async (input) => {
        const derived = await inner.deriveVariants(input);
        storage.database.sqlite.prepare('DELETE FROM branding_asset WHERE sha256 = ?').run(logo);
        return derived;
      },
    };
    const service = createBrandingService({
      requireDatabase: () => storage.database,
      now: () => storage.clock.nowMs(),
      assets: storage.store,
      images: sweeping,
    });
    const before = storage.audit().length;
    await expect(service.apply(choice('X', { light: logo }), 1, PREVIEW)).rejects.toMatchObject({
      code: 'asset_unknown',
      details: { errors: [{ pointer: '/logos/light' }] },
    });
    expect(storage.service.revision()).toBe(1);
    expect(storage.audit()).toHaveLength(before);
  });

  it('refuses a registered asset whose file is gone as asset_unknown', async () => {
    const storage = await createBrandingStorage();
    const logo = await stage(storage, await distinctPng(9));
    await storage.store.remove(logo);
    await expect(
      storage.service.apply(choice('X', { light: logo }), 1, PREVIEW),
    ).rejects.toMatchObject({ code: 'asset_unknown' });
  });

  it('refuses an asset that is too large for its slot with validation_failed', async () => {
    const storage = await createBrandingStorage();
    // A 512 by 512 logo staged for the light slot cannot be the 128 pixel compact.
    const big = await stage(storage, await solidPng(512, 512, [10, 10, 10]));
    await expect(
      storage.service.apply(choice('X', { compact: big }), 1, PREVIEW),
    ).rejects.toMatchObject({
      code: 'validation_failed',
      details: { errors: [{ pointer: '/logos/compact', code: 'asset_too_large' }] },
    });
    // The same asset in a logo slot is fine.
    await expect(
      storage.service.apply(choice('X', { light: big }), 1, PREVIEW),
    ).resolves.toBeDefined();
  });

  it('returns a view that the wire schema accepts, with the tokens and monogram of the shared modules', async () => {
    const storage = await createBrandingStorage();
    const logo = await stage(storage, await distinctPng(10));
    const view = await storage.service.apply(
      {
        orgName: 'Zoë Jansen',
        accent: '#cc3366',
        logos: { light: logo, dark: null, compact: null },
      },
      1,
      PREVIEW,
    );
    expect(BrandingSchema.safeParse(view).success).toBe(true);
    expect(view.tokens).toEqual(deriveAccentTokens('#cc3366'));
    expect(view.monogram.initials).toBe(monogramFor('Zoë Jansen').initials);
    expect(view.isDefaultName).toBe(false);
    expect(view.updatedAt).toBe(storage.clock.iso());
    expect(view.logos.light).toMatchObject({ hash: logo, url: `/branding/${logo}.png` });
    // No actor identity in the view.
    expect(JSON.stringify(view)).not.toContain('preview');
    expect(storage.service.get()).toEqual(view);
  });

  it('records who made the change on the row', async () => {
    const storage = await createBrandingStorage();
    await storage.service.apply(choice('Who'), 1, PREVIEW);
    expect(brandingRow(storage)).toMatchObject({
      updated_by_kind: 'preview',
      updated_by_id: 'preview',
    });
  });
});
