import { resolveSigninError, type SigninErrorCode } from '@m365portal/shared/auth/signin-errors';
import { getRouteApi } from '@tanstack/react-router';
import { InfoIcon, LogInIcon } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { loginUrl } from '../../lib/auth-nav';
import { useTranslator } from '../../lib/locale';
import { useBranding, useMe } from '../../lib/router-context';
import { PublicPage } from './PublicPage';
import { SignInError } from './SignInError';

const route = getRouteApi('/signin');

/**
 * /signin (FR-B-607, FR-B-217, FR-B-419; plan 12.1): the organisation mark and name, one link that starts
 * the sign-in at Microsoft, the explanation and remedy of an error code from the address, the signed-out
 * notice, and the administrator's consent link next to the two consent codes.
 *
 * Every action is a link to `/auth/login` (a top-level navigation answered by a 303; never a `fetch`,
 * FR-B-606). "Sign in again" asks Microsoft for a fresh sign-in (`prompt=login`) and "Use another
 * account" lets the person pick one (`prompt=select_account`); neither repeats by itself.
 */
export function SignInPage() {
  const { t } = useTranslator();
  const me = useMe();
  const branding = useBranding();
  const search = route.useSearch();
  const { returnTo } = search;

  const hasError = search.error !== undefined;
  const code: SigninErrorCode | null = hasError ? resolveSigninError(search.error) : null;
  const signedOut = search.signedout === '1' && !hasError;
  const name = branding?.orgName ?? '';

  return (
    <PublicPage title={t('signin.heading', { name })} icon={<LogInIcon />}>
      {signedOut ? (
        <div
          role="status"
          data-slot="signed-out"
          className="flex items-start gap-3 rounded-lg border border-s-4 border-line-subtle border-s-info bg-surface-raised p-4 text-body"
        >
          <InfoIcon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-info" />
          <div className="flex flex-col gap-1">
            <p className="font-semibold text-fg">{t('signin.signedOut.title')}</p>
            <p className="text-fg-secondary">{t('signin.signedOut.message')}</p>
          </div>
        </div>
      ) : null}
      {code === null ? (
        <p className="text-body text-fg-secondary">{t('signin.intro')}</p>
      ) : (
        <SignInError code={code} adminConsentUrl={me.adminConsentUrl} />
      )}
      <div className="flex flex-wrap gap-2">
        {code === null ? (
          <Button asChild variant="primary">
            <a href={loginUrl(returnTo === undefined ? {} : { returnTo })}>
              {t('signin.action.signIn')}
            </a>
          </Button>
        ) : (
          <>
            <Button asChild variant="primary">
              <a
                href={loginUrl({
                  prompt: 'login',
                  ...(returnTo === undefined ? {} : { returnTo }),
                })}
              >
                {t('signin.action.again')}
              </a>
            </Button>
            <Button asChild variant="secondary">
              <a
                href={loginUrl({
                  prompt: 'select_account',
                  ...(returnTo === undefined ? {} : { returnTo }),
                })}
              >
                {t('signin.action.otherAccount')}
              </a>
            </Button>
          </>
        )}
        {code === 'setup_required' ? (
          <Button asChild variant="secondary">
            <a href="/setup">{t('signin.action.openSetup')}</a>
          </Button>
        ) : null}
      </div>
    </PublicPage>
  );
}
