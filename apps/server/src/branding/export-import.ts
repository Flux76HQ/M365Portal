// Branding export and import (T-A-088; FR-A-093, FR-A-044 audited GET; R10 and R11; E-22; H-42).
//
// EXPORT builds the document of FR-A-093 from the applied branding: `{ schemaVersion: 1, orgName,
// accent, images: { logoLight, logoDark, compact } }`, each image the base64 of the stored master PNG.
// A compact logo the server derived itself is not exported (it is made again on import), so the export
// holds exactly what an administrator uploaded. The export is an audited read: `branding.export`.
//
// IMPORT treats the document as hostile input, in this order, and stops at the first refusal:
//
//   1. `scanImportJson`: a small iterative scanner of our own that refuses a repeated key (decoded, so
//      `"a"` is `"a"`), the keys `__proto__`, `constructor` and `prototype`, and a nesting depth
//      over 8, BEFORE anything is built; `JSON.parse` cannot see a repeated key and a recursive
//      parser would overflow its stack at depth 10,000. The document itself is three levels deep.
//   2. `JSON.parse`, then the version: a number of 2 or more, or a text, is `import_unsupported_version`.
//   3. the strict shared `BrandingExportSchema` (unknown keys, canonical base64, the name and accent
//      rules of `PUT`): any fault is `import_invalid` with a JSON pointer for each.
//   4. EVERY image through the complete pipeline of the upload (`images.process`, a child process):
//      sniff by the bytes, sanitise, rasterise, re-encode. The document says nothing about media
//      types; the bytes decide, so a "PNG" that is a script is refused like an upload would be. All
//      three are processed before anything is written.
//   5. a dry run stops here and stores nothing. Otherwise the processed files are written and
//      registered as staged assets, and the branding is applied through the same service as `PUT`,
//      in one transaction with its audit entry (`branding.import`, `dryRun: false`).
//
// Nothing is applied unless every step passed: a refusal in steps 1 to 4 leaves no file and no row.
// The only thing a refused import writes is its `rejected` audit entry; a lost race (412) leaves the
// staged images unreferenced for the sweeper, exactly like an apply that lost.
import { tryNormalizeAccent } from '@m365portal/shared/branding/accent';
import { tryNormalizeOrgName } from '@m365portal/shared/branding/org-name';
import type { ProblemCode } from '@m365portal/shared/problem';
import type { AssetSlot } from '@m365portal/shared/schemas/assets';
import {
  BrandingExportSchema,
  type BrandingExport,
  type ImportResult,
  type ImportedImageSummary,
} from '@m365portal/shared/schemas/export-import';
import { appendAudit, type AuditDetail } from '../audit/index.js';
import { withTransaction, type DatabaseHandle } from '../db/index.js';
import { ProblemError, validationProblemParts } from '../http/problem.js';
import { sha256Hex, type AssetMetadata, type AssetStore } from './asset-store.js';
import type { ImageJobRunner } from './pipeline/job-runner.js';
import type { BrandingService, ChangeContext } from './service.js';

/** The document is three levels deep (document, `images`, a member); a little room, no more. */
export const MAX_IMPORT_DEPTH = 8;

/** Keys no import document may carry, whatever the schema says about unknown keys. */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

export type ScanFailure = 'duplicate_key' | 'forbidden_key' | 'too_deep';

/**
 * Look for what `JSON.parse` cannot tell: a key that occurs twice in one object, a forbidden key, a
 * document nested deeper than `MAX_IMPORT_DEPTH`. Iterative, one pass, no recursion and no copy of the
 * text, so it costs time proportional to the length and cannot overflow the stack at any depth. It
 * does not validate the JSON (`JSON.parse` does, afterwards): on text that is not JSON it may say
 * nothing, and that is fine.
 */
export function scanImportJson(text: string): ScanFailure | null {
  // One entry per open container: the keys seen so far for an object, `null` for an array.
  const frames: (Set<string> | null)[] = [];
  let expectKey = false;
  let index = 0;
  const length = text.length;

  while (index < length) {
    const code = text.charCodeAt(index);
    if (code === 0x7b /* { */ || code === 0x5b /* [ */) {
      if (frames.length >= MAX_IMPORT_DEPTH) return 'too_deep';
      frames.push(code === 0x7b ? new Set<string>() : null);
      expectKey = code === 0x7b;
      index += 1;
    } else if (code === 0x7d /* } */ || code === 0x5d /* ] */) {
      frames.pop();
      expectKey = false;
      index += 1;
    } else if (code === 0x2c /* , */) {
      expectKey = frames[frames.length - 1] instanceof Set;
      index += 1;
    } else if (code === 0x3a /* : */) {
      expectKey = false;
      index += 1;
    } else if (code === 0x22 /* " */) {
      let end = index + 1;
      let escaped = false;
      while (end < length) {
        const character = text.charCodeAt(end);
        if (character === 0x5c /* \ */) {
          escaped = true;
          end += 2;
        } else if (character === 0x22) {
          break;
        } else {
          end += 1;
        }
      }
      if (end >= length) return null; // unterminated: JSON.parse refuses it
      const keys = frames[frames.length - 1];
      if (keys instanceof Set && expectKey) {
        let key: string;
        if (escaped) {
          try {
            key = JSON.parse(text.slice(index, end + 1)) as string;
          } catch {
            return null; // a bad escape: JSON.parse refuses it
          }
        } else {
          key = text.slice(index + 1, end);
        }
        if (FORBIDDEN_KEYS.has(key)) return 'forbidden_key';
        if (keys.has(key)) return 'duplicate_key';
        keys.add(key);
        expectKey = false;
      }
      index = end + 1;
    } else {
      index += 1;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------

export interface BrandingTransferDeps {
  /** The open database, or a thrown 503 `storage_unavailable`. */
  readonly requireDatabase: () => DatabaseHandle;
  /** Milliseconds since the epoch. */
  readonly now: () => number;
  readonly assets: Pick<AssetStore, 'read' | 'write' | 'fitsQuota' | 'registerStaged'>;
  readonly images: Pick<ImageJobRunner, 'process'>;
  readonly service: Pick<BrandingService, 'get' | 'apply'>;
}

export interface ImportInput {
  /** The request body, as received: decoded as UTF-8 here, strictly, with no byte order mark. */
  readonly body: Uint8Array;
  readonly dryRun: boolean;
  /** The revision of `If-Match`; ignored for a dry run. */
  readonly expectedRevision: number | null;
  readonly context: ChangeContext;
}

export interface ExportedFile {
  readonly document: BrandingExport;
  /** The JSON text that is sent; its length is what the audit entry records. */
  readonly text: string;
  readonly fileName: string;
}

export interface BrandingTransfer {
  exportDocument(context: ChangeContext): Promise<ExportedFile>;
  importDocument(input: ImportInput): Promise<ImportResult>;
}

const IMAGE_MEMBERS = [
  { member: 'logoLight', slot: 'logoLight', detailKey: 'logoLight' },
  { member: 'logoDark', slot: 'logoDark', detailKey: 'logoDark' },
  { member: 'compact', slot: 'compact', detailKey: 'compact' },
] as const satisfies readonly {
  member: keyof BrandingExport['images'];
  slot: AssetSlot;
  detailKey: 'logoLight' | 'logoDark' | 'compact';
}[];

type ImageMember = (typeof IMAGE_MEMBERS)[number]['member'];

/** The refusals of an import that are audited as `rejected`: the document was judged and turned away. */
function isAuditedRejection(code: ProblemCode): boolean {
  return (
    code === 'import_invalid' ||
    code === 'import_unsupported_version' ||
    code === 'staging_quota_exceeded' ||
    code === 'image_type_unsupported' ||
    code === 'image_empty' ||
    code === 'image_corrupt' ||
    code === 'image_pixels_exceeded' ||
    code === 'image_processing_timeout' ||
    code.startsWith('svg_')
  );
}

function invalid(pointer: string, code: string): ProblemError {
  return new ProblemError('import_invalid', { errors: [{ pointer, code }] });
}

/** `YYYYMMDD` of the UTC date. */
function compactDate(milliseconds: number): string {
  return new Date(milliseconds).toISOString().slice(0, 10).replaceAll('-', '');
}

export function createBrandingTransfer(deps: BrandingTransferDeps): BrandingTransfer {
  const { assets, images, service } = deps;
  const iso = (): string => new Date(deps.now()).toISOString();

  function audit(
    db: DatabaseHandle,
    context: ChangeContext,
    entry: {
      readonly action: 'branding.export' | 'branding.import';
      readonly outcome: 'success' | 'rejected';
      readonly reasonCode?: ProblemCode;
      readonly detail: AuditDetail;
    },
  ): void {
    withTransaction(db, (tx) =>
      appendAudit(tx, {
        ts: iso(),
        actorKind: context.actor.kind,
        actorId: context.actor.id,
        action: entry.action,
        targetType: 'branding',
        targetId: '1',
        outcome: entry.outcome,
        ...(entry.reasonCode === undefined ? {} : { reasonCode: entry.reasonCode }),
        ...(context.clientIp === undefined ? {} : { clientIp: context.clientIp }),
        ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
        detail: entry.detail,
      }),
    );
  }

  async function exportDocument(context: ChangeContext): Promise<ExportedFile> {
    const db = deps.requireDatabase();
    const branding = service.get();
    const master = async (hash: string | undefined): Promise<string | null> =>
      hash === undefined ? null : (await assets.read(hash)).toString('base64');
    const document: BrandingExport = {
      schemaVersion: 1,
      orgName: branding.orgName,
      accent: branding.accent,
      images: {
        logoLight: await master(branding.logos.light?.hash),
        logoDark: await master(branding.logos.dark?.hash),
        // The explicit compact only: a derived one is made again on import.
        compact: branding.compactDerived ? null : await master(branding.logos.compact?.hash),
      },
    };
    const text = JSON.stringify(document);
    audit(db, context, {
      action: 'branding.export',
      outcome: 'success',
      detail: { schemaVersion: 1, bytes: Buffer.byteLength(text) },
    });
    return { document, text, fileName: `m365portal-branding-${compactDate(deps.now())}.json` };
  }

  /** Steps 1 to 3: the bytes to a validated document. */
  function readDocument(body: Uint8Array): { document: BrandingExport; schemaVersion: number } {
    let text: string;
    try {
      // Strict: a byte that is not UTF-8 is a refusal (not a replacement character), and a byte order
      // mark stays in the text, where JSON.parse refuses it.
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
    } catch {
      throw invalid('', 'not_utf8');
    }
    const scanned = scanImportJson(text);
    if (scanned !== null) throw invalid('', scanned);

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw invalid('', 'not_json');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw invalid('', 'invalid_type');
    }
    const version = (parsed as Record<string, unknown>).schemaVersion;
    if (
      typeof version === 'string' ||
      (typeof version === 'number' && Number.isInteger(version) && version >= 2)
    ) {
      throw new ProblemError('import_unsupported_version', {
        errors: [{ pointer: '/schemaVersion', code: 'import_unsupported_version' }],
      });
    }

    const checked = BrandingExportSchema.safeParse(parsed);
    if (!checked.success) {
      const { errors } = validationProblemParts({ target: 'json', error: checked.error });
      throw new ProblemError('import_invalid', { errors });
    }
    return { document: checked.data, schemaVersion: checked.data.schemaVersion };
  }

  /** Step 4: every image through the complete pipeline, in order, before anything is stored. */
  async function processImages(document: BrandingExport) {
    const processed: Partial<Record<ImageMember, Awaited<ReturnType<typeof images.process>>>> = {};
    for (const { member, slot } of IMAGE_MEMBERS) {
      const encoded = document.images[member];
      if (encoded === null) continue;
      try {
        processed[member] = await images.process({ bytes: Buffer.from(encoded, 'base64'), slot });
      } catch (error) {
        if (error instanceof ProblemError) {
          throw new ProblemError(error.code, {
            ...error.details,
            errors: [{ pointer: `/images/${member}`, code: error.code }],
          });
        }
        throw error;
      }
    }
    return processed;
  }

  async function importDocument(input: ImportInput): Promise<ImportResult> {
    const db = deps.requireDatabase();
    const { context, dryRun } = input;
    let schemaVersion: number | undefined;
    try {
      const read = readDocument(input.body);
      schemaVersion = read.schemaVersion;
      const { document } = read;
      const orgName = tryNormalizeOrgName(document.orgName);
      const accent = tryNormalizeAccent(document.accent);
      if (orgName === null) throw invalid('/orgName', 'org_name_invalid');
      if (accent === null) throw invalid('/accent', 'accent_invalid');

      const processed = await processImages(document);
      const summary = (member: ImageMember): ImportedImageSummary | null => {
        const image = processed[member];
        if (image === undefined) return null;
        return {
          hash: sha256Hex(image.png),
          width: image.width,
          height: image.height,
          bytes: image.png.length,
          warnings: [...image.warnings],
        };
      };
      const summaries = {
        logoLight: summary('logoLight'),
        logoDark: summary('logoDark'),
        compact: summary('compact'),
      };
      const hashes = Object.fromEntries(
        IMAGE_MEMBERS.flatMap(({ member, detailKey }) => {
          const hash = summaries[member]?.hash;
          return hash === undefined ? [] : [[detailKey, hash] as const];
        }),
      ) as Pick<AuditDetail, 'logoLight' | 'logoDark' | 'compact'>;

      if (dryRun) {
        audit(db, context, {
          action: 'branding.import',
          outcome: 'success',
          detail: { dryRun: true, schemaVersion, bytes: input.body.length, ...hashes },
        });
        return { dryRun: true, applied: false, orgName, accent, images: summaries, branding: null };
      }

      if (input.expectedRevision === null) throw new ProblemError('precondition_required');

      // Stage what the pipeline made. The quota is asked before any file is written, so a refusal
      // leaves nothing behind; the registration under the write lock is the check that counts.
      const staged: { readonly member: ImageMember; readonly metadata: AssetMetadata }[] = [];
      for (const { member } of IMAGE_MEMBERS) {
        const image = processed[member];
        if (image === undefined) continue;
        const metadata: AssetMetadata = {
          sha256: sha256Hex(image.png),
          bytes: image.png.length,
          width: image.width,
          height: image.height,
          luminance: image.luminance,
        };
        if (!assets.fitsQuota(db, metadata)) throw new ProblemError('staging_quota_exceeded');
        staged.push({ member, metadata });
      }
      for (const { member } of staged) {
        const image = processed[member];
        if (image !== undefined) await assets.write(image.png);
      }
      withTransaction(db, (tx) => {
        for (const { metadata } of staged) assets.registerStaged(tx, metadata);
      });

      const branding = await service.apply(
        {
          orgName,
          accent,
          logos: {
            light: summaries.logoLight?.hash ?? null,
            dark: summaries.logoDark?.hash ?? null,
            compact: summaries.compact?.hash ?? null,
          },
        },
        input.expectedRevision,
        context,
        {
          action: 'branding.import',
          detail: { dryRun: false, schemaVersion, bytes: input.body.length },
        },
      );
      return { dryRun: false, applied: true, orgName, accent, images: summaries, branding };
    } catch (error) {
      if (error instanceof ProblemError && isAuditedRejection(error.code)) {
        audit(db, context, {
          action: 'branding.import',
          outcome: 'rejected',
          reasonCode: error.code,
          detail: {
            dryRun,
            bytes: input.body.length,
            ...(schemaVersion === undefined ? {} : { schemaVersion }),
          },
        });
      }
      throw error;
    }
  }

  return { exportDocument, importDocument };
}
