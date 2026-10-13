//
// THE PAGES AND THE ROUTE TREE (FR-A-129 to FR-A-131; US-5.5 to US-5.8; T-A-169).
//
// The real, file-based route tree: the Settings overview lists Appearance only; Not-found answers an
// unknown URL; an actor without a permission sees No-access at the same URL; `/design` is Not-found
// unless the server says the showcase is on; every route has a title and the shared path list matches
// the tree.
import { createTranslator } from '@m365portal/shared/i18n';
import { CLIENT_PATHS } from '@m365portal/shared/routes';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { sampleBranding, sampleMe, sampleSignedInMe } from './helpers/boot-fixtures';
import { renderApp } from './helpers/render-shell';

/** A signed-in user who holds no permission: the shell around the page, and the in-place No-access for a gated one. */
const person = () => sampleMe({ kind: 'user' });

const en = createTranslator('en');
const nl = createTranslator('nl');

describe('the Settings overview', () => {
  it('lists Appearance and My access, for an actor who may change the appearance', async () => {
    await renderApp({ me: sampleMe({ permissions: ['settings:branding'] }), path: '/settings' });

    const main = await screen.findByRole('main');
    expect(
      await within(main).findByRole('heading', { level: 1, name: en.t('pages.settings.title') }),
    ).toBeInTheDocument();
    const list = within(main).getByRole('list', { name: en.t('pages.settings.list') });
    const links = within(list).getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/settings/appearance',
      '/settings/access',
    ]);
    expect(links[0]).toHaveAccessibleName(new RegExp(en.t('nav.appearance')));
    expect(links[1]).toHaveAccessibleName(new RegExp(en.t('nav.access')));
    expect(within(main).getByText(en.t('pages.settings.later'))).toBeInTheDocument();
  });

  it('lists Connection and My access to an actor who may manage the connection (T-B-306)', async () => {
    await renderApp({ me: sampleMe({ permissions: ['settings:connection'] }), path: '/settings' });

    const main = await screen.findByRole('main');
    expect(
      await within(main).findByRole('heading', { level: 1, name: en.t('pages.settings.title') }),
    ).toBeInTheDocument();
    const links = within(main).getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/settings/connection',
      '/settings/access',
    ]);
    expect(within(main).getByText(en.t('pages.settings.later'))).toBeInTheDocument();
  });

  it('lists only My access to a signed-in user with no settings permission, and nothing to hide it behind No-access', async () => {
    await renderApp({ me: person(), path: '/settings' });
    const main = await screen.findByRole('main');
    expect(
      await within(main).findByRole('heading', { level: 1, name: en.t('pages.settings.title') }),
    ).toBeInTheDocument();
    expect(
      within(main)
        .getAllByRole('link')
        .map((link) => link.getAttribute('href')),
    ).toEqual(['/settings/access']);
  });

  it('is in Dutch when the page is Dutch', async () => {
    await renderApp({ me: sampleSignedInMe(), path: '/settings', language: 'nl' });

    expect(
      await screen.findByRole('heading', { level: 1, name: nl.t('pages.settings.title') }),
    ).toBeInTheDocument();
    expect(screen.getByText(nl.t('pages.settings.later'))).toBeInTheDocument();
  });
});

describe('Settings, Appearance', () => {
  it('is the page at /settings/appearance for an actor with settings:branding', async () => {
    const { router } = await renderApp({
      me: sampleMe({ permissions: ['settings:branding'] }),
      path: '/settings/appearance',
    });

    expect(
      await screen.findByRole('heading', { level: 1, name: en.t('nav.appearance') }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/settings/appearance');
  });

  it('shows No-access, at the same URL, to an actor with only settings:connection', async () => {
    const { router } = await renderApp({
      me: sampleMe({ permissions: ['settings:connection'] }),
      path: '/settings/appearance',
    });

    expect(
      await screen.findByRole('heading', { level: 1, name: en.t('pages.noAccess.title') }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/settings/appearance');
  });
});

describe('No-access', () => {
  it('shows an actor without the permission No-access at the same URL for every gated page', async () => {
    for (const path of [
      '/users',
      '/groups',
      '/distribution-lists',
      '/contacts',
      '/audit',
      '/settings/appearance',
      '/settings/connection',
    ]) {
      const view = await renderApp({ me: person(), path });

      expect(
        await screen.findByRole('heading', { level: 1, name: en.t('pages.noAccess.title') }),
        path,
      ).toBeInTheDocument();
      expect(view.router.state.location.pathname).toBe(path);
      view.unmount();
    }
  });

  it('is also a page of its own at /no-access, the public variant of the sign-in flow (no_role unless told otherwise)', async () => {
    await renderApp({ me: person(), path: '/no-access' });

    expect(
      await screen.findByRole('heading', { level: 1, name: en.t('noaccess.title') }),
    ).toBeInTheDocument();
    expect(screen.getByText(en.t('noaccess.reason.no_role'))).toBeInTheDocument();
    expect(screen.getByRole('link', { name: en.t('noaccess.action.signInAgain') })).toHaveAttribute(
      'href',
      '/auth/login?prompt=login',
    );
  });

  it('keeps the shell around it', async () => {
    await renderApp({ me: person(), path: '/users' });
    await screen.findByRole('heading', { level: 1, name: en.t('pages.noAccess.title') });

    expect(
      screen.getByRole('navigation', { name: en.t('a11y.mainNavigation') }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('main')).toHaveLength(1);
  });
});

describe('Not-found', () => {
  it('answers an unknown URL inside the shell, with a way back and a title', async () => {
    const { router } = await renderApp({
      me: person(),
      path: '/no/such/page',
      branding: sampleBranding('Acme'),
    });

    expect(
      await screen.findByRole('heading', { level: 1, name: en.t('pages.notFound.title') }),
    ).toBeInTheDocument();
    expect(screen.getByText(en.t('pages.notFound.description'))).toBeInTheDocument();
    expect(screen.getByRole('link', { name: en.t('pages.backToDashboard') })).toHaveAttribute(
      'href',
      '/',
    );
    expect(
      screen.getByRole('navigation', { name: en.t('a11y.mainNavigation') }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/no/such/page');
    expect(document.title).toBe(`${en.t('pages.notFound.title')} - Acme`);
  });

  it('is in Dutch when the page is Dutch', async () => {
    await renderApp({ me: person(), path: '/nergens', language: 'nl' });

    expect(
      await screen.findByRole('heading', { level: 1, name: nl.t('pages.notFound.title') }),
    ).toBeInTheDocument();
  });
});

describe('/design', () => {
  it('is Not-found when the server has the showcase off', async () => {
    await renderApp({ me: sampleSignedInMe({ showcase: false }), path: '/design' });

    expect(
      await screen.findByRole('heading', { level: 1, name: en.t('pages.notFound.title') }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { level: 1, name: en.t('nav.design') }),
    ).not.toBeInTheDocument();
  });

  it('is Not-found for an actor without permissions too when it is off', async () => {
    await renderApp({ me: person(), path: '/design' });

    expect(
      await screen.findByRole('heading', { level: 1, name: en.t('pages.notFound.title') }),
    ).toBeInTheDocument();
  });

  it('is the showcase when me.features.showcase is true', async () => {
    await renderApp({ me: sampleMe({ kind: 'user', showcase: true }), path: '/design' });

    expect(
      await screen.findByRole('heading', { level: 1, name: en.t('nav.design') }),
    ).toBeInTheDocument();
  });
});

describe('titles and paths', () => {
  it('titles a page the actor may not open "No access", not with the name of the page', async () => {
    await renderApp({ me: person(), path: '/users', branding: sampleBranding('Acme') });
    await screen.findByRole('heading', { level: 1, name: en.t('pages.noAccess.title') });

    expect(document.title).toBe(`${en.t('nav.noAccess')} - Acme`);
  });

  it('titles /design "Page not found" while the showcase is off', async () => {
    await renderApp({ me: person(), path: '/design', branding: sampleBranding('Acme') });
    await screen.findByRole('heading', { level: 1, name: en.t('pages.notFound.title') });

    expect(document.title).toBe(`${en.t('pages.notFound.title')} - Acme`);
  });

  it('sets the document title to "<page> - <organisation name>"', async () => {
    await renderApp({
      me: sampleSignedInMe(),
      path: '/users',
      branding: sampleBranding('Acme'),
    });
    await screen.findByRole('heading', { level: 1, name: en.t('nav.users') });

    expect(document.title).toBe(`${en.t('nav.users')} - Acme`);
  });

  it('translates the page part of the title and never the organisation name', async () => {
    await renderApp({
      me: sampleSignedInMe(),
      path: '/audit',
      branding: sampleBranding('Dashboard'),
      language: 'nl',
    });
    await screen.findByRole('heading', { level: 1, name: nl.t('nav.auditLog') });

    expect(document.title).toBe(`${nl.t('nav.auditLog')} - Dashboard`);
  });

  it('has a route for every shared client path, and a title for every page', async () => {
    const { router } = await renderApp({ me: sampleSignedInMe({ showcase: true }) });

    const routes = router.routesByPath as unknown as Record<
      string,
      { options: { staticData?: { titleKey?: string } } }
    >;
    for (const path of CLIENT_PATHS) expect(Object.keys(routes), path).toContain(path);
    // The Settings overview (`/settings`, the index of the Settings layout) and the lists of users and groups
    // (`/users` and `/groups`, the indexes of their layouts, Phase C) take the title of their layouts.
    const layoutIndexes = new Set<string>(['/settings', '/users', '/groups']);
    for (const path of CLIENT_PATHS.filter((candidate) => !layoutIndexes.has(candidate))) {
      expect(routes[path]?.options.staticData?.titleKey, path).toBeDefined();
    }
  });
});
