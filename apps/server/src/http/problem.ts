// Problem responses (FR-A-022, contract section 6): every error the API answers is an RFC 9457
// `application/problem+json` document built from the one registry in `@m365portal/shared/problem`.
// Status, title and detail come from the registry and are generic; nothing the client sent and
// nothing the server knows (a path, a query, a stack) is ever copied into a body.
//
// Three ways in, one body out:
//   - `problemResponse(c, code, details)` where a handler or a guard can return a response;
//   - `throw new ProblemError(code, details)` where it cannot (a deep service call);
//   - `validationProblemResponse(c, failure)` as the `defaultHook` of the route validators.
// The error handler (error-handler.ts) turns a thrown `ProblemError` into the same response.
import {
  PROBLEM_CODES,
  isProblemCode,
  problemType,
  type Problem,
  type ProblemCode,
  type ProblemFieldError,
} from '@m365portal/shared/problem';
import { OriginSchema, RequestIdSchema } from '@m365portal/shared/schemas/common';
import type { Context } from 'hono';
import { generateRequestId } from './request-context.js';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/**
 * The retry hint of codes whose hint is fixed (contract section 6): a locked database is usually
 * free again in a second, a server that is shutting down is back in a few, and Graph is asked again
 * after 30 seconds (contract section 9.1).
 */
export const RETRY_AFTER_SECONDS = {
  storage_busy: 1,
  shutting_down: 5,
  graph_unavailable: 30,
} as const;

/** `errors[]` is capped, so that a body with thousands of faults cannot make the answer large. */
export const MAX_FIELD_ERRORS = 50;

/** The registry codes a validation failure may be promoted to (contract section 1, FR-A-082). */
const PROMOTED_VALIDATION_CODES: ReadonlySet<string> = new Set([
  'accent_invalid',
  'org_name_invalid',
  'asset_unknown',
]);

// ---------------------------------------------------------------------------------------------
// The details a code can carry
// ---------------------------------------------------------------------------------------------

export interface ProblemDetails {
  /** Which fields failed and why. Only for validation failures. */
  readonly errors?: readonly ProblemFieldError[];
  /** The origin the server expects. Required by, and only valid for, `origin_not_allowed`. */
  readonly expectedOrigin?: string;
  /** The methods the path supports. Required by `method_not_allowed`. */
  readonly allow?: readonly string[];
  /** Whole seconds. Required by `rate_limited` and `image_processing_busy`. */
  readonly retryAfterSeconds?: number;
}

interface RequiredDetails {
  origin_not_allowed: { readonly expectedOrigin: string };
  method_not_allowed: { readonly allow: readonly string[] };
  rate_limited: { readonly retryAfterSeconds: number };
  image_processing_busy: { readonly retryAfterSeconds: number };
}

/** The arguments after the code: required where the code needs a detail, optional elsewhere. */
export type DetailsArgs<Code extends ProblemCode> = Code extends keyof RequiredDetails
  ? [details: ProblemDetails & RequiredDetails[Code]]
  : [details?: ProblemDetails];

const METHOD_TOKEN = /^[A-Za-z]{1,16}$/;

/** What the client is sent: the status, the headers and the body. Throws on a missing detail. */
export interface DescribedProblem {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Problem;
}

function describeAllow(allow: readonly string[] | undefined): string {
  if (allow === undefined || allow.length === 0 || !allow.every((m) => METHOD_TOKEN.test(m))) {
    throw new TypeError('method_not_allowed needs allow: a list of methods');
  }
  return [...new Set(allow.map((method) => method.toUpperCase()))].sort().join(', ');
}

function describeRetryAfter(code: ProblemCode, details: ProblemDetails): string | undefined {
  if (code === 'rate_limited' || code === 'image_processing_busy') {
    const seconds = details.retryAfterSeconds;
    if (
      seconds === undefined ||
      !Number.isSafeInteger(seconds) ||
      seconds < 1 ||
      seconds > 86_400
    ) {
      throw new TypeError(`${code} needs retryAfterSeconds: whole seconds from 1 to 86400`);
    }
    return String(seconds);
  }
  if (code === 'storage_busy' || code === 'shutting_down' || code === 'graph_unavailable')
    return String(RETRY_AFTER_SECONDS[code]);
  return undefined;
}

/**
 * Build a problem from a code that is only known at run time. The typed entry points
 * (`buildProblem`, `problemResponse`) check the details at compile time; this one checks them when
 * it runs, so a code raised from a variable cannot go out without what it needs.
 */
export function describeProblem(
  code: ProblemCode,
  requestId: string,
  details: ProblemDetails = {},
): DescribedProblem {
  const entry = PROBLEM_CODES[code];
  const headers: Record<string, string> = { 'Content-Type': PROBLEM_CONTENT_TYPE };

  if (code === 'origin_not_allowed') {
    if (
      details.expectedOrigin === undefined ||
      !OriginSchema.safeParse(details.expectedOrigin).success
    ) {
      throw new TypeError('origin_not_allowed needs expectedOrigin: the serialised origin');
    }
  } else if (details.expectedOrigin !== undefined) {
    throw new TypeError('expectedOrigin belongs to origin_not_allowed only');
  }
  if (code === 'method_not_allowed') headers.Allow = describeAllow(details.allow);
  const retryAfter = describeRetryAfter(code, details);
  if (retryAfter !== undefined) headers['Retry-After'] = retryAfter;

  const errors = details.errors?.slice(0, MAX_FIELD_ERRORS);
  const body: Problem = {
    type: problemType(code),
    title: entry.title,
    status: entry.status,
    detail: entry.detail,
    code,
    requestId,
    ...(errors !== undefined && errors.length > 0 ? { errors } : {}),
    ...(code === 'origin_not_allowed' ? { expectedOrigin: details.expectedOrigin } : {}),
  };
  return { status: entry.status, headers, body };
}

/** The body of a problem, typed so that a code cannot be raised without the detail it needs. */
export function buildProblem<Code extends ProblemCode>(
  code: Code,
  requestId: string,
  ...details: DetailsArgs<Code>
): Problem {
  return describeProblem(code, requestId, details[0]).body;
}

/**
 * The id of the request being answered. A context that did not pass through `requestContext` (a
 * unit test of a handler on its own) gets a fresh id, so a problem body always has a valid one.
 */
export function requestIdOf(c: Context): string {
  const id: unknown = c.get('requestId');
  return typeof id === 'string' && RequestIdSchema.safeParse(id).success ? id : generateRequestId();
}

function toResponse(described: DescribedProblem): Response {
  return new Response(JSON.stringify(described.body), {
    status: described.status,
    headers: described.headers,
  });
}

/** Answer with a problem. The headers of the pipeline (security, request id) are added after. */
export function problemResponse<Code extends ProblemCode>(
  c: Context,
  code: Code,
  ...details: DetailsArgs<Code>
): Response {
  return toResponse(describeProblem(code, requestIdOf(c), details[0]));
}

/** `problemResponse` for a code that is only known at run time; the details are checked then. */
export function problemResponseFor(
  c: Context,
  code: ProblemCode,
  details?: ProblemDetails,
): Response {
  return toResponse(describeProblem(code, requestIdOf(c), details));
}

/**
 * A problem raised by throwing. The details are checked when the error is created, at the line
 * that raised it, not later in the error handler. The message names the code and nothing else.
 */
export class ProblemError extends Error {
  readonly code: ProblemCode;
  readonly details: ProblemDetails;

  constructor(code: ProblemCode, details: ProblemDetails = {}) {
    super(`problem ${code}`);
    // Fail here, at the throw site, if the details do not fit the code.
    describeProblem(code, 'check-only', details);
    this.name = 'ProblemError';
    this.code = code;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------------------------
// Validation failures (contract section 1, FR-A-022, FR-A-082)
// ---------------------------------------------------------------------------------------------

export type ValidationTarget = 'json' | 'form' | 'query' | 'header' | 'param' | 'cookie';

/** The part of a Zod issue this module reads: never `input`, never the Zod message text. */
export interface ValidationIssue {
  readonly code: string;
  readonly message: string;
  readonly path: readonly PropertyKey[];
}

/** What a request validator hands to its failure hook: the target and a Zod error. */
export interface ValidationFailure {
  readonly target: ValidationTarget;
  readonly error: { readonly issues: readonly ValidationIssue[] };
}

const FIELD_CODE = /^[a-z][a-z0-9_]*$/;

function segment(key: PropertyKey): string {
  return typeof key === 'symbol' ? '?' : String(key);
}

function pointerOf(target: ValidationTarget, path: readonly PropertyKey[]): string {
  const [first] = path;
  if (first === undefined) return '';
  if (target === 'query' || target === 'header') {
    // The grammar of the pointer is `query/<name>`: one segment without a slash.
    return `${target}/${segment(first).replaceAll('/', '%2F')}`;
  }
  return path.map((key) => `/${segment(key).replaceAll('~', '~0').replaceAll('/', '~1')}`).join('');
}

/**
 * The code of one fault: the message when a schema put a registry code there (`accent_invalid`),
 * otherwise Zod's own issue code (`invalid_type`, `too_small`), kept inside the grammar of the
 * `errors[].code` schema. The text of the message is never used.
 */
function faultCode(issue: ValidationIssue): string {
  if (isProblemCode(issue.message)) return issue.message;
  return FIELD_CODE.test(issue.code) && issue.code.length <= 64 ? issue.code : 'invalid';
}

/** The problem code and the field errors of a validation failure. */
export function validationProblemParts(failure: ValidationFailure): {
  readonly code: ProblemCode;
  readonly errors: readonly ProblemFieldError[];
} {
  const errors = failure.error.issues.slice(0, MAX_FIELD_ERRORS).map((issue) => ({
    pointer: pointerOf(failure.target, issue.path),
    code: faultCode(issue),
  }));
  // When the first fault carries a specific registry code, that is the code of the problem; the
  // list still shows every fault.
  const first = errors[0]?.code;
  const code: ProblemCode =
    first !== undefined && PROMOTED_VALIDATION_CODES.has(first) && isProblemCode(first)
      ? first
      : 'validation_failed';
  return { code, errors };
}

/** The `defaultHook` of the route validators: 422 with `errors[]`, or the promoted code. */
export function validationProblemResponse(c: Context, failure: ValidationFailure): Response {
  const { code, errors } = validationProblemParts(failure);
  return problemResponseFor(c, code, { errors });
}
