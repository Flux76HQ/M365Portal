//
// THE SHELL (FR-A-126, FR-A-121 switching, FR-B-608 session banners; US-5.1, US-5.4; T-A-167, T-B-298).
//
// What this proves, in a happy-dom page (no layout: sizes and breakpoints are asserted as the classes
// that carry them, and proven in a real browser by e2e/responsive.spec.ts and e2e/keyboard.spec.ts):
//   1. a 56 px header with the search trigger, the language and theme switchers and the organisation
//      mark; the sidebar is 256 px or 64 px, its state persists through the storage module, and a
//      drawer (a modal dialog with a focus trap) replaces it below 768 px;
//   2. breadcrumbs come from the routes' `staticData`;
//   3. the skip link is first in the tab order, exactly one `main` landmark exists, and the version
//      sits in the sidebar footer;
//   4. a long organisation name truncates but keeps its full accessible name; the organisation mark
//      is the logo (on a plate when `logoPlateFor` says so) or the monogram tile of the boot data;
//   5. the break-glass banner is a red status region that cannot be dismissed, on every route of a
//      break-glass session, and a notice shows while the group memberships are stale; the preview banner
//      of Phase A is gone (FR-B-102);
//   6. the theme switcher is a segmented control, the language switcher a menu.
import { logoPlateColour, logoPlateFor } from '@m365portal/shared/branding/logo-plate';
import { createTranslator } from '@m365portal/shared/i18n';
import { BrandingSchema, brandingAssetUrl } from '@m365portal/shared/schemas/branding';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getThemeController } from '../src/lib/theme';
import { STORAGE_KEYS, createStorage } from '../src/lib/storage';
import { sampleBranding, sampleMe, sampleSignedInMe } from './helpers/boot-fixtures';
import { MemoryBackend, renderShell } from './helpers/render-shell';

const en = createTranslator('en');
const nl = createTranslator('nl');

beforeEach(() => {
  getThemeController().setChoice('light');
});

afterEach(() => {
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.style.removeProperty('color-scheme');
  window.localStorage.clear();
});

const sha = (seed: string): string => seed.repeat(64).slice(0, 64);

function brandingWithLogo(luminance: number | null, orgName = 'Acme') {
  const asset = (hash: string, width: number, height: number) => ({
    hash,
    url: brandingAssetUrl(hash),
    width,
    height,
    luminance,
  });
  return BrandingSchema.parse({
    ...sampleBranding(orgName),
    logos: {
      light: asset(sha('a'), 400, 100),
      dark: null,
      compact: asset(sha('b'), 128, 128),
    },
  });
}

describe('the header', () => {
  it('is a 56 px banner landmark with the search trigger, both switchers and the organisation mark', async () => {
    await renderShell();

    const header = await screen.findByRole('banner');
    expect(header).toHaveClass('h-14');
    expect(
      within(header).getByRole('button', { name: en.t('shell.search.label') }),
    ).toBeInTheDocument();
    expect(within(header).getByRole('button', { name: en.t('lang.label') })).toBeInTheDocument();
    expect(
      within(header).getByRole('radiogroup', { name: en.t('theme.label') }),
    ).toBeInTheDocument();
    expect(header.querySelector('[data-slot="org-mark"]')).not.toBeNull();
  });

  it('lets the search trigger shrink between 640 and 1023 px so the header cluster fits beside the sidebar (FR-A-153)', async () => {
    await renderShell();
    const header = await screen.findByRole('banner');
    const trigger = within(header).getByRole('button', { name: en.t('shell.search.label') });
    expect(trigger).toHaveClass('shrink', 'sm:min-w-0', 'lg:min-w-56');
    expect(trigger).not.toHaveClass('sm:min-w-56');
  });

  it('shows the signed-in user as a persona with the initials of the display name', async () => {
    await renderShell({ me: sampleSignedInMe({ label: 'Alice Example' }) });
    const header = await screen.findByRole('banner');

    const persona = within(header).getByRole('img', {
      name: en.t('shell.actor.label', { name: 'Alice Example' }),
    });
    expect(persona).toHaveTextContent('AE');
  });

  it('names the anonymous actor in the language of the page', async () => {
    await renderShell({ language: 'nl' });
    const header = await screen.findByRole('banner');

    expect(
      within(header).getByRole('img', {
        name: nl.t('shell.actor.label', { name: nl.t('shell.actor.anonymous') }),
      }),
    ).toBeInTheDocument();
  });
});

describe('the sidebar', () => {
  it('is 256 px wide when expanded and 64 px when collapsed, and remembers the choice', async () => {
    const { user, backend } = await renderShell();
    const sidebar = await screen.findByRole('complementary');
    expect(sidebar).toHaveClass('w-64');

    await user.click(within(sidebar).getByRole('button', { name: en.t('shell.sidebar.collapse') }));

    expect(screen.getByRole('complementary')).toHaveClass('w-16');
    expect(backend.values.get(STORAGE_KEYS.sidebar)).toBe('collapsed');

    await user.click(screen.getByRole('button', { name: en.t('shell.sidebar.expand') }));
    expect(screen.getByRole('complementary')).toHaveClass('w-64');
    expect(backend.values.get(STORAGE_KEYS.sidebar)).toBe('expanded');
  });

  it('reads the stored state when the shell mounts', async () => {
    const backend = new MemoryBackend();
    backend.values.set(STORAGE_KEYS.sidebar, 'collapsed');

    await renderShell({ backend });

    expect(await screen.findByRole('complementary')).toHaveClass('w-16');
  });

  it('keeps working when the browser refuses to store anything', async () => {
    const { user } = await renderShell({ storage: createStorage(null) });
    const sidebar = await screen.findByRole('complementary');

    await user.click(within(sidebar).getByRole('button', { name: en.t('shell.sidebar.collapse') }));

    expect(screen.getByRole('complementary')).toHaveClass('w-16');
  });

  it('keeps every link named when collapsed', async () => {
    const { user } = await renderShell({ me: sampleSignedInMe() });
    const sidebar = await screen.findByRole('complementary');
    await user.click(within(sidebar).getByRole('button', { name: en.t('shell.sidebar.collapse') }));

    const nav = within(screen.getByRole('complementary')).getByRole('navigation', {
      name: en.t('a11y.mainNavigation'),
    });
    expect(within(nav).getByRole('link', { name: en.t('nav.users') })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: en.t('nav.dashboard') })).toBeInTheDocument();
  });

  it('shows the version of the application in its footer', async () => {
    await renderShell({ me: sampleMe({ version: '1.2.3' }) });
    const sidebar = await screen.findByRole('complementary');

    expect(within(sidebar).getByText(en.t('shell.version', { version: '1.2.3' }))).toBeVisible();
  });

  it('marks the page that is open', async () => {
    await renderShell({ me: sampleSignedInMe(), path: '/users' });
    const nav = await screen.findByRole('navigation', { name: en.t('a11y.mainNavigation') });

    expect(within(nav).getByRole('link', { name: en.t('nav.users') })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav).getByRole('link', { name: en.t('nav.dashboard') })).not.toHaveAttribute(
      'aria-current',
    );
  });
});

describe('the drawer below 768 px', () => {
  it('opens from the header as a modal dialog, closes with Escape and gives the focus back', async () => {
    const { user } = await renderShell();
    const header = await screen.findByRole('banner');
    const opener = within(header).getByRole('button', { name: en.t('shell.sidebar.open') });
    expect(opener).toHaveClass('md:hidden');

    await user.click(opener);
    const dialog = await screen.findByRole('dialog', { name: en.t('shell.sidebar.drawerTitle') });
    expect(
      within(dialog).getByRole('navigation', { name: en.t('a11y.mainNavigation') }),
    ).toBeInTheDocument();
    expect(dialog.contains(document.activeElement)).toBe(true);

    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(opener).toHaveFocus();
    });
  });

  it('closes when a link is followed', async () => {
    const { user, router } = await renderShell({ me: sampleSignedInMe() });
    await user.click(await screen.findByRole('button', { name: en.t('shell.sidebar.open') }));
    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('link', { name: en.t('nav.users') }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(router.state.location.pathname).toBe('/users');
  });

  it('offers the theme and language switchers too', async () => {
    const { user } = await renderShell();
    await user.click(await screen.findByRole('button', { name: en.t('shell.sidebar.open') }));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByRole('radiogroup', { name: en.t('theme.label') })).toBeVisible();
    expect(within(dialog).getByRole('button', { name: en.t('lang.label') })).toBeVisible();
  });
});

describe('breadcrumbs', () => {
  it('come from the routes: the dashboard, then each page with a title', async () => {
    await renderShell({ me: sampleSignedInMe(), path: '/settings/appearance' });
    const trail = await screen.findByRole('navigation', { name: en.t('a11y.breadcrumbs') });

    const items = within(trail).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      en.t('nav.dashboard'),
      en.t('nav.settings'),
      en.t('nav.appearance'),
    ]);
    expect(within(trail).getByRole('link', { name: en.t('nav.settings') })).toHaveAttribute(
      'href',
      '/settings',
    );
    expect(within(trail).getByText(en.t('nav.appearance'))).toHaveAttribute('aria-current', 'page');
  });

  it('are translated', async () => {
    await renderShell({
      me: sampleSignedInMe(),
      path: '/settings/appearance',
      language: 'nl',
    });
    const trail = await screen.findByRole('navigation', { name: nl.t('a11y.breadcrumbs') });

    expect(within(trail).getByText(nl.t('nav.appearance'))).toBeInTheDocument();
  });

  it('are not shown on the dashboard itself', async () => {
    await renderShell({ path: '/' });
    await screen.findByRole('heading', { level: 1, name: 'Dashboard page' });

    expect(
      screen.queryByRole('navigation', { name: en.t('a11y.breadcrumbs') }),
    ).not.toBeInTheDocument();
  });
});

describe('landmarks and the skip link', () => {
  it('has the skip link first in the tab order, and it moves the focus to the main landmark', async () => {
    const { user } = await renderShell();
    await screen.findByRole('main');

    await user.tab();
    const skip = screen.getByRole('link', { name: en.t('a11y.skipToContent') });
    expect(skip).toHaveFocus();

    await user.keyboard('{Enter}');
    expect(screen.getByRole('main')).toHaveFocus();
  });

  it('has exactly one main landmark, and it holds the page', async () => {
    await renderShell();

    const mains = await screen.findAllByRole('main');
    expect(mains).toHaveLength(1);
    expect(within(mains[0]!).getByRole('heading', { level: 1 })).toHaveTextContent(
      'Dashboard page',
    );
  });

  it('has one banner and one complementary landmark', async () => {
    await renderShell();
    await screen.findByRole('main');

    expect(screen.getAllByRole('banner')).toHaveLength(1);
    expect(screen.getAllByRole('complementary')).toHaveLength(1);
  });
});

describe('the organisation mark', () => {
  it('truncates a long name and keeps the whole name', async () => {
    const longName = 'The Very Long Name of a Large International Organisation Inc';
    await renderShell({ branding: sampleBranding(longName) });
    const sidebar = await screen.findByRole('complementary');

    const name = within(sidebar).getByText(longName);
    expect(name).toHaveClass('truncate');
    expect(name).toHaveAttribute('title', longName);
  });

  it('draws the monogram tile when there is no logo', async () => {
    await renderShell({ branding: sampleBranding('Acme') });
    const sidebar = await screen.findByRole('complementary');

    const tile = sidebar.querySelector('[data-slot="monogram-tile"]');
    expect(tile).not.toBeNull();
    expect(tile!.querySelectorAll('svg path').length).toBeGreaterThan(0);
    expect(tile).toHaveClass('bg-accent');
    // The name is written beside the tile, so the tile is not read out a second time.
    expect(tile).toHaveAttribute('aria-hidden', 'true');
    expect(within(sidebar).getByText('Acme')).toBeVisible();
  });

  it('names the organisation by the mark alone when the name is not written (collapsed)', async () => {
    const { user } = await renderShell({ branding: sampleBranding('Acme') });
    const sidebar = await screen.findByRole('complementary');
    await user.click(within(sidebar).getByRole('button', { name: en.t('shell.sidebar.collapse') }));

    expect(
      within(screen.getByRole('complementary')).getByRole('img', { name: 'Acme' }),
    ).toHaveClass('bg-accent');
  });

  it('shows the logo of the theme, from its URL', async () => {
    await renderShell({ branding: brandingWithLogo(0.05) });
    const sidebar = await screen.findByRole('complementary');

    const logo = sidebar.querySelector('img');
    expect(logo).toHaveAttribute('src', brandingAssetUrl(sha('a')));
    expect(logo).toHaveAttribute('alt', '');
  });

  it('puts a logo on a plate where it would be illegible, and not otherwise', async () => {
    // A near-white logo on the light sidebar needs a plate; a dark one does not.
    await renderShell({ branding: brandingWithLogo(0.97) });
    const sidebar = await screen.findByRole('complementary');

    const plate = sidebar.querySelector('[data-slot="logo"]');
    const expected = logoPlateFor(0.97, 'light');
    expect(expected).not.toBe('none');
    expect(plate).toHaveAttribute('data-plate', expected);
    expect(plate).toHaveStyle({
      backgroundColor: logoPlateColour(expected as 'light' | 'dark'),
    });
  });

  it('uses no plate for a logo that contrasts with the sidebar', async () => {
    await renderShell({ branding: brandingWithLogo(0.02) });
    const sidebar = await screen.findByRole('complementary');

    expect(sidebar.querySelector('[data-slot="logo"]')).toHaveAttribute('data-plate', 'none');
  });

  it('shows the compact logo, named, when the sidebar is collapsed', async () => {
    const { user } = await renderShell({ branding: brandingWithLogo(0.02) });
    const sidebar = await screen.findByRole('complementary');
    await user.click(within(sidebar).getByRole('button', { name: en.t('shell.sidebar.collapse') }));

    const logo = within(screen.getByRole('complementary')).getByRole('img', { name: 'Acme' });
    expect(logo).toHaveAttribute('src', brandingAssetUrl(sha('b')));
  });

  it('never translates the organisation name', async () => {
    await renderShell({ branding: sampleBranding('Dashboard'), language: 'nl' });
    const sidebar = await screen.findByRole('complementary');

    expect(within(sidebar).getByTitle('Dashboard')).toHaveTextContent('Dashboard');
  });
});

describe('the break-glass banner', () => {
  const breakGlass = () =>
    sampleMe({ kind: 'break_glass', breakGlass: true, permissions: ['rbac:manage'] });

  it('is a status region on every route of a break-glass session', async () => {
    for (const path of ['/', '/settings', '/settings/appearance', '/users']) {
      const { unmount } = await renderShell({ me: breakGlass(), path });
      const banner = await screen.findByTestId('break-glass-banner');
      expect(banner, path).toHaveAttribute('role', 'status');
      expect(banner, path).toHaveTextContent(en.t('session.breakGlass.title'));
      expect(banner, path).toHaveTextContent(en.t('session.breakGlass.message'));
      unmount();
    }
  });

  it('is red (the danger tone), with an icon, and has a countdown to the absolute end', async () => {
    await renderShell({ me: breakGlass() });
    const banner = await screen.findByTestId('break-glass-banner');
    expect(banner).toHaveAttribute('data-tone', 'danger');
    expect(banner.querySelector('svg')).not.toBeNull();
    expect(within(banner).getByRole('timer')).toBeInTheDocument();
  });

  it('cannot be dismissed', async () => {
    await renderShell({ me: breakGlass() });
    const banner = await screen.findByTestId('break-glass-banner');
    expect(within(banner).queryByRole('button')).not.toBeInTheDocument();
  });

  it('is written in the language of the page', async () => {
    await renderShell({ me: breakGlass(), language: 'nl' });
    expect(await screen.findByTestId('break-glass-banner')).toHaveTextContent(
      nl.t('session.breakGlass.title'),
    );
  });

  it('is absent for every other actor', async () => {
    for (const me of [
      sampleSignedInMe(),
      sampleMe({ kind: 'setup', setupState: 'in_progress' }),
      sampleMe(),
    ]) {
      const { unmount } = await renderShell({ me });
      await screen.findByRole('main');
      expect(screen.queryByTestId('break-glass-banner'), me.actor.kind).not.toBeInTheDocument();
      unmount();
    }
  });
});

describe('the notice about stale group memberships', () => {
  it('shows while session.groupsStale is true, as a polite status region with a warning tone', async () => {
    await renderShell({ me: sampleSignedInMe({ session: { groupsStale: true } }) });
    const notice = await screen.findByTestId('groups-stale-notice');
    expect(notice).toHaveAttribute('role', 'status');
    expect(notice).toHaveAttribute('data-tone', 'warning');
    expect(notice).toHaveTextContent(en.t('session.groupsStale.title'));
    expect(notice).toHaveTextContent(en.t('session.groupsStale.message'));
  });

  it('is in Dutch when the page is Dutch', async () => {
    await renderShell({ me: sampleSignedInMe({ session: { groupsStale: true } }), language: 'nl' });
    expect(await screen.findByTestId('groups-stale-notice')).toHaveTextContent(
      nl.t('session.groupsStale.title'),
    );
  });

  it('is absent when the memberships are fresh', async () => {
    await renderShell({ me: sampleSignedInMe() });
    await screen.findByRole('main');
    expect(screen.queryByTestId('groups-stale-notice')).not.toBeInTheDocument();
  });
});

describe('no preview banner (FR-B-102)', () => {
  it('shows no status region for a normal actor on any shell route', async () => {
    for (const path of ['/', '/settings', '/users']) {
      const { unmount } = await renderShell({ me: sampleSignedInMe(), path });
      await screen.findByRole('main');
      expect(screen.queryByRole('status'), path).not.toBeInTheDocument();
      unmount();
    }
  });

  it('has neither the component nor its catalogue entries', () => {
    const english = createTranslator('en');
    expect(english.t('banner.preview.title' as never)).toBe('banner.preview.title');
    expect(english.t('shell.actor.preview' as never)).toBe('shell.actor.preview');
  });
});

describe('the theme switcher', () => {
  it('is a segmented control of light, dark and system that applies at once', async () => {
    const { user } = await renderShell();
    const header = await screen.findByRole('banner');
    const group = within(header).getByRole('radiogroup', { name: en.t('theme.label') });

    expect(
      within(group)
        .getAllByRole('radio')
        .map((radio) => radio.textContent),
    ).toEqual([en.t('theme.light'), en.t('theme.dark'), en.t('theme.system')]);

    await user.click(within(group).getByRole('radio', { name: en.t('theme.dark') }));

    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(within(group).getByRole('radio', { name: en.t('theme.dark') })).toBeChecked();
  });
});

describe('the language switcher', () => {
  it('is a menu that changes the language of the whole page', async () => {
    const { user, language } = await renderShell();
    const header = await screen.findByRole('banner');

    await user.click(within(header).getByRole('button', { name: en.t('lang.label') }));
    const menu = await screen.findByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitemradio')
        .map((item) => item.textContent),
    ).toEqual(['Nederlands', 'English']);
    expect(within(menu).getByRole('menuitemradio', { name: 'English' })).toBeChecked();

    await user.click(within(menu).getByRole('menuitemradio', { name: 'Nederlands' }));

    expect(language.language).toBe('nl');
    expect(
      await within(screen.getByRole('banner')).findByRole('button', { name: nl.t('lang.label') }),
    ).toBeInTheDocument();
  });
});
