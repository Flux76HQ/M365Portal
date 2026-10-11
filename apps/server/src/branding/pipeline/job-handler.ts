// What the image child does with a job (T-A-083; FR-A-088, FR-A-089; PD-08): the request in, the reply
// out, no process, no channel, no state. `image-worker.ts` is the thin shell that reads one request
// from the IPC channel and writes this function's reply to it; keeping the work here means it can be
// called in-process by a test (the same code, without the child) and nothing here has a side effect
// on import.
//
// Two kinds of job:
//   upload    the bytes of an uploaded file: sniffed by content, sanitised if SVG, rasterised, bounded,
//             re-encoded as PNG with nothing of the input left in it (plan 8.5 stages 6 to 8);
//   variants  the stored masters, the organisation name and the accent: the compact variant when none
//             was uploaded, and the five icons (PD-11).
//
// A failure of the input is reported by its problem code (one of `WORKER_FAILURE_CODES`); anything else
// that goes wrong is reported as an internal failure and nothing about it leaves the child: the main
// process logs the exit and the kind of fault, never what the input looked like.
import { LIMITS } from '@m365portal/shared/limits';
import type { AssetSlot, UploadWarning } from '@m365portal/shared/schemas/assets';
import { deriveVariants } from './icons.js';
import {
  ICON_KINDS,
  WORKER_FAILURE_CODES,
  decodeBytes,
  encodeBytes,
  type IconKind,
  type JobReply,
  type JobRequest,
  type UploadJobRequest,
  type VariantsJobRequest,
  type WorkerFailureCode,
} from './job-protocol.js';

/** A processed upload, as the upload stages hand it over. */
export interface UploadResult {
  readonly png: Uint8Array;
  readonly width: number;
  readonly height: number;
  /** The alpha-weighted mean relative luminance of the visible pixels of `png`, 0 to 1, or null. */
  readonly luminance: number | null;
  readonly warnings: readonly UploadWarning[];
}

/**
 * Sniff, sanitise, rasterise, bound, re-encode. It fails with an error that has a `code` from
 * `WORKER_FAILURE_CODES` when the input is at fault.
 */
export type UploadProcessor = (input: {
  readonly bytes: Buffer;
  readonly slot: AssetSlot;
}) => Promise<UploadResult>;

export interface HandlerDependencies {
  /**
   * The upload stages (`processUpload` of `process-upload.ts`, which `image-worker.ts` passes in). A
   * job of kind `upload` without them is an internal failure; `variants` jobs do not need them.
   */
  readonly upload?: UploadProcessor;
}

function isWorkerFailureCode(value: unknown): value is WorkerFailureCode {
  return (WORKER_FAILURE_CODES as readonly unknown[]).includes(value);
}

/** The reply for an error: the problem it names when it is the input's fault, an internal failure otherwise. */
function failureReply(error: unknown): JobReply {
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  if (isWorkerFailureCode(code)) {
    return { v: 1, ok: false, failure: 'problem', code };
  }
  return { v: 1, ok: false, failure: 'internal' };
}

async function handleUpload(
  request: UploadJobRequest,
  dependencies: HandlerDependencies,
): Promise<JobReply> {
  const upload = dependencies.upload;
  if (upload === undefined) throw new Error('the upload stages are not available');
  const bytes = decodeBytes(request.bytes, LIMITS.body.logoFileBytes);
  const result = await upload({ bytes, slot: request.slot });
  return {
    v: 1,
    ok: true,
    kind: 'upload',
    png: encodeBytes(result.png),
    width: result.width,
    height: result.height,
    luminance: result.luminance,
    warnings: [...result.warnings],
  };
}

async function handleVariants(request: VariantsJobRequest): Promise<JobReply> {
  const master = (text: string | null): { readonly png: Uint8Array } | null =>
    text === null ? null : { png: decodeBytes(text, LIMITS.body.logoFileBytes) };
  const derived = await deriveVariants({
    orgName: request.orgName,
    accent: request.accent,
    light: master(request.light),
    dark: master(request.dark),
    compact: master(request.compact),
  });
  const icons = {} as Record<IconKind, string>;
  for (const kind of ICON_KINDS) icons[kind] = encodeBytes(derived.icons.icons[kind].png);
  return {
    v: 1,
    ok: true,
    kind: 'variants',
    compact:
      derived.compact === null
        ? null
        : { png: encodeBytes(derived.compact.png), luminance: derived.compact.luminance },
    compactDerived: derived.compactDerived,
    source: derived.icons.source,
    plate: derived.icons.plate,
    icons,
  };
}

/** Do one job. Never throws: every outcome is a reply. */
export async function handleJob(
  request: JobRequest,
  dependencies: HandlerDependencies = {},
): Promise<JobReply> {
  try {
    return request.kind === 'upload'
      ? await handleUpload(request, dependencies)
      : await handleVariants(request);
  } catch (error) {
    return failureReply(error);
  }
}
