// The branding service (T-A-085; FR-A-072 transaction, FR-A-083, FR-A-089; PD-12; invariants I-1, I-2,
// I-8, I-9; E-11): the default row, apply, reset, and the view of the applied branding.
//
// A plain object over the database, a clock, the asset store and an image runner, so the tests need
// no HTTP. It knows nothing of requests: the routes hand it the actor, the request id and the client
// address as data.
//
// The flow of an apply (plan section 11), in the order things happen:
//
//   1. normalise the name and the accent with the shared normalisers (the only ones, FR-A-008);
//   2. look at the revision against `If-Match` (a cheap early 412; the transaction decides);
//   3. load the masters the request names: each hash must be a registered asset with a file, and
//      small enough for its slot (512 for a logo, 128 for the compact);
//   4. derive the compact variant and the five icons in a worker job. A failure here leaves the
//      previous branding in force and writes nothing: no row, no flag, no audit entry;
//   5. write the derived files atomically and register them as unreferenced (a small transaction);
//   6. ONE `BEGIN IMMEDIATE` transaction: check the revision, update the single branding row, flip
//      `unreferenced_at` for the new and the retired assets, and append the audit entry (I-8).
//
// A race lost at step 6 is a 412 and leaves only unreferenced assets, which the sweeper removes after
// 24 hours. The revision moves by exactly one per accepted change, in one statement (I-2).
//
// The first row is made by the same code (`ensureDefault`), with the actor `system` and the audit
// action `branding.init` (PD-12), so the audit chain of a fresh volume has exactly one entry.
import { deriveAccentTokens } from '@m365portal/shared/branding/accent';
import { monogramFor } from '@m365portal/shared/branding/monogram';
import { isDefaultName, tryNormalizeOrgName } from '@m365portal/shared/branding/org-name';
import { tryNormalizeAccent } from '@m365portal/shared/branding/accent';
import { LIMITS } from '@m365portal/shared/limits';
import type { AssetRef, Branding } from '@m365portal/shared/schemas/branding';
import { brandingAssetUrl } from '@m365portal/shared/schemas/branding';
import { appendAudit, type AuditDetail } from '../audit/index.js';
import { withTransaction, type DatabaseHandle } from '../db/index.js';
import { ProblemError } from '../http/problem.js';
import { AssetFileMissingError, type AssetMetadata, type AssetStore } from './asset-store.js';
import { DEFAULT_BRANDING, SYSTEM_ACTOR, type BrandingChoice } from './defaults.js';
import type { IconKind } from './pipeline/job-protocol.js';
import type { ImageJobRunner } from './pipeline/job-runner.js';
import {
  findAssets,
  insertBranding,
  markReferenced,
  markUnreferenced,
  readBranding,
  replaceBranding,
  roleHashesOf,
  type AssetRole,
  type AssetRow,
  type BrandingRow,
} from './repository.js';

/** Who made a change, for the row (`updated_by_*`) and for the audit entry. */
export interface ChangeContext {
  readonly actor: { readonly kind: 'anonymous' | 'preview' | 'system'; readonly id: string };
  readonly requestId?: string;
  /** The client address; personal data, so it goes to the audit entry and nowhere else. */
  readonly clientIp?: string;
}

export interface BrandingServiceDependencies {
  /** The open database, or a thrown 503 `storage_unavailable` (`ModuleDeps.requireDatabase`). */
  readonly requireDatabase: () => DatabaseHandle;
  /** Milliseconds since the epoch. */
  readonly now: () => number;
  readonly assets: AssetStore;
  readonly images: Pick<ImageJobRunner, 'deriveVariants'>;
}

/** What differs when an apply is an import: the audit action and the detail it adds. */
export interface ApplyOptions {
  readonly action?: 'branding.apply' | 'branding.import';
  /** Added to the detail of the audit entry (`dryRun`, `schemaVersion`): flat, allowed keys only. */
  readonly detail?: AuditDetail;
}

export interface BrandingService {
  /** Create the first branding row if there is none. Returns whether this call created it. */
  ensureDefault(): Promise<{ readonly created: boolean }>;
  /** The applied branding, as `GET /api/v1/branding` returns it. */
  get(): Branding;
  /** The revision of the applied branding. */
  revision(): number;
  /**
   * Replace the whole branding. `expectedRevision` is the value of `If-Match`. `options` lets the
   * import (T-A-088) write its own audit action, `branding.import`, with its extra detail, in the
   * same transaction.
   */
  apply(
    choice: BrandingChoice,
    expectedRevision: number,
    context: ChangeContext,
    options?: ApplyOptions,
  ): Promise<Branding>;
  /** Restore the defaults: name, accent, monogram icons, no logos. */
  reset(expectedRevision: number, context: ChangeContext): Promise<Branding>;
}

/** The logo slots, their property in the request and the largest edge each takes. */
const LOGO_SLOTS = [
  { slot: 'light', role: 'logoLight', bound: LIMITS.image.logoMasterPx },
  { slot: 'dark', role: 'logoDark', bound: LIMITS.image.logoMasterPx },
  { slot: 'compact', role: 'logoCompact', bound: LIMITS.image.compactMasterPx },
] as const;

const ICON_ROLES: Readonly<Record<IconKind, AssetRole>> = {
  favicon32: 'iconFavicon32',
  appleTouch180: 'iconApple180',
  pwa192: 'iconPwa192',
  pwa512: 'iconPwa512',
  maskable512: 'iconMaskable512',
};

type Hashes = Record<AssetRole, string | null>;

type ChangeAction = 'branding.init' | 'branding.apply' | 'branding.import' | 'branding.reset';

interface Change {
  readonly action: ChangeAction;
  /** `null` for the first row. */
  readonly expectedRevision: number | null;
  readonly orgName: string;
  readonly accent: string;
  readonly hashes: Hashes;
  readonly compactDerived: boolean;
  readonly context: ChangeContext;
  /** Extra audit detail (an import's `dryRun` and `schemaVersion`). */
  readonly extraDetail?: AuditDetail;
}

function fieldProblem(code: 'org_name_invalid' | 'accent_invalid', pointer: string): ProblemError {
  return new ProblemError(code, { errors: [{ pointer, code }] });
}

/** A hash the service derived itself: a missing one is a bug, not a request problem. */
function derived(hash: string | null): string {
  if (hash === null) throw new Error('a derived variant is missing');
  return hash;
}

function assetProblem(pointer: string): ProblemError {
  return new ProblemError('asset_unknown', { errors: [{ pointer, code: 'asset_unknown' }] });
}

function assetRefOf(row: AssetRow): AssetRef {
  return {
    hash: row.sha256,
    url: brandingAssetUrl(row.sha256),
    width: row.width,
    height: row.height,
    luminance: row.luminance,
  };
}

/** The wire view of a branding row. Every referenced asset must be among `assets`. */
export function brandingView(row: BrandingRow, assets: ReadonlyMap<string, AssetRow>): Branding {
  const logo = (hash: string | null): AssetRef | null => {
    if (hash === null) return null;
    const asset = assets.get(hash);
    if (asset === undefined) throw new Error('a referenced asset has no registry row');
    return assetRefOf(asset);
  };
  const icon = (hash: string): { hash: string; url: string } => ({
    hash,
    url: brandingAssetUrl(hash),
  });
  const monogram = monogramFor(row.orgName);
  return {
    revision: row.revision,
    orgName: row.orgName,
    isDefaultName: isDefaultName(row.orgName),
    accent: row.accent,
    tokens: deriveAccentTokens(row.accent),
    logos: {
      light: logo(row.logoLight),
      dark: logo(row.logoDark),
      compact: logo(row.logoCompact),
    },
    compactDerived: row.logoCompactDerived === 1,
    icons: {
      favicon32: icon(row.iconFavicon32),
      appleTouch180: icon(row.iconApple180),
      pwa192: icon(row.iconPwa192),
      pwa512: icon(row.iconPwa512),
      maskable512: icon(row.iconMaskable512),
    },
    monogram: { ...monogram, glyphs: [...monogram.glyphs] },
    updatedAt: row.updatedAt,
  };
}

/** The view of the row that is applied now, read through `db` (a handle or an open transaction). */
function viewOf(db: DatabaseHandle): Branding {
  const row = readBranding(db);
  if (row === undefined) throw new Error('the branding row does not exist');
  const hashes = Object.values(roleHashesOf(row));
  return brandingView(row, findAssets(db, hashes));
}

export function createBrandingService(dependencies: BrandingServiceDependencies): BrandingService {
  const { assets, images, now } = dependencies;
  const iso = (): string => new Date(now()).toISOString();

  /** Normalise with the shared normalisers; the failure is the problem of the request. */
  function normalise(choice: BrandingChoice): { orgName: string; accent: string } {
    const orgName = tryNormalizeOrgName(choice.orgName);
    if (orgName === null) throw fieldProblem('org_name_invalid', '/orgName');
    const accent = tryNormalizeAccent(choice.accent);
    if (accent === null) throw fieldProblem('accent_invalid', '/accent');
    return { orgName, accent };
  }

  /**
   * Step 3: the masters of the choice. A hash that is not registered, or whose file is gone, is
   * `asset_unknown`; one that is too large for its slot is `validation_failed`.
   */
  async function loadMasters(
    db: DatabaseHandle,
    logos: BrandingChoice['logos'],
  ): Promise<Record<'light' | 'dark' | 'compact', Buffer | null>> {
    const chosen = LOGO_SLOTS.flatMap((entry) => {
      const hash = logos[entry.slot];
      return hash === null ? [] : [{ ...entry, hash }];
    });
    const found = findAssets(
      db,
      chosen.map(({ hash }) => hash),
    );
    const masters: Record<'light' | 'dark' | 'compact', Buffer | null> = {
      light: null,
      dark: null,
      compact: null,
    };
    for (const { slot, bound, hash } of chosen) {
      const asset = found.get(hash);
      if (asset === undefined) throw assetProblem(`/logos/${slot}`);
      if (asset.width > bound || asset.height > bound) {
        throw new ProblemError('validation_failed', {
          errors: [{ pointer: `/logos/${slot}`, code: 'asset_too_large' }],
        });
      }
      try {
        masters[slot] = await assets.read(hash);
      } catch (error) {
        if (error instanceof AssetFileMissingError) throw assetProblem(`/logos/${slot}`);
        throw error;
      }
    }
    return masters;
  }

  /** Steps 4 and 5: derive, write the files, register them as unreferenced. */
  async function deriveAndStore(
    db: DatabaseHandle,
    orgName: string,
    accent: string,
    masters: Record<'light' | 'dark' | 'compact', Buffer | null>,
  ): Promise<{
    readonly icons: Record<IconKind, string>;
    readonly compact: string | null;
  }> {
    const derived = await images.deriveVariants({ orgName, accent, ...masters });

    const written: { metadata: AssetMetadata }[] = [];
    const store = async (
      png: Buffer,
      width: number,
      height: number,
      luminance: number | null,
    ): Promise<string> => {
      const sha256 = await assets.write(png);
      written.push({ metadata: { sha256, bytes: png.length, width, height, luminance } });
      return sha256;
    };

    const icons = {} as Record<IconKind, string>;
    for (const kind of Object.keys(ICON_ROLES) as IconKind[]) {
      const icon = derived.icons[kind];
      icons[kind] = await store(icon.png, icon.width, icon.height, null);
    }
    const compact =
      derived.compact === null
        ? null
        : await store(
            derived.compact.png,
            derived.compact.width,
            derived.compact.height,
            derived.compact.luminance,
          );
    withTransaction(db, (tx) => {
      for (const { metadata } of written) assets.registerDerived(tx, metadata);
    });
    return { icons, compact };
  }

  /** Step 6 (and the whole of the first row): the transaction. */
  function commit(db: DatabaseHandle, change: Change): Branding | null {
    return withTransaction(db, (tx) => {
      const current = readBranding(tx);
      const timestamp = iso();
      const { context } = change;

      if (change.expectedRevision === null) {
        if (current !== undefined) return null;
      } else if (current === undefined) {
        throw new Error('the branding row does not exist');
      } else if (current.revision !== change.expectedRevision) {
        throw new ProblemError('branding_conflict');
      }

      // The hashes may have been swept since step 3: a reference to a missing row is refused here, in
      // the transaction, and not left to the foreign key.
      const wanted = Object.values(change.hashes).filter((hash): hash is string => hash !== null);
      const found = findAssets(tx, wanted);
      for (const { slot, role } of LOGO_SLOTS) {
        const hash = change.hashes[role];
        if (hash !== null && !found.has(hash)) throw assetProblem(`/logos/${slot}`);
      }
      if (wanted.some((hash) => !found.has(hash))) {
        throw new Error('a derived variant has no registry row');
      }

      const values = {
        orgName: change.orgName,
        accent: change.accent,
        logoLight: change.hashes.logoLight,
        logoDark: change.hashes.logoDark,
        logoCompact: change.hashes.logoCompact,
        logoCompactDerived: change.compactDerived ? 1 : 0,
        iconFavicon32: derived(change.hashes.iconFavicon32),
        iconApple180: derived(change.hashes.iconApple180),
        iconPwa192: derived(change.hashes.iconPwa192),
        iconPwa512: derived(change.hashes.iconPwa512),
        iconMaskable512: derived(change.hashes.iconMaskable512),
        updatedAt: timestamp,
        updatedByKind: context.actor.kind,
        updatedById: context.actor.id,
      };

      if (current === undefined) {
        insertBranding(tx, { ...values, revision: 1 });
      } else if (!replaceBranding(tx, current.revision, values)) {
        throw new ProblemError('branding_conflict');
      }

      // I-3: what the applied branding references is referenced. What it stopped referencing keeps 24
      // hours, so that Undo can still apply the previous values: that is true of the masters the
      // administrator uploaded. The variants the server derived (the icons, a derived compact) are
      // made again from the masters by every apply, so Undo does not need them: they are retired
      // already expired, and the hourly sweeper removes them. Otherwise six retired files per apply
      // would fill the staging quota of 32 within a handful of changes.
      const before = current === undefined ? {} : roleHashesOf(current);
      const derivedRoles: AssetRole[] = [
        'iconFavicon32',
        'iconApple180',
        'iconPwa192',
        'iconPwa512',
        'iconMaskable512',
        ...(current?.logoCompactDerived === 1 ? (['logoCompact'] as const) : []),
      ];
      const retiredHashes = (roles: readonly AssetRole[]): string[] =>
        roles.flatMap((role) => {
          const hash = before[role];
          return hash === undefined || wanted.includes(hash) ? [] : [hash];
        });
      const retiredDerived = retiredHashes(derivedRoles);
      const retiredMasters = retiredHashes(
        (Object.keys(before) as AssetRole[]).filter((role) => !derivedRoles.includes(role)),
      );
      markReferenced(tx, wanted);
      markUnreferenced(tx, retiredMasters, timestamp);
      markUnreferenced(
        tx,
        retiredDerived.filter((hash) => !retiredMasters.includes(hash)),
        new Date(now() - LIMITS.staging.retentionMs - 1).toISOString(),
      );

      const toRevision = (current?.revision ?? 0) + 1;
      appendAudit(tx, {
        ts: timestamp,
        actorKind: context.actor.kind,
        actorId: context.actor.id,
        action: change.action,
        targetType: 'branding',
        targetId: '1',
        outcome: 'success',
        ...(context.clientIp === undefined ? {} : { clientIp: context.clientIp }),
        ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
        detail: auditDetailOf(change, current, toRevision),
      });
      return viewOf(tx);
    });
  }

  async function change(
    action: 'branding.apply' | 'branding.import' | 'branding.reset',
    choice: BrandingChoice,
    expectedRevision: number,
    context: ChangeContext,
    extraDetail?: AuditDetail,
  ): Promise<Branding> {
    const db = dependencies.requireDatabase();
    const { orgName, accent } = normalise(choice);

    const current = readBranding(db);
    if (current === undefined) throw new Error('the branding row does not exist');
    if (current.revision !== expectedRevision) throw new ProblemError('branding_conflict');

    const masters = await loadMasters(db, choice.logos);
    const variants = await deriveAndStore(db, orgName, accent, masters);

    const hashes: Hashes = {
      logoLight: choice.logos.light,
      logoDark: choice.logos.dark,
      logoCompact: choice.logos.compact ?? variants.compact,
      iconFavicon32: variants.icons.favicon32,
      iconApple180: variants.icons.appleTouch180,
      iconPwa192: variants.icons.pwa192,
      iconPwa512: variants.icons.pwa512,
      iconMaskable512: variants.icons.maskable512,
    };
    const result = commit(db, {
      action,
      expectedRevision,
      orgName,
      accent,
      hashes,
      compactDerived: choice.logos.compact === null && variants.compact !== null,
      context,
      ...(extraDetail === undefined ? {} : { extraDetail }),
    });
    if (result === null) throw new Error('an update produced no branding');
    return result;
  }

  return {
    async ensureDefault() {
      const db = dependencies.requireDatabase();
      if (readBranding(db) !== undefined) return { created: false };
      const { orgName, accent } = normalise(DEFAULT_BRANDING);
      const variants = await deriveAndStore(db, orgName, accent, {
        light: null,
        dark: null,
        compact: null,
      });
      const created = commit(db, {
        action: 'branding.init',
        expectedRevision: null,
        orgName,
        accent,
        hashes: {
          logoLight: null,
          logoDark: null,
          logoCompact: null,
          iconFavicon32: variants.icons.favicon32,
          iconApple180: variants.icons.appleTouch180,
          iconPwa192: variants.icons.pwa192,
          iconPwa512: variants.icons.pwa512,
          iconMaskable512: variants.icons.maskable512,
        },
        compactDerived: false,
        context: { actor: SYSTEM_ACTOR },
      });
      return { created: created !== null };
    },

    get: () => viewOf(dependencies.requireDatabase()),

    revision() {
      const row = readBranding(dependencies.requireDatabase());
      if (row === undefined) throw new Error('the branding row does not exist');
      return row.revision;
    },

    apply: (choice, expectedRevision, context, options = {}) =>
      change(options.action ?? 'branding.apply', choice, expectedRevision, context, options.detail),

    reset: (expectedRevision, context) =>
      change('branding.reset', DEFAULT_BRANDING, expectedRevision, context),
  };
}

/** The audit detail of data-model 7.4: revisions, old and new name and accent, hashes, never bytes. */
function auditDetailOf(
  change: Change,
  current: BrandingRow | undefined,
  toRevision: number,
): AuditDetail {
  if (change.action === 'branding.init') return { revision: toRevision };
  if (change.action === 'branding.reset') {
    return { fromRevision: current?.revision ?? 0, toRevision };
  }
  const hashes = change.hashes;
  return {
    ...change.extraDetail,
    fromRevision: current?.revision ?? 0,
    toRevision,
    orgNameOld: current?.orgName,
    orgNameNew: change.orgName,
    accentOld: current?.accent,
    accentNew: change.accent,
    logoLight: hashes.logoLight ?? undefined,
    logoDark: hashes.logoDark ?? undefined,
    logoCompact: hashes.logoCompact ?? undefined,
    iconFavicon32: hashes.iconFavicon32 ?? undefined,
    iconApple180: hashes.iconApple180 ?? undefined,
    iconPwa192: hashes.iconPwa192 ?? undefined,
    iconPwa512: hashes.iconPwa512 ?? undefined,
    iconMaskable512: hashes.iconMaskable512 ?? undefined,
  };
}
