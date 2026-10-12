// THE PERSONA MENU (T-B-298; FR-B-608, FR-B-410, FR-B-606, FR-B-522; US-B8 item 1; plan 12.4).
//
// The header shows who the actor is: a Persona with the initials of the display name. A signed-in user
// gets a menu with "Mijn toegang", "Uitloggen" and "Overal uitloggen"; a break-glass session the first two
// (there is one session to end); the setup actor and an anonymous visitor have no menu. Signing out is a
// `fetch` on this origin followed by a navigation to the redirect it answered, and only when that redirect
// is the Entra sign-out page or `/signin?signedout=1` (lib/ms-url.ts).
import { createTranslator } from '@m365portal/shared/i18n';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { FetchFunction } from '../src/lib/api';
import type { MeResponse } from '../src/lib/boot-data';
import { sampleMe, sampleSignedInMe } from './helpers/boot-fixtures';
import { renderApp } from './helpers/render-shell';

const en = createTranslator('en');

/** The header of the shell (the pages have `<header>` elements of their own, which are no banner). */
async function shellHeader(): Promise<HTMLElement> {
  await screen.findByRole('main');
  const header = document.querySelector<HTMLElement>('[data-slot="header"]');
  if (header === null) throw new Error('the shell has no header');
  return header;
}
const nl = createTranslator('nl');

const TENANT = '3f2b6a52-7c1e-4a8e-9a3d-0c5f4d1b2e77';
const ENTRA_LOGOUT = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/logout?post_logout_redirect_uri=https%3A%2F%2Fpanel.example.com%2Fauth%2Flogged-out`;

interface Request {
  readonly url: string;
  readonly method: string;
}

/** A server that answers the CSRF request and the sign-out routes the test asks for. */
function server(answers: Record<string, () => Response>) {
  const requests: Request[] = [];
  const fetchFunction: FetchFunction = (input, init) => {
    const method = init?.method ?? 'GET';
    requests.push({ url: input, method });
    if (input === '/api/v1/csrf') {
      return Promise.resolve(
        Response.json({ token: 'token-1', expiresAt: '2099-01-01T00:00:00.000Z' }),
      );
    }
    const answer = answers[`${method} ${input}`];
    return Promise.resolve(answer?.() ?? new Response('{}', { status: 404 }));
  };
  return { fetch: fetchFunction, requests };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

async function openMenu(
  options: Parameters<typeof renderApp>[0] & { readonly me: MeResponse; readonly name?: string },
) {
  const view = await renderApp({ path: '/settings', ...options });
  const trigger = await screen.findByRole('button', {
    name: en.t('session.persona.menuLabel', { name: options.name ?? options.me.actor.label }),
  });
  await view.user.click(trigger);
  const menu = await screen.findByRole('menu');
  return { ...view, menu, trigger };
}

describe('the persona', () => {
  it('shows the initials of the display name, named for assistive technology', async () => {
    await renderApp({ me: sampleSignedInMe({ label: 'Alice Example' }), path: '/settings' });
    const header = await shellHeader();
    const persona = within(header).getByRole('img', {
      name: en.t('shell.actor.label', { name: 'Alice Example' }),
    });
    expect(persona).toHaveTextContent('AE');
  });

  it('is a button that opens the account menu for a user, with the name of the person in its name', async () => {
    await renderApp({ me: sampleSignedInMe({ label: 'Alice Example' }), path: '/settings' });
    const button = await screen.findByRole('button', {
      name: en.t('session.persona.menuLabel', { name: 'Alice Example' }),
    });
    expect(button).toHaveAttribute('aria-haspopup', 'menu');
  });

  it('names the setup actor in the language of the page and gives it no menu', async () => {
    await renderApp({
      me: sampleMe({ kind: 'setup', setupState: 'in_progress' }),
      language: 'nl',
      path: '/settings',
    });
    const header = await shellHeader();
    expect(
      within(header).getByRole('img', {
        name: nl.t('shell.actor.label', { name: nl.t('session.actor.setup') }),
      }),
    ).toBeInTheDocument();
    expect(within(header).queryByRole('button', { name: /Accountmenu/ })).not.toBeInTheDocument();
  });
});

describe('the items', () => {
  it('lists "My access", "Sign out" and "Sign out everywhere" for a user, in this order', async () => {
    const { menu } = await openMenu({ me: sampleSignedInMe({ label: 'Alice Example' }) });
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual([
      en.t('session.menu.myAccess'),
      en.t('session.menu.signOut'),
      en.t('session.menu.signOutAll'),
    ]);
  });

  it('is in Dutch when the page is Dutch: Mijn toegang, Uitloggen, Overal uitloggen', async () => {
    const view = await renderApp({
      me: sampleSignedInMe({ label: 'Alice Example' }),
      language: 'nl',
      path: '/settings',
    });
    await view.user.click(
      await screen.findByRole('button', {
        name: nl.t('session.persona.menuLabel', { name: 'Alice Example' }),
      }),
    );
    const menu = await screen.findByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Mijn toegang', 'Uitloggen', 'Overal uitloggen']);
  });

  it('lists only "My access" and "Sign out" for a break-glass session: there is one session to end', async () => {
    const { menu } = await openMenu({
      me: sampleMe({
        kind: 'break_glass',
        label: 'Break-glass',
        breakGlass: true,
        permissions: ['rbac:manage'],
      }),
      name: en.t('session.actor.breakGlass'),
    });
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual([en.t('session.menu.myAccess'), en.t('session.menu.signOut')]);
  });

  it('takes the person to "My access" at /settings/access', async () => {
    const { menu, user, router } = await openMenu({
      me: sampleSignedInMe({ label: 'Alice Example' }),
    });
    await user.click(within(menu).getByRole('menuitem', { name: en.t('session.menu.myAccess') }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/settings/access');
    });
  });
});

describe('signing out', () => {
  it('calls fetch on this origin and then navigates to the Entra sign-out page it answered', async () => {
    const { fetch, requests } = server({
      'POST /api/v1/auth/logout': () => json({ redirect: ENTRA_LOGOUT }),
    });
    const { menu, user, moves } = await openMenu({
      me: sampleSignedInMe({ label: 'Alice Example' }),
      fetch,
    });
    await user.click(within(menu).getByRole('menuitem', { name: en.t('session.menu.signOut') }));
    await waitFor(() => {
      expect(moves).toEqual([`assign ${ENTRA_LOGOUT}`]);
    });
    expect(requests.filter((request) => request.method === 'POST')).toEqual([
      { url: '/api/v1/auth/logout', method: 'POST' },
    ]);
    // Every request stayed on this origin.
    for (const request of requests) expect(request.url.startsWith('/api/')).toBe(true);
  });

  it('navigates to /signin?signedout=1 when the answer is the local path (a break-glass session)', async () => {
    const { fetch } = server({
      'POST /api/v1/auth/logout': () => json({ redirect: '/signin?signedout=1' }),
    });
    const { menu, user, moves } = await openMenu({
      me: sampleSignedInMe({ label: 'Alice Example' }),
      fetch,
    });
    await user.click(within(menu).getByRole('menuitem', { name: en.t('session.menu.signOut') }));
    await waitFor(() => {
      expect(moves).toEqual(['assign /signin?signedout=1']);
    });
  });

  it('signs out everywhere through logout-all', async () => {
    const { fetch, requests } = server({
      'POST /api/v1/auth/logout-all': () => json({ redirect: ENTRA_LOGOUT, sessionsEnded: 3 }),
    });
    const { menu, user, moves } = await openMenu({
      me: sampleSignedInMe({ label: 'Alice Example' }),
      fetch,
    });
    await user.click(within(menu).getByRole('menuitem', { name: en.t('session.menu.signOutAll') }));
    await waitFor(() => {
      expect(moves).toEqual([`assign ${ENTRA_LOGOUT}`]);
    });
    expect(requests.some((request) => request.url === '/api/v1/auth/logout-all')).toBe(true);
  });

  it('refuses to navigate to a redirect that is not one of the two shapes, and says so (+ negative)', async () => {
    for (const redirect of [
      'javascript:alert(1)',
      'https://login.microsoftonline.com.evil.example/x',
      'http://login.microsoftonline.com/x',
      '//evil.example',
      '/signin',
    ]) {
      const { fetch } = server({ 'POST /api/v1/auth/logout': () => json({ redirect }) });
      const { menu, user, moves, unmount } = await openMenu({
        me: sampleSignedInMe({ label: 'Alice Example' }),
        fetch,
      });
      await user.click(within(menu).getByRole('menuitem', { name: en.t('session.menu.signOut') }));
      expect(
        await screen.findByText(en.t('session.menu.signOutFailed')),
        redirect,
      ).toBeInTheDocument();
      expect(moves, redirect).toEqual([]);
      unmount();
    }
  });

  it('says so and stays when the request fails, with the message of the problem and no server text', async () => {
    const { fetch } = server({
      'POST /api/v1/auth/logout': () =>
        new Response(
          JSON.stringify({
            code: 'storage_unavailable',
            status: 503,
            detail: 'SQLITE_BUSY secret detail',
          }),
          { status: 503, headers: { 'Content-Type': 'application/problem+json' } },
        ),
    });
    const { menu, user, moves } = await openMenu({
      me: sampleSignedInMe({ label: 'Alice Example' }),
      fetch,
    });
    await user.click(within(menu).getByRole('menuitem', { name: en.t('session.menu.signOut') }));
    expect(await screen.findByText(en.t('session.menu.signOutFailed'))).toBeInTheDocument();
    expect(screen.getByText(en.t('problem.storage_unavailable'))).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('SQLITE_BUSY');
    expect(moves).toEqual([]);
  });
});
