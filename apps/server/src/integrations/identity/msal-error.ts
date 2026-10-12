// What the identity code reads of an MSAL error (T-B-075, T-B-076). The wording of MSAL's messages is
// a property of the pinned library version, not of Microsoft Learn (U60); `msal-app-token.test.ts` and
// `bootstrap.test.ts` fail when a new version words them differently. MSAL's messages carry Microsoft's
// free text, so only a code and a number are taken from them; nothing else is kept (SB-05).
//
// MSAL Node 7.0.1 words a `ServerError` as `Error(s): <codes> - Timestamp: ... - Description: <text>`;
// the leading digits are the first error number (an AADSTS number). A failure while polling the
// device code is `post_request_failed` with the OAuth error string (`authorization_declined`, ...) as
// its message; nothing else of the answer, not even the description, survives in MSAL's error.
const LEADING_CODE = /^Error\(s\): (\d{4,7})(?!\d)/;

/** The first error number MSAL put in front of its message; the text after it is never read. */
export function aadstsOfMsal(message: unknown): number | undefined {
  if (typeof message !== 'string') return undefined;
  const head = message.slice(0, 40);
  if (!LEADING_CODE.test(head)) return undefined;
  return Number(head.slice('Error(s): '.length).split(/\D/, 1)[0]);
}

export interface MsalErrorFields {
  /** `errorCode` of the MSAL error (an OAuth error string for a server error). */
  readonly code: string;
  /** For a failed device-code poll (`post_request_failed`), the OAuth error string. */
  readonly sub: string;
  readonly aadsts: number | undefined;
}

const WORD = /^[a-z][a-z_]{0,63}$/;

export function msalErrorFields(failure: unknown): MsalErrorFields {
  const fields = failure as {
    errorCode?: unknown;
    subError?: unknown;
    errorMessage?: unknown;
  } | null;
  const word = (value: unknown): string =>
    typeof value === 'string' && WORD.test(value) ? value : '';
  const code = word(fields?.errorCode);
  return {
    code,
    sub:
      word(fields?.subError) || (code === 'post_request_failed' ? word(fields?.errorMessage) : ''),
    aadsts: aadstsOfMsal(fields?.errorMessage),
  };
}
