// The responses Node writes itself (FR-A-040, plan 8.1): a request the HTTP parser rejects never
// reaches the Hono pipeline, so Node answers it with a bare `400`, `408` or `431`. With a
// `clientError` listener installed Node writes nothing, and this one answers with the same shape as
// every other error: `application/problem+json`, the `other` security-header profile, `no-store`,
// an `X-Request-Id`, `Connection: close`. It never echoes the request (the parser error is dropped).
//
// There is no `Strict-Transport-Security` here: the scheme is decided by the trust-proxy rule from
// a request that was never parsed, so none can be named, and HSTS is not sent over a guess.
//
// `bad_request` and `request_header_fields_too_large` are not in the problem registry (31 codes,
// contract section 6); the registry is a frozen contract, so the amendment is an open point.
import type { Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { PROBLEM_CONTENT_TYPE } from './problem.js';
import { PROBLEM_TYPE_PREFIX } from '@m365portal/shared/problem';
import { CACHE_CONTROL } from './cache-headers.js';
import { headersForProfile } from './security-headers.js';
import { generateRequestId } from './request-context.js';

interface ParserFailure {
  readonly status: 400 | 408 | 431;
  readonly reason: string;
  readonly code: string;
  readonly title: string;
  readonly detail: string;
}

const BAD_REQUEST: ParserFailure = {
  status: 400,
  reason: 'Bad Request',
  code: 'bad_request',
  title: 'Bad request',
  detail: 'The request could not be parsed.',
};
const TOO_LARGE: ParserFailure = {
  status: 431,
  reason: 'Request Header Fields Too Large',
  code: 'request_header_fields_too_large',
  title: 'Request header fields too large',
  detail: 'The request line or the headers are larger than the limit.',
};
const TIMEOUT: ParserFailure = {
  status: 408,
  reason: 'Request Timeout',
  code: 'request_timeout',
  title: 'Request timeout',
  detail: 'The request was not received in time.',
};

/** Which answer a parser error gets; the same mapping Node's own default uses. */
function failureOf(error: unknown): ParserFailure {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'HPE_HEADER_OVERFLOW') return TOO_LARGE;
  if (code === 'ERR_HTTP_REQUEST_TIMEOUT') return TIMEOUT;
  return BAD_REQUEST;
}

/** The complete response, as bytes. Pure apart from the request id. */
export function clientErrorResponse(error: unknown, requestId = generateRequestId()): string {
  const failure = failureOf(error);
  const body = JSON.stringify({
    type: `${PROBLEM_TYPE_PREFIX}${failure.code}`,
    title: failure.title,
    status: failure.status,
    detail: failure.detail,
    code: failure.code,
    requestId,
  });
  const headers: Record<string, string> = {
    'Content-Type': PROBLEM_CONTENT_TYPE,
    'Content-Length': String(Buffer.byteLength(body)),
    'Cache-Control': CACHE_CONTROL.noStore,
    'X-Request-Id': requestId,
    ...headersForProfile({ profile: 'other', nonce: undefined, https: false }),
    Connection: 'close',
  };
  const lines = Object.entries(headers).map(([name, value]) => `${name}: ${value}`);
  return `HTTP/1.1 ${String(failure.status)} ${failure.reason}\r\n${lines.join('\r\n')}\r\n\r\n${body}`;
}

/** Write the answer and close, unless the socket is gone or a response already began. */
export function answerClientError(error: unknown, socket: Duplex): void {
  const written = (socket as { bytesWritten?: number }).bytesWritten ?? 0;
  if (!socket.writable || socket.destroyed || written > 0) {
    socket.destroy();
    return;
  }
  socket.end(clientErrorResponse(error));
}

/** Install the listener on the server. Without it Node answers with a bare status line. */
export function installClientErrorHandler(server: Pick<Server, 'on'>): void {
  server.on('clientError', answerClientError);
}
