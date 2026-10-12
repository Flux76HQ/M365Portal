// The panel's cookies as the browser sent them (FR-B-401, FR-B-408): the session cookie and the setup
// cookie, read from the `Cookie` header by exact name. Used by the CSRF binding (which must not touch
// the database) and by the resolvers. Two cookies of the same name in one request count as absent: a
// request that carries two sessions cannot be told which one the browser meant, so it is treated as
// carrying none (fail closed; the resolvers log `cookie_duplicate` once).
//
// The reader does not judge the value: a value that is not a session id is still a value, and the
// binding hashes whatever was sent. Whether a session exists for it is the resolver's question.
import type { CookieKind } from '@m365portal/shared/auth/cookies';

/** The names of the two cookies this reader looks for (`cookieNames()` of the shared package). */
export interface PanelCookieNames {
  readonly session: string;
  readonly setup: string;
}

export interface PanelCookies {
  readonly session: string | undefined;
  readonly setup: string | undefined;
  /** The cookies that appeared more than once. */
  readonly duplicates: readonly Extract<CookieKind, 'session' | 'setup'>[];
}

export function readPanelCookies(
  header: string | null | undefined,
  names: PanelCookieNames,
): PanelCookies {
  const found: Record<'session' | 'setup', string[]> = { session: [], setup: [] };
  if (header !== null && header !== undefined) {
    for (const pair of header.split(';')) {
      const separator = pair.indexOf('=');
      if (separator <= 0) continue;
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      if (name === names.session) found.session.push(value);
      else if (name === names.setup) found.setup.push(value);
    }
  }
  const duplicates: ('session' | 'setup')[] = [];
  const one = (kind: 'session' | 'setup'): string | undefined => {
    const values = found[kind];
    if (values.length > 1) duplicates.push(kind);
    return values.length === 1 && values[0] !== '' ? values[0] : undefined;
  };
  const session = one('session');
  const setup = one('setup');
  return { session, setup, duplicates };
}
