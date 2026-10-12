import { safeReturnTo } from '@m365portal/shared/auth/return-to';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { SignInPage } from '../features/auth/SignInPage';
import { loadLazyNamespace } from '../lib/locale';
import { stringSearchParam } from '../lib/search';

// /signin (FR-B-607): public. `?error=` and `?returnTo=` are text from outside and are validated by the
// page (`resolveSigninError`, `safeReturnTo`); a visitor who already has a session is sent on to
// `returnTo` before the page renders (FR-B-402), so a hostile value lands on `/`. The exception is an
// error: a person who is signed in and whose step-up failed (FR-B-411) keeps their session and must be
// told why, so a page with `?error=` is rendered for them too (an unknown value shows the generic text).
export interface SignInSearch {
  readonly error?: string;
  readonly returnTo?: string;
  readonly signedout?: string;
}

export const Route = createFileRoute('/signin')({
  staticData: { titleKey: 'signin.title' },
  validateSearch: (search: Record<string, unknown>): SignInSearch => {
    const error = stringSearchParam(search.error);
    const returnTo = stringSearchParam(search.returnTo);
    const signedout = stringSearchParam(search.signedout);
    return {
      ...(error === undefined ? {} : { error }),
      ...(returnTo === undefined ? {} : { returnTo }),
      ...(signedout === undefined ? {} : { signedout }),
    };
  },
  beforeLoad: ({ context, search }) => {
    if (context.me.actor.kind !== 'anonymous' && search.error === undefined) {
      // `href` is a path that `safeReturnTo` accepted: this origin, no `//`, no backslash, no scheme.
      redirect({ href: safeReturnTo(search.returnTo), replace: true, throw: true });
    }
  },
  // The sign-in text is a lazy catalogue: only this page shows it (T-B-307).
  loader: async () => {
    await loadLazyNamespace('signin');
  },
  component: SignInPage,
});
