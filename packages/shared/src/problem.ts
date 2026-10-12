// The problem registry (contract C2, FR-A-022, FR-A-112): every error the API can answer, as an
// RFC 9457 `application/problem+json` body with a stable machine `code`.
//
// One registry serves everyone. The server builds every problem body from it (status, English
// `title` and generic `detail`), the OpenAPI document lists the codes from it, and the web app maps
// `code` to a translated message through the catalogue key `problem.<code>`. The messages live in
// `i18n/fragments/problem.{en,nl}.json`; `error-codes.test.ts` fails when a code has no message in
// either language, or when a fragment holds a key that is not a code.
//
// `title` and `detail` are English, generic and never sensitive (no path, SQL, stack or secret): the
// UI never shows them, it shows the translated message (FR-A-112).
import { z } from 'zod';
import { OriginSchema, RequestIdSchema } from './schemas/common.js';

/** Freeze an object and everything below it. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

interface ProblemCodeEntry {
  /** The HTTP status the code is answered with. */
  readonly status: number;
  /** Short English summary, the same for every occurrence of the code (RFC 9457 `title`). */
  readonly title: string;
  /** Generic English explanation (RFC 9457 `detail`). Never sensitive; never shown by the UI. */
  readonly detail: string;
}

/**
 * Spec section 6.4 and contract section 6: 34 codes of Phase A, plus the 19 codes of Phase B spec
 * 6.9.5, plus `cursor_invalid` of Phase C spec 6.7.3 at the end of the list (54 in all). `staging_quota_exceeded` (409) and
 * `shutting_down` (503) are the two the plan added to the spec's seed list; `bad_request` (400),
 * `request_timeout` (408) and `request_header_fields_too_large` (431) are the three that Node's HTTP
 * parser errors get (the `clientError` handler, amendment 1).
 */
export const PROBLEM_CODES = deepFreeze({
  permission_denied: {
    status: 403,
    title: 'Permission denied',
    detail:
      'The current actor lacks the permission, the access scope or the actor kind this action requires.',
  },
  origin_not_allowed: {
    status: 403,
    title: 'Origin not allowed',
    detail:
      'The request origin does not match the configured public origin. Open the panel at the address set in PUBLIC_BASE_URL, or correct that variable.',
  },
  csrf_invalid: {
    status: 403,
    title: 'Invalid CSRF token',
    detail: 'The CSRF token is missing, malformed or expired.',
  },
  not_found: {
    status: 404,
    title: 'Not found',
    detail: 'The requested resource does not exist.',
  },
  method_not_allowed: {
    status: 405,
    title: 'Method not allowed',
    detail: 'This method is not allowed on this path.',
  },
  branding_conflict: {
    status: 412,
    title: 'Branding was changed by someone else',
    detail: 'The branding revision does not match If-Match.',
  },
  payload_too_large: {
    status: 413,
    title: 'Request body too large',
    detail: 'The request body is larger than the limit for this route.',
  },
  unsupported_media_type: {
    status: 415,
    title: 'Unsupported media type',
    detail: 'The request content type is not supported on this route.',
  },
  image_type_unsupported: {
    status: 415,
    title: 'Image type not supported',
    detail: 'Only PNG, JPEG and SVG images are accepted.',
  },
  validation_failed: {
    status: 422,
    title: 'Validation failed',
    detail: 'The request did not pass validation.',
  },
  accent_invalid: {
    status: 422,
    title: 'Invalid accent colour',
    detail: 'The accent colour must be a hexadecimal colour such as #0078d4.',
  },
  org_name_invalid: {
    status: 422,
    title: 'Invalid organisation name',
    detail: 'The organisation name does not meet the naming rules.',
  },
  asset_unknown: {
    status: 422,
    title: 'Unknown asset',
    detail: 'A referenced image has not been uploaded or is no longer available.',
  },
  image_corrupt: {
    status: 422,
    title: 'Image could not be decoded',
    detail: 'The image data is damaged or cannot be decoded.',
  },
  image_pixels_exceeded: {
    status: 422,
    title: 'Image has too many pixels',
    detail: 'The image has more pixels than the limit allows.',
  },
  image_empty: {
    status: 422,
    title: 'Image is empty',
    detail: 'The image is empty or has nothing to render.',
  },
  image_processing_timeout: {
    status: 422,
    title: 'Image processing took too long',
    detail: 'Processing the image took longer than the time budget.',
  },
  svg_not_wellformed: {
    status: 422,
    title: 'SVG is not well-formed',
    detail: 'The SVG is not well-formed UTF-8 XML or has no size information.',
  },
  svg_doctype_forbidden: {
    status: 422,
    title: 'SVG declarations not allowed',
    detail: 'The SVG contains a document type or entity declaration.',
  },
  svg_text_unsupported: {
    status: 422,
    title: 'SVG text not supported',
    detail: 'The SVG contains text elements, which are not supported.',
  },
  svg_too_complex: {
    status: 422,
    title: 'SVG is too complex',
    detail: 'The SVG exceeds the limits for elements, depth or references.',
  },
  import_invalid: {
    status: 422,
    title: 'Branding import is invalid',
    detail: 'The import file does not match the expected format.',
  },
  import_unsupported_version: {
    status: 422,
    title: 'Branding import version not supported',
    detail: 'The import file has a schema version this version cannot read.',
  },
  precondition_required: {
    status: 428,
    title: 'Precondition required',
    detail: 'The request must include an If-Match header.',
  },
  rate_limited: {
    status: 429,
    title: 'Too many requests',
    detail: 'Too many requests were sent in a short time.',
  },
  image_processing_busy: {
    status: 429,
    title: 'Image processing is busy',
    detail: 'All image processing slots are in use.',
  },
  staging_quota_exceeded: {
    status: 409,
    title: 'Staging quota exceeded',
    detail: 'Too many uploaded images are waiting to be applied.',
  },
  internal_error: {
    status: 500,
    title: 'Internal error',
    detail: 'The server could not complete the request.',
  },
  storage_unavailable: {
    status: 503,
    title: 'Storage unavailable',
    detail: 'The data storage is not available.',
  },
  storage_busy: {
    status: 503,
    title: 'Storage busy',
    detail: 'The data storage is busy.',
  },
  shutting_down: {
    status: 503,
    title: 'Server is shutting down',
    detail: 'The server is shutting down.',
  },
  bad_request: {
    status: 400,
    title: 'Bad request',
    detail: 'The request could not be parsed.',
  },
  request_timeout: {
    status: 408,
    title: 'Request timeout',
    detail: 'The request was not received in time.',
  },
  request_header_fields_too_large: {
    status: 431,
    title: 'Request header fields too large',
    detail: 'The request line or the headers are larger than the limit.',
  },
  // Phase B (spec 6.9.5, T-B-005): the 19 codes of sign-in, sessions, RBAC, setup and secrets.
  unauthenticated: {
    status: 401,
    title: 'Authentication required',
    detail: 'The request needs a valid session.',
  },
  session_expired: {
    status: 401,
    title: 'Session expired',
    detail: 'The session is unknown or has expired.',
  },
  step_up_required: {
    status: 403,
    title: 'Step-up required',
    detail: 'This action needs a recent sign-in with multi-factor authentication.',
  },
  escalation_denied: {
    status: 403,
    title: 'Escalation denied',
    detail: 'The change would grant more access than the current user holds.',
  },
  last_owner_protected: {
    status: 409,
    title: 'Last owner protected',
    detail: 'The change would leave the panel without an Owner.',
  },
  setup_token_invalid: {
    status: 401,
    title: 'Setup token invalid',
    detail: 'The setup token is not valid.',
  },
  setup_token_locked: {
    status: 429,
    title: 'Setup unlock locked',
    detail: 'Too many failed attempts, so unlocking is locked for a while.',
  },
  setup_step_busy: {
    status: 409,
    title: 'Setup step busy',
    detail: 'Another setup step is already running.',
  },
  setup_step_not_ready: {
    status: 409,
    title: 'Setup step not ready',
    detail: 'An earlier setup step has not finished successfully.',
  },
  setup_required: {
    status: 409,
    title: 'Setup required',
    detail: 'Setup has not reached the stage that this action needs.',
  },
  secrets_unavailable: {
    status: 503,
    title: 'Key material unavailable',
    detail: 'The application key is missing or invalid, or the certificate cannot be read.',
  },
  policy_not_applied: {
    status: 500,
    title: 'Access scope not applied',
    detail: 'The handler finished without applying the access scope of the caller.',
  },
  principal_unknown: {
    status: 422,
    title: 'Principal unknown',
    detail: 'The user or group is not known to the directory.',
  },
  assignment_exists: {
    status: 409,
    title: 'Assignment exists',
    detail: 'An assignment with this principal, role and scope already exists.',
  },
  assignment_invalid: {
    status: 422,
    title: 'Assignment invalid',
    detail: 'The role, scope or expiry of the assignment is not allowed.',
  },
  break_glass_locked: {
    status: 429,
    title: 'Break-glass locked',
    detail: 'Too many failed attempts, so break-glass sign-in is locked for a while.',
  },
  graph_unavailable: {
    status: 503,
    title: 'Directory unavailable',
    detail: 'Microsoft Graph could not be reached or failed.',
  },
  graph_throttled: {
    status: 503,
    title: 'Directory throttled',
    detail: 'Microsoft Graph asked to wait longer than the panel allows.',
  },
  tenant_mismatch: {
    status: 409,
    title: 'Tenant mismatch',
    detail: 'The account belongs to another tenant than the one this panel is connected to.',
  },
  // Phase C (spec 6.7.3, T-C-002): the one code of the read-only users and groups lists.
  cursor_invalid: {
    status: 400,
    title: 'Invalid list cursor',
    detail: 'The list cursor is unknown, has expired or belongs to another user.',
  },
} as const satisfies Record<string, ProblemCodeEntry>);

/** One of the registry's codes. */
export type ProblemCode = keyof typeof PROBLEM_CODES;

/** The HTTP statuses the registry uses. */
export type ProblemStatus = (typeof PROBLEM_CODES)[ProblemCode]['status'];

/** The catalogue key of the translated message of a code, or of the generic one. */
export type ProblemMessageKey = `problem.${ProblemCode}` | 'problem.unknown';

/** Every `type` member starts with this URN prefix, followed by the code. */
export const PROBLEM_TYPE_PREFIX = 'urn:m365portal:problem:';

// `Object.keys` is typed as string[]; the cast is safe because the registry is the only source.
const PROBLEM_CODE_LIST = Object.keys(PROBLEM_CODES) as [ProblemCode, ...ProblemCode[]];

/** The registry's codes as a Zod enum, for the OpenAPI document and for strict server-side checks. */
export const ProblemCodeSchema = z.enum(PROBLEM_CODE_LIST).meta({ id: 'ProblemCode' });

/** True when `value` is a code of this version's registry (an own key, never a prototype member). */
export function isProblemCode(value: unknown): value is ProblemCode {
  return typeof value === 'string' && Object.hasOwn(PROBLEM_CODES, value);
}

/** The RFC 9457 `type` of a code: `urn:m365portal:problem:<code>`. */
export function problemType(code: ProblemCode): `urn:m365portal:problem:${ProblemCode}` {
  return `${PROBLEM_TYPE_PREFIX}${code}`;
}

/**
 * The catalogue key of the message to show for `code`: `problem.<code>`, or `problem.unknown` for a
 * code this version does not know (a newer server with an older cached app, E-20). The generic
 * message is given the code and the request id so that the user has something to report.
 */
export function problemMessageKey(code: string): ProblemMessageKey {
  return isProblemCode(code) ? `problem.${code}` : 'problem.unknown';
}

/** A code on the wire: lower-case words joined by underscores. */
const CODE_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * One entry of `errors[]`. `pointer` is a JSON Pointer into the body (`/accent`, `/logos/light`, or
 * the empty string for the whole body), or `query/<name>` or `header/<name>`. `code` is a registry
 * code (`accent_invalid`) or a generic validation code (`invalid_type`, `too_small`).
 */
export const ProblemFieldErrorSchema = z
  .strictObject({
    pointer: z.string().regex(/^(?:|\/.*|query\/[^/]+|header\/[^/]+)$/s),
    code: z.string().regex(CODE_PATTERN).max(64),
  })
  .meta({ id: 'ProblemFieldError' });

/**
 * The problem body: the RFC 9457 members plus `code`, `requestId`, `errors[]` and, for
 * `origin_not_allowed` only, `expectedOrigin`. Any other member (a `stack`, an `sql`, a `path`) is
 * refused, which is how the tests show that nothing sensitive leaks (FR-A-023).
 *
 * `code` is not limited to this version's registry, so that a client can still read a problem from
 * a newer server; for a code it knows, the status must be the registry's. The `type` is always the
 * URN of the code.
 */
export const ProblemSchema = z
  .strictObject({
    type: z.string(),
    title: z.string().min(1),
    status: z.number().int().min(400).max(599),
    detail: z.string().min(1),
    instance: z.string().min(1).optional(),
    code: z.string().regex(CODE_PATTERN).max(64),
    requestId: RequestIdSchema,
    errors: z.array(ProblemFieldErrorSchema).optional(),
    expectedOrigin: OriginSchema.optional(),
  })
  .superRefine((problem, context) => {
    if (problem.type !== `${PROBLEM_TYPE_PREFIX}${problem.code}`) {
      context.addIssue({
        code: 'custom',
        path: ['type'],
        message: `the type is ${PROBLEM_TYPE_PREFIX}<code>`,
      });
    }
    if (isProblemCode(problem.code) && problem.status !== PROBLEM_CODES[problem.code].status) {
      context.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'the status is the one the registry gives the code',
      });
    }
    if (problem.expectedOrigin !== undefined && problem.code !== 'origin_not_allowed') {
      context.addIssue({
        code: 'custom',
        path: ['expectedOrigin'],
        message: 'expectedOrigin belongs to origin_not_allowed only',
      });
    }
  })
  .meta({ id: 'Problem' });

export type Problem = z.infer<typeof ProblemSchema>;
export type ProblemFieldError = z.infer<typeof ProblemFieldErrorSchema>;
