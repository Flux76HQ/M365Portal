// THE NO-ACCESS PAGE (T-B-297; FR-B-607, FR-B-402, FR-B-608; SB-26; plan 12.1).
//
// /no-access?reason=no_role|graph_unavailable&ref=<request id>. A person who signed in at Microsoft but
// holds no role has no session, so the page is public: the organisation mark and name, one explanation
// for the allow-listed reason (any other value, or none, is `no_role`), the reference of the failed
// request only when it looks like a request id, and two actions. It shows no data.
import { createTranslator, type Locale } from '@m365portal/shared/i18n';
import { NO_ACCESS_REASONS } from '@m365portal/shared/auth/signin-errors';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { sampleBranding, sampleMe, sampleSignedInMe } from './helpers/boot-fixtures';
import { renderApp } from './helpers/render-shell';

const translator = (language: Locale) => createTranslator(language);

async function openNoAccess(search: string, language: Locale = 'en') {
  return renderApp({ me: sampleMe(), branding: sampleBranding('Acme'), path: `/no-access${search}`, language });
}

describe('the reason', () => {
  for (const language of ['en', 'nl'] as const) {
    it.each(NO_ACCESS_REASONS)(`renders the explanation and the remedy of %s in ${language}`, async (reason) => {
      await openNoAccess(`?reason=${reason}`, language);
      const t = translator(language);
      const main = await screen.findByRole('main');
      expect(await within(main).findByRole('heading', { level: 1 })).toHaveTextContent(t.t('noaccess.title'));
      expect(main).toHaveTextContent(t.t(`noaccess.reason.${reason}`));
      expect(main).toHaveTextContent(t.t(`noaccess.remedy.${reason}`));
    });
  }

  it('renders no_role for anything else: another value, nothing, an array', async () => {
    for (const search of ['?reason=admin', '', '?reason=', '?reason=NO_ROLE', '?reason=%3Cscript%3E', '?reason=a&reason=b']) {
      const { unmount } = await openNoAccess(search);
      const main = await screen.findByRole('main');
      expect(main, search).toHaveTextContent(translator('en').t('noaccess.reason.no_role'));
      expect(main.textContent, search).not.toContain('script');
      unmount();
    }
  });
});

describe('the reference', () => {
  const t = translator('en');

  it('is shown when it looks like a request id (8 to 64 letters, digits and hyphens)', async () => {
    await openNoAccess('?reason=no_role&ref=req-0123456789');
    const main = await screen.findByRole('main');
    expect(main).toHaveTextContent(t.t('noaccess.reference'));
    expect(within(main).getByText('req-0123456789')).toBeInTheDocument();
  });

  it('is not shown otherwise: too short, too long, spaces, markup, other characters', async () => {
    for (const ref of ['abc', 'a'.repeat(65), 'req 0123456789', '<b>req-0123456789</b>', 'req_0123456789', 'req-0123456789%0D%0A', '../../etc/passwd']) {
      const { unmount } = await openNoAccess(`?reason=no_role&ref=${encodeURIComponent(ref)}`);
      const main = await screen.findByRole('main');
      expect(main, ref).not.toHaveTextContent(t.t('noaccess.reference'));
      expect(main.textContent, ref).not.toContain(ref);
      unmount();
    }
  });
});

describe('the page', () => {
  it('shows the organisation mark and name and the two actions: sign in again, use another account', async () => {
    await openNoAccess('?reason=graph_unavailable&ref=req-0123456789');
    const t = translator('en');
    await screen.findByRole('main');
    expect(document.querySelector('[data-slot="org-mark"]')).not.toBeNull();
    expect(screen.getAllByText('Acme').length).toBeGreaterThan(0);
    const again = screen.getByRole('link', { name: t.t('noaccess.action.signInAgain') });
    const other = screen.getByRole('link', { name: t.t('noaccess.action.otherAccount') });
    expect(again).toHaveAttribute('href', '/auth/login?prompt=login');
    expect(other).toHaveAttribute('href', '/auth/login?prompt=select_account');
  });

  it('shows no data and no navigation', async () => {
    await openNoAccess('?reason=no_role');
    await screen.findByRole('main');
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('is titled "Geen toegang" in Dutch', async () => {
    await openNoAccess('?reason=no_role', 'nl');
    await screen.findByRole('main');
    expect(document.title).toBe(`${translator('nl').t('nav.noAccess')} - Acme`);
  });

  it('is the same page for a signed-in actor who opens it by hand', async () => {
    await renderApp({ me: sampleSignedInMe(), path: '/no-access' });
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(translator('en').t('noaccess.title'));
  });
});
