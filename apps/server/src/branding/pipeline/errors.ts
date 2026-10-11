// The failures of the image pipeline (T-A-078 to T-A-081; plan 8.5, FR-A-085 to FR-A-088). A hostile
// file is refused with a stable problem code (one of the registry's), never with a sentence that
// quotes it: the `reason` of a failure is a constant written in the code, so nothing an attacker
// sent can reach a log, an audit entry or a response through an error message. The code is what the
// image child reports to the main process, which maps it to the HTTP answer (`job-protocol.ts`).
import type { ProblemCode } from '@m365portal/shared/problem';

/**
 * The problem codes the content of an upload can cause. `image_processing_timeout`,
 * `image_processing_busy` and `shutting_down` belong to the job runner, which owns the time budget,
 * the queue and the children; the pipeline never raises them.
 */
export const PIPELINE_FAILURE_CODES = [
  'image_type_unsupported',
  'image_empty',
  'image_corrupt',
  'image_pixels_exceeded',
  'svg_not_wellformed',
  'svg_doctype_forbidden',
  'svg_text_unsupported',
  'svg_too_complex',
] as const satisfies readonly ProblemCode[];

export type PipelineFailureCode = (typeof PIPELINE_FAILURE_CODES)[number];

/** The input is at fault: refused with `code`, and the code is all the caller needs. */
export class PipelineError extends Error {
  readonly code: PipelineFailureCode;
  /** A constant that says which rule refused the input (never derived from the input). */
  readonly reason: string;

  constructor(code: PipelineFailureCode, reason: string) {
    super(`${code}: ${reason}`);
    this.name = 'PipelineError';
    this.code = code;
    this.reason = reason;
  }
}

/** True for an error the input caused (as opposed to a fault of ours). */
export function isPipelineError(failure: unknown): failure is PipelineError {
  return failure instanceof PipelineError;
}

/**
 * The encoded output failed the self-check of plan 8.5 stage 8 (a chunk that is not on the
 * allow-list, bytes after `IEND`, a wrong checksum). That is a bug of ours or of the encoder, not the
 * fault of the input: it carries no problem code and is reported as an internal error, audited as
 * `error` (plan 8.5). The message names a chunk type of OUR output, never anything of the input.
 */
export class OutputCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutputCheckError';
  }
}
