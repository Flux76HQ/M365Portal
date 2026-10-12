// The boot re-check of the session (T-B-296; PB-15, FR-B-413 web half, RB-11; plan 12.2).
//
// The server embeds the real `MeResponse` in the HTML shell. A navigation that starts on another site (a
// link in mail or chat) does not carry the `SameSite=Strict` session cookie, so the shell is rendered for
// an anonymous actor although the person has a session. Keeping `Strict` (brief section 6) means the
// client must ask once more, from the page, where the cookie is sent: when the embedded actor is
// anonymous and the setup is not `unconfigured` (before the first sign-in nobody has a session), it sends
// ONE same-origin `GET /api/v1/me` before any gating redirect.
//   - A signed-in answer replaces the boot data, so the first paint shows the persona and not a flash of
//     the signed-out shell.
//   - An anonymous answer goes on to the gate (`/signin?returnTo=`).
//   - The wait is capped at 800 ms; the static shell of index.html is on screen meanwhile. An answer that
//     comes later is still applied when it is a signed-in one: the sign-in page sends a visitor who has a
//     session on to `returnTo`.
// No other request is made: a signed-in boot actor, a setup actor, a break-glass actor and an
// unconfigured installation skip the check.
import { MeResponseSchema } from '@m365portal/shared/schemas/meta';
import type { QueryClient } from '@tanstack/react-query';
import { getSessionStore, type SessionStore } from '../features/auth/session-store';
import type { ApiClient } from '../lib/api';
import type { BootData, MeResponse } from '../lib/boot-data';
import { queryKeys } from '../lib/query';

/** How long the start-up waits for the answer. */
export const RECHECK_CAP_MS = 800;

export type RecheckOutcome =
  | { readonly outcome: 'skipped' }
  | { readonly outcome: 'signed_in' }
  | { readonly outcome: 'anonymous' }
  | { readonly outcome: 'failed' }
  | { readonly outcome: 'timeout' };

export interface RecheckOptions {
  /** The parsed boot data, or null when the block is missing or malformed (read as an anonymous boot actor). */
  readonly boot: BootData | null;
  readonly queryClient: QueryClient;
  readonly api: ApiClient;
  /** Defaults to the store of the page. */
  readonly store?: SessionStore;
  readonly capMs?: number;
}

/** Does the boot data call for the check? */
export function needsRecheck(boot: BootData | null): boolean {
  if (boot === null) return true;
  return boot.me.actor.kind === 'anonymous' && boot.me.setup.state !== 'unconfigured';
}

export async function recheckBootSession(options: RecheckOptions): Promise<RecheckOutcome> {
  const { boot, queryClient, api } = options;
  const store = options.store ?? getSessionStore();
  const cap = options.capMs ?? RECHECK_CAP_MS;

  if (boot !== null) store.noteMeSession(boot.me.session);
  if (!needsRecheck(boot)) return { outcome: 'skipped' };

  /** Puts a fresh answer where the app reads it. Signed-in answers always; anonymous ones only without boot data. */
  function apply(me: MeResponse): void {
    if (me.actor.kind === 'anonymous' && boot !== null) return;
    queryClient.setQueryData(queryKeys.me, me);
    store.noteMeSession(me.session);
    api.observeVersion(me.version);
  }

  const answer = api
    .get('/api/v1/me', { schema: MeResponseSchema })
    .then(
      (me): RecheckOutcome => {
        apply(me);
        return { outcome: me.actor.kind === 'anonymous' ? 'anonymous' : 'signed_in' };
      },
      (): RecheckOutcome => ({ outcome: 'failed' }),
    );

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<RecheckOutcome>((resolve) => {
    timer = setTimeout(() => {
      resolve({ outcome: 'timeout' });
    }, cap);
  });
  try {
    return await Promise.race([answer, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
