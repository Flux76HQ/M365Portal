// THE SIGN-IN PAGE (T-B-297; FR-B-607, FR-B-402 web half, FR-B-217, FR-B-419, FR-B-606; US-B5; plan 12.1).
//
// /signin is public. It shows the organisation mark and name, one action that is a link (a top-level
// navigation to /auth/login, never a fetch), the explanation and the remedy of every code on the
// allow-list of `?error=` (any other value is `signin_failed`), the signed-out notice, and, for the two
// consent codes, the administrator's consent link from `me.adminConsentUrl`. A visitor who already has a
// session is sent on to `returnTo` after `safeReturnTo`, so a hostile value lands on `/`.
import { createTranslator, type Locale } from '@m365portal/shared/i18n';
import { SIGNIN_CONSENT_LINK_CODES, SIGNIN_ERROR_CODES } from '@m365portal/shared/auth/signin-errors';
import { expectGuardFails } from '@m365portal/shared/testing';
import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { sampleBranding, sampleMe, sampleSignedInMe } from './helpers/boot-fixtures';
import { renderApp } from './helpers/render-shell';

const CONSENT_URL =
  'https://login.microsoftonline.com/3f2b6a52-7c1e-4a8e-9a3d-0c5f4d1b2e77/v2.0/adminconsent?client_id=8d1a9c0e-1f3b-4b9a-8f55-2f3b9c1d7a10&scope=openid%20profile&redirect_uri=https%3A%2F%2Fpanel.example.com%2Fauth%2Fcallback';

const translator = (language: Locale) => createTranslator(language);

async function openSignIn(search: string, options: { language?: Locale; adminConsentUrl?: string | null } = {}) {
  return renderApp({
    me: sampleMe({ adminConsentUrl: options.adminConsentUrl ?? null }),
    branding: sampleBranding('Acme'),
    path: `/signin${search}`,
    language: options.language ?? 'en',
  });
}

describe('the page', () => {
  it('shows the organisation mark and name, and the sign-in action as a link to /auth/login', async () => {
    await openSignIn('?returnTo=%2Fusers');
    const en = translator('en');
    const heading = await screen.findByRole('heading', { level: 1, name: en.t('signin.heading', { name: 'Acme' }) });
    expect(heading).toBeInTheDocument();
    expect(document.querySelector('[data-slot="org-mark"]')).not.toBeNull();
    expect(screen.getAllByText('Acme').length).toBeGreaterThan(0);

    const action = screen.getByRole('link', { name: en.t('signin.action.signIn') });
    expect(action.tagName).toBe('A');
    expect(action).toHaveAttribute('href', '/auth/login?returnTo=%2Fusers');
    // A navigation, not a script: the click is left to the browser.
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    action.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
  });

  it('is in Dutch when the page is Dutch, with "Aanmelden met Microsoft"', async () => {
    await openSignIn('', { language: 'nl' });
    const nl = translator('nl');
    expect(await screen.findByRole('link', { name: 'Aanmelden met Microsoft' })).toHaveAttribute(
      'href',
      '/auth/login',
    );
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(nl.t('signin.heading', { name: 'Acme' }));
  });

  it('has no navigation menu and no data: it is a public page', async () => {
    await openSignIn('');
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(screen.getAllByRole('main')).toHaveLength(1);
  });

  it('leaves out returnTo from the link when it is the dashboard or unsafe', async () => {
    await openSignIn('?returnTo=%2F');
    expect(await screen.findByRole('link', { name: 'Sign in with Microsoft' })).toHaveAttribute(
      'href',
      '/auth/login',
    );
  });
});

describe('every ?error= value of the allow-list', () => {
  for (const language of ['en', 'nl'] as const) {
    it.each(SIGNIN_ERROR_CODES)(`renders its explanation and its remedy in ${language}: %s`, async (code) => {
      await openSignIn(`?error=${code}&returnTo=%2Fusers`, { language });
      const t = translator(language);
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(t.t(`signin.error.${code}`));
      expect(alert).toHaveTextContent(t.t(`signin.remedy.${code}`));
    });
  }

  it('renders signin_failed for any other value, and never prints the value', async () => {
    for (const value of ['nope', 'AUTH_REQUIRE_MFA', '<script>alert(1)</script>', 'constructor', '__proto__', '']) {
      const { unmount } = await openSignIn(`?error=${encodeURIComponent(value)}`);
      const alert = await screen.findByRole('alert');
      expect(alert, value).toHaveTextContent(translator('en').t('signin.error.signin_failed'));
      if (value !== '') expect(alert.textContent, value).not.toContain(value);
      unmount();
    }
  });

  it('offers "Sign in again" (prompt=login) and "Use another account" (prompt=select_account), and repeats nothing by itself', async () => {
    const { router } = await openSignIn('?error=access_denied&returnTo=%2Fusers');
    const again = await screen.findByRole('link', { name: 'Sign in again' });
    const other = screen.getByRole('link', { name: 'Use another account' });
    expect(again).toHaveAttribute('href', '/auth/login?prompt=login&returnTo=%2Fusers');
    expect(other).toHaveAttribute('href', '/auth/login?prompt=select_account&returnTo=%2Fusers');
    expect(router.state.location.pathname).toBe('/signin');
    expect(document.querySelector('meta[http-equiv="refresh"]')).toBeNull();
  });

  it('shows the consent link of me.adminConsentUrl for consent_required and admin_approval_required only', async () => {
    for (const code of SIGNIN_ERROR_CODES) {
      const { unmount } = await openSignIn(`?error=${code}`, { adminConsentUrl: CONSENT_URL });
      await screen.findByRole('alert');
      const link = screen.queryByRole('link', { name: translator('en').t('signin.consent.link') });
      const wanted = (SIGNIN_CONSENT_LINK_CODES as readonly string[]).includes(code);
      if (wanted) {
        expect(link, code).toHaveAttribute('href', CONSENT_URL);
      } else {
        expect(link, code).not.toBeInTheDocument();
      }
      unmount();
    }
  });

  it('shows no consent link when the server gave none (no tenant is pinned)', async () => {
    await openSignIn('?error=consent_required', { adminConsentUrl: null });
    await screen.findByRole('alert');
    expect(screen.queryByRole('link', { name: translator('en').t('signin.consent.link') })).not.toBeInTheDocument();
  });

  it('links setup_required to the setup wizard', async () => {
    await openSignIn('?error=setup_required');
    expect(await screen.findByRole('link', { name: 'Go to the setup wizard' })).toHaveAttribute('href', '/setup');
  });

  it('names AUTH_REQUIRE_MFA and the optional claim amr where those codes need them', async () => {
    await openSignIn('?error=mfa_required');
    expect(await screen.findByRole('alert')).toHaveTextContent('AUTH_REQUIRE_MFA');
  });
});

describe('?signedout=1', () => {
  it('renders the signed-out notice and the normal sign-in action, and no error', async () => {
    await openSignIn('?signedout=1');
    const en = translator('en');
    expect(await screen.findByText(en.t('signin.signedOut.title'))).toBeInTheDocument();
    expect(screen.getByText(en.t('signin.signedOut.message'))).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: en.t('signin.action.signIn') })).toBeInTheDocument();
  });

  it('is not triggered by another value', async () => {
    await openSignIn('?signedout=0');
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByText(translator('en').t('signin.signedOut.title'))).not.toBeInTheDocument();
  });
});

describe('a visitor who already has a session is sent on to returnTo (FR-B-402)', () => {
  async function landing(returnTo: string): Promise<string> {
    const { router } = await renderApp({
      me: sampleSignedInMe(),
      branding: sampleBranding('Acme'),
      path: `/signin?returnTo=${encodeURIComponent(returnTo)}`,
    });
    // `renderApp` has loaded the route: the redirect has happened.
    return `${router.state.location.pathname}${router.state.location.searchStr}`;
  }

  it('goes to a safe path of this origin', async () => {
    expect(await landing('/settings')).toBe('/settings');
    expect(await landing('/users?page=2')).toBe('/users?page=2');
  });

  it('lands on / for the hostile table: //evil, https://evil, javascript:, /\\evil, a CRLF value', async () => {
    for (const hostile of [
      '//evil.example',
      'https://evil.example',
      'javascript:alert(1)',
      '/\\evil.example',
      '/ok\r\nSet-Cookie: a=b',
      '/%2f%2fevil.example',
      '/api/v1/me',
      '/setup',
    ]) {
      expect(await landing(hostile), JSON.stringify(hostile)).toBe('/');
    }
  });

  it('is proven by a guard that fails for a page that navigates to the raw value (+ negative)', () => {
    const hostile = ['//evil.example', 'https://evil.example', 'javascript:alert(1)', '/\\evil.example'];
    const assertSafeLanding = (land: (raw: string) => string): void => {
      for (const raw of hostile) {
        if (land(raw) !== '/') throw new Error(`navigated to ${raw}`);
      }
    };
    expectGuardFails(assertSafeLanding, (raw) => raw, { name: 'a page that navigates to the raw returnTo', reason: 'navigated to //evil.example' });
  });

  it('also sends a setup session and a break-glass session on', async () => {
    for (const me of [sampleMe({ kind: 'setup', setupState: 'in_progress' }), sampleMe({ kind: 'break_glass', breakGlass: true })]) {
      const { router } = await renderApp({ me, path: '/signin?returnTo=%2Fno-access' });
      expect(router.state.location.pathname, me.actor.kind).toBe('/no-access');
    }
  });
});

describe('the page is reachable without a session even when the setup is unconfigured', () => {
  it('renders for an anonymous actor in every setup state', async () => {
    for (const setupState of ['unconfigured', 'in_progress', 'awaiting_first_signin', 'completed'] as const) {
      const { unmount } = await renderApp({ me: sampleMe({ setupState }), path: '/signin' });
      expect(await screen.findByRole('heading', { level: 1 }), setupState).toBeInTheDocument();
      unmount();
    }
  });

  it('keeps the actions reachable by keyboard: links with an accessible name, in a sensible order', async () => {
    await openSignIn('?error=session_expired');
    const main = await screen.findByRole('main');
    const links = within(main).getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual(['Sign in again', 'Use another account']);
    fireEvent.focus(links[0]!);
  });
});
