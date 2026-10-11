// The upload route (T-A-086; FR-A-080 R7, FR-A-084, FR-A-085 over HTTP; PD-07; E-02; H-35 to H-38):
//
//   R7 POST /api/v1/branding/assets?slot=logoLight|logoDark|compact
//      `settings:branding`, rate class upload, audit action `branding.asset.stage`
//
// What the route wrapper has already done when the handler runs: the `upload` bucket, the cap of
// 2,162,688 bytes on the request body while it streamed (with or without `Content-Length`; the body
// is now in memory), the multipart content type, Origin, CSRF, the permission and the query.
//
// What this handler does, in the order of plan 8.5:
//   3. parse the body: exactly one part named `file`, a file of at most 2,097,152 bytes (413 once the
//      part is parsed: a file one byte over still fits inside the request cap). The client's file
//      name and the part's media type are never read, and a source-scan test (`upload-pipeline`)
//      fails when this file reads either;
//   5. hand the bytes to the image runner (a child process): sniff, sanitise, rasterise, re-encode;
//   4/9. quota, then the atomic write, then the registry upsert and the audit entry in ONE
//      transaction. Nothing is written to disk before the pipeline accepted the bytes, and a refused
//      upload (quota) writes no file.
//
// The audit trail: a success is `success`; an upload the pipeline or the size rule refused, or the
// quota refused, is `rejected` with the stable problem code. Not audited: a request that is not an
// upload at all (not multipart, not exactly one `file` part: 422), a busy runner (429), shutdown
// (503) and storage failures: no decision was taken about a file.
import type { RouteConfig } from '@hono/zod-openapi';
import { LIMITS } from '@m365portal/shared/limits';
import type { ProblemCode } from '@m365portal/shared/problem';
import {
  UploadAssetQuerySchema,
  UploadAssetResponseSchema,
  type AssetSlot,
  type UploadAssetResponse,
} from '@m365portal/shared/schemas/assets';
import { brandingAssetUrl } from '@m365portal/shared/schemas/branding';
import { appendAudit } from '../../audit/index.js';
import { withTransaction, type DatabaseHandle } from '../../db/index.js';
import { describeProblem, ProblemError, requestIdOf } from '../../http/problem.js';
import { defineRoute, type RouteContext, type RouteDefinition } from '../../http/route.js';
import { sha256Hex, type AssetStore } from '../asset-store.js';
import type { ImageJobRunner } from '../pipeline/job-runner.js';
import { PROBLEM_ANSWERS } from './request-support.js';

export interface AssetsUploadDeps {
  /** The open database, or a thrown 503 `storage_unavailable`. */
  readonly requireDatabase: () => DatabaseHandle;
  /** Milliseconds since the epoch. */
  readonly now: () => number;
  readonly assets: AssetStore;
  readonly images: Pick<ImageJobRunner, 'process'>;
  /** True from the moment shutdown begins: the upload then ends with 503 `shutting_down`. */
  readonly isShuttingDown: () => boolean;
}

/** The refusals of an upload that are audited as `rejected`: the file was judged and turned away. */
const AUDITED_REJECTIONS: ReadonlySet<ProblemCode> = new Set([
  'payload_too_large',
  'image_type_unsupported',
  'image_empty',
  'image_corrupt',
  'image_pixels_exceeded',
  'image_processing_timeout',
  'svg_not_wellformed',
  'svg_doctype_forbidden',
  'svg_text_unsupported',
  'svg_too_complex',
  'staging_quota_exceeded',
]);

/** The multipart upload as OpenAPI documents it; not validated by the wrapper, parsed below. */
type ZodRequestBody = NonNullable<NonNullable<RouteConfig['request']>['body']>;

const MULTIPART_BODY: ZodRequestBody = {
  required: true,
  content: {
    'multipart/form-data': {
      schema: {
        type: 'object',
        required: ['file'],
        additionalProperties: false,
        properties: { file: { type: 'string', format: 'binary' } },
      },
    },
  },
};

function malformed(code: string): ProblemError {
  return new ProblemError('validation_failed', { errors: [{ pointer: '', code }] });
}

/**
 * The one file of the request. The body is parsed by the platform's `formData()`; a body that is not
 * valid multipart, a part with another field name, a second part and a field that is not a file are
 * all 422 `validation_failed`. Nothing but the bytes of the part is read from it.
 */
async function readSingleFile(c: RouteContext): Promise<File> {
  let form: FormData;
  try {
    // Deprecated for untrusted uploads in general; here the body is already capped and in memory, and
    // plan V-06 verified this parser on the pinned server (name and part type are never read).
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- see the comment above
    form = await c.req.raw.formData();
  } catch {
    throw malformed('multipart_invalid');
  }
  const parts = [...form.entries()];
  const [only] = parts;
  if (parts.length !== 1 || only === undefined) throw malformed('file_part_required');
  const [field, value] = only;
  if (field !== 'file' || typeof value === 'string') throw malformed('file_part_required');
  return value;
}

export function assetsUploadRoutes(deps: AssetsUploadDeps): RouteDefinition[] {
  const { assets } = deps;
  const iso = (): string => new Date(deps.now()).toISOString();

  /** The audit entry of an upload that was turned away. Its own transaction: there is no change. */
  function auditRejected(
    c: RouteContext,
    db: DatabaseHandle,
    slot: AssetSlot,
    upload: Uint8Array,
    code: ProblemCode,
  ): void {
    const actor = c.get('actor');
    const { address } = c.get('client');
    withTransaction(db, (tx) =>
      appendAudit(tx, {
        ts: iso(),
        actorKind: actor.kind,
        actorId: actor.id,
        action: 'branding.asset.stage',
        targetType: 'branding_asset',
        outcome: 'rejected',
        reasonCode: code,
        ...(address === undefined ? {} : { clientIp: address }),
        requestId: c.get('requestId'),
        detail: { slot, bytes: upload.length, sha256: sha256Hex(upload), created: false },
      }),
    );
  }

  return [
    defineRoute({
      id: 'branding.asset.stage',
      method: 'POST',
      path: '/api/v1/branding/assets',
      access: { permission: 'settings:branding' },
      rateLimit: 'upload',
      audit: 'branding.asset.stage',
      summary: 'Stage a logo image',
      description:
        'Runs the image pipeline on one uploaded file and stores the processed PNG, unreferenced until a branding is applied. Identical bytes are idempotent: 201 when new, 200 when staged before. At most 32 files and 32 MiB wait at a time.',
      request: { query: UploadAssetQuerySchema, body: MULTIPART_BODY },
      responses: {
        200: {
          description: 'These bytes were staged before; nothing new was stored.',
          content: { 'application/json': { schema: UploadAssetResponseSchema } },
        },
        201: {
          description: 'The processed image was stored.',
          content: { 'application/json': { schema: UploadAssetResponseSchema } },
        },
        409: PROBLEM_ANSWERS.conflict,
        503: PROBLEM_ANSWERS.storage,
      },
      handler: async (c, input) => {
        if (deps.isShuttingDown()) throw new ProblemError('shutting_down');
        const db = deps.requireDatabase();
        const { slot } = input.query;

        const file = await readSingleFile(c);
        const upload = new Uint8Array(await file.arrayBuffer());

        const reject = (code: ProblemCode): never => {
          auditRejected(c, db, slot, upload, code);
          throw new ProblemError(code);
        };
        /** 409 whose detail says which part of the quota is full (only numbers; the code is the same). */
        const rejectQuota = (image: Parameters<AssetStore['fitsQuota']>[1]): Response => {
          auditRejected(c, db, slot, upload, 'staging_quota_exceeded');
          const described = describeProblem('staging_quota_exceeded', requestIdOf(c));
          const detail = assets.quotaRefusal(db, image) ?? described.body.detail;
          return new Response(JSON.stringify({ ...described.body, detail }), {
            status: described.status,
            headers: described.headers,
          });
        };
        // The request cap let the part in; the file has its own, one byte tighter than the envelope.
        if (upload.length > LIMITS.body.logoFileBytes) return reject('payload_too_large');

        // Plan 8.5 stages 5 to 8, in the child process.
        let processed: Awaited<ReturnType<ImageJobRunner['process']>>;
        try {
          processed = await deps.images.process({ bytes: upload, slot });
        } catch (error) {
          if (error instanceof ProblemError && AUDITED_REJECTIONS.has(error.code)) {
            auditRejected(c, db, slot, upload, error.code);
          }
          throw error;
        }

        const metadata = {
          sha256: sha256Hex(processed.png),
          bytes: processed.png.length,
          width: processed.width,
          height: processed.height,
          luminance: processed.luminance,
        };
        // The quota is asked before the write, so a refused upload leaves no file behind; the check
        // under the write lock below is the one that counts.
        if (!assets.fitsQuota(db, metadata)) return rejectQuota(metadata);

        await assets.write(processed.png);

        const warnings = processed.warnings.map((warning) => warning.code);
        const actor = c.get('actor');
        const { address } = c.get('client');
        let created: boolean;
        try {
          created = withTransaction(db, (tx) => {
            const registered = assets.registerStaged(tx, metadata);
            appendAudit(tx, {
              ts: iso(),
              actorKind: actor.kind,
              actorId: actor.id,
              action: 'branding.asset.stage',
              targetType: 'branding_asset',
              targetId: metadata.sha256,
              outcome: 'success',
              ...(address === undefined ? {} : { clientIp: address }),
              requestId: c.get('requestId'),
              detail: {
                slot,
                bytes: upload.length,
                sha256: metadata.sha256,
                created: registered.created,
                warnings,
              },
            });
            return registered.created;
          });
        } catch (error) {
          // The quota filled up between the check and the write lock.
          if (error instanceof ProblemError && error.code === 'staging_quota_exceeded') {
            return rejectQuota(metadata);
          }
          throw error;
        }

        const body: UploadAssetResponse = {
          asset: {
            hash: metadata.sha256,
            url: brandingAssetUrl(metadata.sha256),
            width: metadata.width,
            height: metadata.height,
            luminance: metadata.luminance,
            bytes: metadata.bytes,
            created,
          },
          warnings: [...processed.warnings],
        };
        return c.json(body, created ? 201 : 200);
      },
    }),
  ];
}
