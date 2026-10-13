// The error taxonomy of the Microsoft clients (plan 8.2, SB-05). Every class carries a stable `code`,
// a `retryable` flag and, where it applies, the HTTP `status`, `retryAfterMs`, the Graph error code,
// the correlation ids of the response and the AADSTS number.
//
// Nothing else gets in. A class takes a small record of details and keeps only the values that pass
// a strict check; the message of an error is its code. A token, a header value, a request body and
// the free text Microsoft sends (`error_description`, `message`) therefore cannot appear in
// `message`, `toString()`, `JSON.stringify()` or `util.inspect()`, whoever builds the error and
// whatever they pass. There is no `cause`: the original failure is logged where it happens, by its
// code, and not carried along.
//
// The ports import nothing external and do no I/O (FR-B-315), so this file uses only language
// features. `classifyFailure` (transient, replication, permanent) belongs to the setup runner.

/** `^[A-Za-z0-9_.]{1,64}$`: the shape of a Graph error code such as `Request_ResourceNotFound`. */
const GRAPH_CODE = /^[A-Za-z0-9_.]{1,64}$/;
/** Correlation ids are GUIDs in practice; anything with a space or punctuation is not one. */
const CORRELATION_ID = /^[A-Za-z0-9-]{1,64}$/;
/** An OAuth error string such as `invalid_client`; also the word shape of a `reason`. */
const WORD = /^[a-z][a-z_]{0,63}$/;
const AADSTS_DIGITS = /^\d{4,7}$/;
/** A Retry-After longer than a week is not a wait, it is a mistake or an attack. */
const MAX_RETRY_AFTER_MS = 7 * 86_400_000;

/** The value of `details[key]` when `details` is a plain record, otherwise `undefined`. */
function read(details: unknown, key: string): unknown {
  return typeof details === 'object' && details !== null
    ? (details as Record<string, unknown>)[key]
    : undefined;
}

function pickMatching(value: unknown, pattern: RegExp): string | undefined {
  return typeof value === 'string' && pattern.test(value) ? value : undefined;
}

function pickAadsts(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && AADSTS_DIGITS.test(String(value)) ? value : undefined;
  }
  return typeof value === 'string' && AADSTS_DIGITS.test(value) ? Number(value) : undefined;
}

function pickRetryAfter(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_RETRY_AFTER_MS
    ? value
    : undefined;
}

function pickStatus(value: unknown, low: number, high: number): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= low && value <= high
    ? value
    : undefined;
}

/** The fields every Microsoft client error may carry. Each is validated, none is free text. */
export interface IntegrationErrorDetails {
  /** `Retry-After` of the response, in milliseconds. */
  readonly retryAfterMs?: number;
  /** The Graph `error.code`, `^[A-Za-z0-9_.]{1,64}$`. */
  readonly graphCode?: string;
  /** `request-id` of the response. */
  readonly requestId?: string;
  /** `client-request-id` we sent. */
  readonly clientRequestId?: string;
  /** The number of an `AADSTS` code: digits only. */
  readonly aadsts?: number | string;
}

export interface FixedStatusDetails extends IntegrationErrorDetails {
  /** Ignored: the class names its own status. */
  readonly status?: number;
}

export interface TransientDetails extends IntegrationErrorDetails {
  /** One of 500 to 504; anything else is replaced by the default. */
  readonly status?: number;
}

interface Fixed {
  readonly name: string;
  readonly code: string;
  readonly retryable: boolean;
  readonly status?: number;
}

/**
 * Base of every error the Microsoft clients and the identity code throw. It cannot be thrown on
 * its own: each family below names its code and its retry flag.
 */
export abstract class IntegrationError extends Error {
  /** Stable, lower snake case; a problem code of the API where one exists (`graph_throttled`). */
  readonly code: string;
  /** Whether trying the same call again later can succeed. */
  readonly retryable: boolean;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;
  readonly graphCode: string | undefined;
  readonly requestId: string | undefined;
  readonly clientRequestId: string | undefined;
  readonly aadsts: number | undefined;

  protected constructor(fixed: Fixed, details?: unknown) {
    super(fixed.code);
    this.name = fixed.name;
    this.code = fixed.code;
    this.retryable = fixed.retryable;
    this.status = fixed.status;
    this.retryAfterMs = pickRetryAfter(read(details, 'retryAfterMs'));
    this.graphCode = pickMatching(read(details, 'graphCode'), GRAPH_CODE);
    this.requestId = pickMatching(read(details, 'requestId'), CORRELATION_ID);
    this.clientRequestId = pickMatching(read(details, 'clientRequestId'), CORRELATION_ID);
    this.aadsts = pickAadsts(read(details, 'aadsts'));
    // The stack holds the message, which is the code: no free text. `cause` is never set.
  }

  /** The class-specific fields of `toJSON`. */
  protected extraJson(): Record<string, string> {
    return {};
  }

  /** An allow-list, so that a logger or `JSON.stringify` shows these fields and no others. */
  toJSON(): Record<string, unknown> {
    const json: Record<string, unknown> = {
      name: this.name,
      code: this.code,
      retryable: this.retryable,
    };
    if (this.status !== undefined) json.status = this.status;
    if (this.retryAfterMs !== undefined) json.retryAfterMs = this.retryAfterMs;
    if (this.graphCode !== undefined) json.graphCode = this.graphCode;
    if (this.requestId !== undefined) json.requestId = this.requestId;
    if (this.clientRequestId !== undefined) json.clientRequestId = this.clientRequestId;
    if (this.aadsts !== undefined) json.aadsts = this.aadsts;
    return { ...json, ...this.extraJson() };
  }

  /** `util.inspect` shows the allow-listed form, never the raw own properties. */
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `${this.name} ${JSON.stringify(this.toJSON())}`;
  }
}

// ---------------------------------------------------------------------------------------------
// Graph (raised by GraphHttp)
// ---------------------------------------------------------------------------------------------

export abstract class GraphError extends IntegrationError {}

export class GraphBadRequestError extends GraphError {
  constructor(details?: FixedStatusDetails) {
    super(
      { name: 'GraphBadRequestError', code: 'graph_bad_request', retryable: false, status: 400 },
      details,
    );
  }
}

export class GraphUnauthorizedError extends GraphError {
  constructor(details?: FixedStatusDetails) {
    super(
      {
        name: 'GraphUnauthorizedError',
        code: 'graph_unauthorized',
        retryable: false,
        status: 401,
      },
      details,
    );
  }
}

export class GraphForbiddenError extends GraphError {
  constructor(details?: FixedStatusDetails) {
    super(
      { name: 'GraphForbiddenError', code: 'graph_forbidden', retryable: false, status: 403 },
      details,
    );
  }
}

export class GraphNotFoundError extends GraphError {
  constructor(details?: FixedStatusDetails) {
    super(
      { name: 'GraphNotFoundError', code: 'graph_not_found', retryable: false, status: 404 },
      details,
    );
  }
}

export class GraphConflictError extends GraphError {
  constructor(details?: FixedStatusDetails) {
    super(
      { name: 'GraphConflictError', code: 'graph_conflict', retryable: false, status: 409 },
      details,
    );
  }
}

/** 429 that the client did not wait out (the wait would exceed 60 s, or the wizard budget applies). */
export class GraphThrottledError extends GraphError {
  constructor(details?: FixedStatusDetails) {
    super(
      { name: 'GraphThrottledError', code: 'graph_throttled', retryable: true, status: 429 },
      details,
    );
  }
}

/** 500, 502, 503 or 504 after the retries were used up. */
export class GraphTransientError extends GraphError {
  constructor(details?: TransientDetails) {
    super(
      {
        name: 'GraphTransientError',
        code: 'graph_transient',
        retryable: true,
        status: pickStatus(read(details, 'status'), 500, 504) ?? 503,
      },
      details,
    );
  }
}

/** No answer: a refused connection, a timeout, a redirect, an answer that is not JSON. */
export class GraphNetworkError extends GraphError {
  constructor(details?: IntegrationErrorDetails) {
    super({ name: 'GraphNetworkError', code: 'graph_network', retryable: true }, details);
  }
}

// ---------------------------------------------------------------------------------------------
// Exchange (raised by AdminApiExchangeClient)
// ---------------------------------------------------------------------------------------------

export abstract class ExchangeError extends IntegrationError {}

/** A word such as `invalid_next_link`; anything else becomes the fallback. */
function pickReason(details: unknown, fallback: string): string {
  return pickMatching(read(details, 'reason'), WORD) ?? fallback;
}

export class ExchangeBadRequestError extends ExchangeError {
  constructor(details?: FixedStatusDetails) {
    super(
      {
        name: 'ExchangeBadRequestError',
        code: 'exchange_bad_request',
        retryable: false,
        status: 400,
      },
      details,
    );
  }
}

export class ExchangeUnauthorizedError extends ExchangeError {
  constructor(details?: FixedStatusDetails) {
    super(
      {
        name: 'ExchangeUnauthorizedError',
        code: 'exchange_unauthorized',
        retryable: false,
        status: 401,
      },
      details,
    );
  }
}

export class ExchangeForbiddenError extends ExchangeError {
  constructor(details?: FixedStatusDetails) {
    super(
      {
        name: 'ExchangeForbiddenError',
        code: 'exchange_forbidden',
        retryable: false,
        status: 403,
      },
      details,
    );
  }
}

export class ExchangeThrottledError extends ExchangeError {
  constructor(details?: FixedStatusDetails) {
    super(
      {
        name: 'ExchangeThrottledError',
        code: 'exchange_throttled',
        retryable: true,
        status: 429,
      },
      details,
    );
  }
}

export class ExchangeTransientError extends ExchangeError {
  constructor(details?: TransientDetails) {
    super(
      {
        name: 'ExchangeTransientError',
        code: 'exchange_transient',
        retryable: true,
        status: pickStatus(read(details, 'status'), 500, 504) ?? 503,
      },
      details,
    );
  }
}

export class ExchangeNetworkError extends ExchangeError {
  constructor(details?: IntegrationErrorDetails) {
    super({ name: 'ExchangeNetworkError', code: 'exchange_network', retryable: true }, details);
  }
}

export interface ExchangeReasonDetails extends IntegrationErrorDetails {
  /** A lower-case word such as `invalid_next_link` or `paging_window_exceeded`. */
  readonly reason?: string;
  /** For "other 4xx": 400 to 499. */
  readonly status?: number;
}

/** Other 4xx, an unreadable envelope, a next link that was refused, a paging window that ran out. */
export class ExchangeUnavailableError extends ExchangeError {
  readonly reason: string;

  constructor(details?: ExchangeReasonDetails) {
    super(
      {
        name: 'ExchangeUnavailableError',
        code: 'exchange_unavailable',
        retryable: false,
        ...optionalStatus(pickStatus(read(details, 'status'), 400, 499)),
      },
      details,
    );
    this.reason = pickReason(details, 'unavailable');
  }

  protected override extraJson(): Record<string, string> {
    return { reason: this.reason };
  }
}

/** Client side: an endpoint or cmdlet the adapter does not allow. Nothing was sent. */
export class ExchangeUnsupportedError extends ExchangeError {
  readonly reason: string;

  constructor(details?: Pick<ExchangeReasonDetails, 'reason'>) {
    super({ name: 'ExchangeUnsupportedError', code: 'exchange_unsupported', retryable: false });
    this.reason = pickReason(details, 'unsupported');
  }

  protected override extraJson(): Record<string, string> {
    return { reason: this.reason };
  }
}

/**
 * The closed list of reasons a cmdlet call fails, as the worker protocol states them
 * (`EXCHANGE_ERROR_CODES` in `@m365portal/shared/exchange/protocol`; a test pins that the two lists
 * are equal). The ports import nothing, so the list is written out here too.
 */
export const EXCHANGE_COMMAND_CODES = [
  'not_found',
  'already_exists',
  'already_member',
  'not_a_member',
  'member_type_not_allowed',
  'permission_denied',
  'manager_check',
  'read_only_object',
  'throttled',
  'timeout',
  'invalid_argument',
  'not_connected',
  'role_pending',
  'internal',
] as const;
export type ExchangeCommandCode = (typeof EXCHANGE_COMMAND_CODES)[number];

/**
 * A cmdlet ran (or was refused before it ran) and Exchange said no for a reason in the closed list
 * (Phase D, FR-D-105). Carries the code and `Retry-After`, never a message: Exchange's own text can
 * hold a name or an address (FR-D-107). `throttled` and `timeout` are the retryable ones.
 */
export class ExchangeCommandError extends ExchangeError {
  readonly commandCode: ExchangeCommandCode;

  constructor(
    commandCode: ExchangeCommandCode,
    details?: Pick<IntegrationErrorDetails, 'retryAfterMs'>,
  ) {
    super(
      {
        name: 'ExchangeCommandError',
        code: 'exchange_command',
        retryable: commandCode === 'throttled' || commandCode === 'timeout',
      },
      details,
    );
    this.commandCode = (EXCHANGE_COMMAND_CODES as readonly string[]).includes(commandCode)
      ? commandCode
      : 'internal';
  }

  protected override extraJson(): Record<string, string> {
    return { commandCode: this.commandCode };
  }
}

function optionalStatus(status: number | undefined): { status?: number } {
  return status === undefined ? {} : { status };
}

// ---------------------------------------------------------------------------------------------
// Identity (token endpoint, ID-token validator, device code, secrets, registry)
// ---------------------------------------------------------------------------------------------

export interface TokenEndpointDetails extends IntegrationErrorDetails {
  /** The OAuth `error` string, such as `invalid_client`. Anything else is stored as `unknown`. */
  readonly error?: string;
  readonly status?: number;
}

/** The token endpoint answered with an error. Only the error string and the AADSTS number are kept. */
export class TokenEndpointError extends IntegrationError {
  readonly error: string;

  constructor(details?: TokenEndpointDetails) {
    const error = pickMatching(read(details, 'error'), WORD) ?? 'unknown';
    super(
      {
        name: 'TokenEndpointError',
        code: 'token_endpoint_error',
        // `temporarily_unavailable` is retried once after 1 s by the sign-in exchange (FR-B-403).
        retryable: error === 'temporarily_unavailable',
        ...optionalStatus(pickStatus(read(details, 'status'), 100, 599)),
      },
      details,
    );
    this.error = error;
  }

  protected override extraJson(): Record<string, string> {
    return { error: this.error };
  }
}

/** The checks of the ID-token validator, in the names of Appendix C of the spec (SB-08). */
export const ID_TOKEN_CHECKS = Object.freeze([
  'size',
  'format',
  'header',
  'alg',
  'tenant',
  'issuer',
  'kid',
  'signature',
  'expired',
  'not_before',
  'audience',
  'issued_at',
  'version',
  'oid',
  'nonce',
  'keys_unavailable',
] as const);
export type IdTokenCheck = (typeof ID_TOKEN_CHECKS)[number];

export class IdTokenError extends IntegrationError {
  readonly check: IdTokenCheck;

  constructor(details: { readonly check: IdTokenCheck }) {
    const check = read(details, 'check');
    if (typeof check !== 'string' || !(ID_TOKEN_CHECKS as readonly string[]).includes(check)) {
      throw new TypeError('not an id token check');
    }
    super({
      name: 'IdTokenError',
      code: 'id_token_invalid',
      // The key endpoint could not be reached on a cold start: sign-in works again once it can.
      retryable: check === 'keys_unavailable',
    });
    this.check = check as IdTokenCheck;
  }

  protected override extraJson(): Record<string, string> {
    return { check: this.check };
  }
}

export const DEVICE_CODE_KINDS = Object.freeze([
  'expired',
  'declined',
  'cancelled',
  'blocked',
  'bad_code',
  'failed',
] as const);
export type DeviceCodeKind = (typeof DEVICE_CODE_KINDS)[number];

export class DeviceCodeError extends IntegrationError {
  readonly kind: DeviceCodeKind;

  constructor(details: { readonly kind: DeviceCodeKind; readonly aadsts?: number | string }) {
    const kind = read(details, 'kind');
    if (typeof kind !== 'string' || !(DEVICE_CODE_KINDS as readonly string[]).includes(kind)) {
      throw new TypeError('not a device code kind');
    }
    super({ name: 'DeviceCodeError', code: 'device_code_failed', retryable: false }, details);
    this.kind = kind as DeviceCodeKind;
  }

  protected override extraJson(): Record<string, string> {
    return { kind: this.kind };
  }
}

/** Why the application key or the certificate cannot be used (FR-B-108). */
export const SECRETS_UNAVAILABLE_REASONS = Object.freeze([
  'app_key_missing',
  'app_key_invalid',
  'certificate_unreadable',
  'no_certificate',
] as const);
export type SecretsUnavailableReason = (typeof SECRETS_UNAVAILABLE_REASONS)[number];

export class SecretsUnavailableError extends IntegrationError {
  readonly reason: SecretsUnavailableReason;

  constructor(details: { readonly reason: SecretsUnavailableReason }) {
    const reason = read(details, 'reason');
    if (
      typeof reason !== 'string' ||
      !(SECRETS_UNAVAILABLE_REASONS as readonly string[]).includes(reason)
    ) {
      throw new TypeError('not a secrets unavailable reason');
    }
    super({ name: 'SecretsUnavailableError', code: 'secrets_unavailable', retryable: false });
    this.reason = reason as SecretsUnavailableReason;
  }

  protected override extraJson(): Record<string, string> {
    return { reason: this.reason };
  }
}

/** No tenant is connected (setup not complete, or no bootstrap session). */
export class NotConnectedError extends IntegrationError {
  constructor(details?: IntegrationErrorDetails) {
    super({ name: 'NotConnectedError', code: 'not_connected', retryable: false }, details);
  }
}
