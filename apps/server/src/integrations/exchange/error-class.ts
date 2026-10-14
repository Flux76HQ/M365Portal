// From the answer of a failed `InvokeCommand` call to ONE code of the closed list (`EXCHANGE_COMMAND_CODES`,
// FR-D-107). The answer of Exchange carries a message that can hold a name, an address or a tenant id: it is read
// here with fixed patterns, a code comes out, and the text is dropped. The patterns are those the `pwsh`
// worker used on the PowerShell error record (ADR 0181), so a fault means the same as before.
import type { ExchangeCommandCode } from '../../ports/errors.js';

const TEXT_MAX = 4096;

/** The strings of an OData error body (`code`, `message`, nested `innererror`/`details`), joined and cut. */
export function errorTextOf(body: unknown): string {
  const parts: string[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (parts.join(' ').length >= TEXT_MAX || depth > 4) return;
    if (typeof value === 'string') parts.push(value);
    else if (Array.isArray(value)) for (const item of value) visit(item, depth + 1);
    else if (typeof value === 'object' && value !== null) {
      for (const item of Object.values(value)) visit(item, depth + 1);
    }
  };
  const error = (body as { error?: unknown } | null)?.error;
  visit(error ?? body, 0);
  return parts.join(' ').slice(0, TEXT_MAX);
}

const RULES: readonly (readonly [RegExp, ExchangeCommandCode])[] = [
  [/synchroniz[ei]d? from your on-premises|being synchronized/i, 'read_only_object'],
  [/manager of the group|only be performed by a manager|not a manager/i, 'manager_check'],
  [/is already a member|MemberAlreadyExists|already a member of the group/i, 'already_member'],
  [/isn't a member|is not a member|MemberNotFound|not a member of the group/i, 'not_a_member'],
  [
    /isn't a supported member|not a supported member|isn't supported as a member|unsupported member/i,
    'member_type_not_allowed',
  ],
  [/throttl|too many requests|rate limit/i, 'throttled'],
  [
    /already exists|already being used|is already in use|ManagementObjectAlreadyExists|proxy address .* already/i,
    'already_exists',
  ],
  [
    /couldn't be found|could not be found|was not found|ManagementObjectNotFound|ObjectNotFound|RecipientNotFound/i,
    'not_found',
  ],
  [/is not recognized as the name of a cmdlet|CommandNotFound/i, 'role_pending'],
  [/timed out|TaskCanceledException|TimeoutException|operation was canceled/i, 'timeout'],
  [
    /access is denied|insufficient (access|permission|privilege)|not (assigned|authorized)|unauthorized|forbidden|AADSTS|authentication failed|isn.t assigned to any management roles/i,
    'permission_denied',
  ],
  [
    /ParameterBinding|ValidationMetadata|cannot validate argument|parameter cannot be found|cannot bind|invalid (parameter|argument)/i,
    'invalid_argument',
  ],
];

/** The code for a failed call: the patterns first, then the HTTP status, else `internal`. */
export function classifyCommandError(status: number, text: string): ExchangeCommandCode {
  for (const [pattern, code] of RULES) if (pattern.test(text)) return code;
  if (status === 401 || status === 403) return 'permission_denied';
  if (status === 404) return 'not_found';
  if (status === 408 || status === 504) return 'timeout';
  return 'internal';
}
