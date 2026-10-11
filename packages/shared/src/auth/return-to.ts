// `safeReturnTo`: the one function that decides where a sign-in may land (tasks T-B-180, FR-B-402,
// EB-17, F-43; baseline section 10, one implementation per concept).
//
// The server runs it when `GET /auth/login` creates a login transaction, so an unsanitised value is
// never stored or echoed in a redirect. The web sign-in page runs the same function on the
// `returnTo` it reads from its own URL before it navigates (the page is public, and a hostile link
// can put anything there). A value is kept only when it names a path of this origin; everything
// else, including a value that is not a string, becomes `/`.
import { LIMITS } from '../limits.js';

/** Where a sign-in lands when the requested target is not acceptable. */
export const RETURN_TO_DEFAULT = '/';

/** At most this many characters (`RETURN_TO_MAX_CHARS`, FR-B-402). */
export const RETURN_TO_MAX_CHARS: number = LIMITS.signIn.returnToMaxChars;

// A control character (any `Cc`: C0, DEL and C1) or a Unicode line or paragraph separator. These
// split a header line or confuse a log line; none belongs in a path.
const CONTROL = /\p{Cc}|[\u2028\u2029]/u;

// The prefixes a sign-in must never land on: the JSON API and the setup wizard (FR-B-402). The
// comparison ignores case, which only ever rejects more.
const FORBIDDEN_PREFIX = /^\/(?:api\/|setup)/i;

/**
 * One round of percent-decoding that tolerates malformed sequences (a malformed `%zz` stays as it
 * is, so it cannot make the decode throw and skip the checks). The decoded form is checked as well,
 * because a hop in front of the app may decode `%2f` or `%5c` before a browser sees the target.
 */
function percentDecoded(value: string): string {
  return value.replace(/%[0-9a-f]{2}/gi, (match) =>
    String.fromCharCode(parseInt(match.slice(1), 16)),
  );
}

function isRelativeSlashPath(text: string): boolean {
  // Starts with a single `/` (so no scheme and no authority can come first), contains no `//` and
  // no backslash (browsers read `\` as `/`), and no control character.
  return (
    text.startsWith('/') && !text.includes('//') && !text.includes('\\') && !CONTROL.test(text)
  );
}

/**
 * The value when it is a safe same-origin path, else `/`:
 *   - a string of at most 256 characters that starts with a single `/`;
 *   - no `//`, no `\`, no control character and no scheme, also after one round of percent-decoding;
 *   - not beginning with `/api/` or `/setup`.
 */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string') return RETURN_TO_DEFAULT;
  if (value.length === 0 || value.length > RETURN_TO_MAX_CHARS) return RETURN_TO_DEFAULT;
  if (!isRelativeSlashPath(value)) return RETURN_TO_DEFAULT;
  if (FORBIDDEN_PREFIX.test(value)) return RETURN_TO_DEFAULT;
  const decoded = percentDecoded(value);
  if (!isRelativeSlashPath(decoded) || FORBIDDEN_PREFIX.test(decoded)) return RETURN_TO_DEFAULT;
  return value;
}
