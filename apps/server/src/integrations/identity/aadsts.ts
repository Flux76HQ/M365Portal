// The error of a token-endpoint answer, reduced to what the product may keep (T-B-079, FR-B-217, SB-05).
//
// An answer is `{"error": "invalid_client", "error_description": "AADSTS700027: ... Trace ID: ..."}`
// (Learn, v2-oauth2-auth-code-flow, "Error response"). The OAuth `error` string is kept when it has the
// shape of one; the number is the `AADSTS` number the description STARTS with, read by the strict
// pattern of the shared map (`extractAadsts`: four to seven digits, at the start, not followed by
// another digit). The rest of the description is Microsoft's free text: never kept, never logged,
// never shown.
import { extractAadsts } from '@m365portal/shared/auth/aadsts-map';

const OAUTH_ERROR = /^[a-z][a-z_]{0,63}$/;

export interface TokenErrorFields {
  readonly error: string;
  readonly aadsts?: number;
}

export function tokenErrorOf(body: unknown): TokenErrorFields {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { error: 'unknown' };
  const fields = body as { error?: unknown; error_description?: unknown };
  const error =
    typeof fields.error === 'string' && OAUTH_ERROR.test(fields.error) ? fields.error : 'unknown';
  const aadsts = extractAadsts(fields.error_description);
  return aadsts === null ? { error } : { error, aadsts };
}
