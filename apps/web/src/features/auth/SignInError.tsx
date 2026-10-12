import {
  SIGNIN_CONSENT_LINK_CODES,
  signinErrorMessageKey,
  signinErrorRemedyKey,
  type SigninErrorCode,
} from '@m365portal/shared/auth/signin-errors';
import type { MessageKey } from '@m365portal/shared/i18n';
import { CircleAlertIcon } from 'lucide-react';
import { useTranslator } from '../../lib/locale';

export interface SignInErrorProps {
  /** An allow-listed code (`resolveSigninError` has been applied). */
  readonly code: SigninErrorCode;
  /** `MeResponse.adminConsentUrl`: non-null only when a tenant is pinned (TB-14). */
  readonly adminConsentUrl: string | null;
}

/** The consent link is shown next to these two codes only (FR-B-419). */
function wantsConsentLink(code: SigninErrorCode): boolean {
  return (SIGNIN_CONSENT_LINK_CODES as readonly string[]).includes(code);
}

/**
 * The explanation of a failed sign-in and what to do about it, from the catalogue of the code. The text
 * is the panel's own: the page never shows what Microsoft or the server wrote (FR-B-603). It is an alert,
 * so assistive technology announces it when the page opens. For `consent_required` and
 * `admin_approval_required` an administrator's consent link follows when the server has one; it leads to
 * Microsoft (a top-level navigation, never a `fetch`).
 */
export function SignInError({ code, adminConsentUrl }: SignInErrorProps) {
  const { t } = useTranslator();
  // The message keys are built from the registry; `MessageKey` checks that every code has a message.
  const message = t(signinErrorMessageKey(code) as MessageKey);
  const remedy = t(signinErrorRemedyKey(code) as MessageKey);
  const link = wantsConsentLink(code) && adminConsentUrl !== null ? adminConsentUrl : null;
  return (
    <div
      role="alert"
      data-slot="signin-error"
      data-code={code}
      className="flex items-start gap-3 rounded-lg border border-s-4 border-line-subtle border-s-danger bg-surface-raised p-4 text-body"
    >
      <CircleAlertIcon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-danger" />
      <div className="flex min-w-0 flex-col gap-2">
        <p className="font-semibold text-fg">{message}</p>
        <p className="text-fg-secondary">
          <span className="sr-only">{t('signin.whatYouCanDo')}: </span>
          {remedy}
        </p>
        {link === null ? null : (
          <div className="flex flex-col gap-1 border-t border-line-subtle pt-2">
            <p className="font-semibold text-fg">{t('signin.consent.heading')}</p>
            <p className="text-fg-secondary">{t('signin.consent.message')}</p>
            <a
              href={link}
              rel="noopener noreferrer"
              className="inline-flex min-h-target w-fit items-center rounded-sm text-accent-text underline underline-offset-4 hover:bg-accent-subtle"
            >
              {t('signin.consent.link')}
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
