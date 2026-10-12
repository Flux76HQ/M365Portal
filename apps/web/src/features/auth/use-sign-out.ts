// Signing out (T-B-298; FR-B-410, FR-B-606; plan 12.3, 12.4). The page calls `POST /api/v1/auth/logout`
// (or `logout-all`) with `fetch` on its own origin; the server ends the session first and answers
// `{redirect}`. The page then navigates to that address, and only when `checkedLogoutRedirect` accepts it:
// the Entra sign-out page or `/signin?signedout=1`. A failure is said in words (the message of the
// problem, never the server's text) and the person stays where they are.
import { useCallback } from 'react';
import { useToast } from '../../components/ui/toast';
import { ApiError } from '../../lib/api';
import { useTranslator } from '../../lib/locale';
import { checkedLogoutRedirect } from '../../lib/ms-url';
import { messageForError } from '../../lib/problem';
import { useMe, useRouterContext } from '../../lib/router-context';
import { useAuthRuntime } from './runtime';

const PATHS = {
  one: '/api/v1/auth/logout',
  everywhere: '/api/v1/auth/logout-all',
} as const;

/** The answer of both routes: `{redirect}` (logout-all also counts the sessions it ended). */
function redirectOf(value: unknown): string {
  if (typeof value === 'object' && value !== null && 'redirect' in value) {
    const redirect = value.redirect;
    if (typeof redirect === 'string') return redirect;
  }
  throw new Error('not a sign-out answer');
}

export function useSignOut(): (everywhere: boolean) => Promise<void> {
  const { api } = useRouterContext();
  const { store, location } = useAuthRuntime();
  const { toast } = useToast();
  const translator = useTranslator();
  const me = useMe();
  return useCallback(
    async (everywhere: boolean) => {
      try {
        const answer = await api.post(PATHS[everywhere ? 'everywhere' : 'one'], {
          body: {},
          schema: { parse: redirectOf },
        });
        const target = checkedLogoutRedirect(answer);
        if (target === null) {
          throw new ApiError({
            code: 'invalid_response',
            status: 200,
            requestId: null,
            errors: [],
            expectedOrigin: null,
            retryAfterSeconds: null,
          });
        }
        store.reset();
        location.assign(target);
      } catch (error) {
        toast({
          tone: 'error',
          title: translator.t('session.menu.signOutFailed'),
          description: messageForError(translator, error, { publicOrigin: me.publicOrigin }),
        });
      }
    },
    [api, location, me.publicOrigin, store, toast, translator],
  );
}
