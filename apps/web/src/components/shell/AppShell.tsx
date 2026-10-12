import { Outlet, useRouterState } from '@tanstack/react-router';
import { lazy, Suspense, useCallback, useState } from 'react';
import { isPublicPath } from '../../lib/gating';
import { loadLazyNamespace } from '../../lib/locale';
import { BreakGlassBanner } from '../../features/auth/BreakGlassBanner';
import { GroupsStaleNotice } from '../../features/auth/GroupsStaleNotice';
import { SessionTimers } from '../../features/auth/SessionTimers';
import { StepUpDialog } from '../../features/auth/StepUpDialog';
import { useSidebarState } from '../../lib/sidebar';
import {
  useGlobalShortcuts,
  useSingleKeyShortcuts,
  type ShortcutAction,
} from '../../lib/shortcuts';
import { BareLayout } from './BareLayout';
import { BreadcrumbsBar } from './BreadcrumbsBar';
import { Header } from './Header';
import { MAIN_ID } from './main-id';
import { NavDrawer, Sidebar } from './Sidebar';
import { SkipLink } from './SkipLink';

// The palette (with cmdk) and the overview are lazy chunks: nothing of them is in the entry (plan 9.3).
// Their text is a lazy catalogue each (T-B-307), loaded together with the chunk.
const CommandPalette = lazy(async () => {
  await loadLazyNamespace('palette');
  return import('./CommandPalette');
});
const ShortcutsOverview = lazy(async () => {
  await loadLazyNamespace('shortcuts');
  return import('./ShortcutsOverview');
});

export { MAIN_ID };

/**
 * The component of the root route: the frame of the public pages (sign-in, no-access, break-glass, setup:
 * no sidebar, T-B-297) or the frame of the application.
 */
export function RootLayout() {
  const publicPage = useRouterState({ select: (state) => isPublicPath(state.location.pathname) });
  return publicPage ? <BareLayout /> : <AppShell />;
}

/**
 * The frame of every page (plan 9.5): skip link, sidebar (a drawer below 768 px), the session banners
 * (break-glass, stale groups, the notice before the session ends), the header, breadcrumbs and exactly one `main` landmark that holds the page, capped at 1600 px and
 * centred on ultrawide screens. It is the component of the root route.
 */
export function AppShell() {
  const { collapsed, toggle } = useSidebarState();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [overviewOpen, setOverviewOpen] = useState(false);
  // Once opened a dialog stays mounted, closed, so that its closing animation can play.
  const [paletteLoaded, setPaletteLoaded] = useState(false);
  const [overviewLoaded, setOverviewLoaded] = useState(false);
  const [singleKeyEnabled, setSingleKeyEnabled] = useSingleKeyShortcuts();

  const openPalette = useCallback(() => {
    setPaletteLoaded(true);
    setPaletteOpen(true);
  }, []);
  const openOverview = useCallback(() => {
    setOverviewLoaded(true);
    setOverviewOpen(true);
  }, []);
  const onShortcut = useCallback(
    (action: ShortcutAction) => {
      if (action === 'overview') openOverview();
      else openPalette();
    },
    [openOverview, openPalette],
  );
  useGlobalShortcuts({ singleKeyEnabled }, onShortcut);

  return (
    <div className="flex min-h-dvh bg-surface-page text-fg">
      <SkipLink targetId={MAIN_ID} />
      <Sidebar collapsed={collapsed} onToggle={toggle} />
      <NavDrawer open={drawerOpen} onOpenChange={setDrawerOpen} />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="sticky top-0 z-chrome">
          <BreakGlassBanner />
          <GroupsStaleNotice />
          <SessionTimers />
          <Header
            onOpenMenu={() => {
              setDrawerOpen(true);
            }}
            onOpenSearch={openPalette}
          />
        </div>
        <BreadcrumbsBar />
        <main
          id={MAIN_ID}
          tabIndex={-1}
          className="mx-auto w-full max-w-content flex-1 px-4 py-6 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring sm:px-6"
        >
          <Outlet />
        </main>
      </div>
      <StepUpDialog />
      <Suspense fallback={null}>
        {paletteLoaded ? (
          <CommandPalette
            open={paletteOpen}
            onOpenChange={setPaletteOpen}
            onShortcuts={openOverview}
          />
        ) : null}
        {overviewLoaded ? (
          <ShortcutsOverview
            open={overviewOpen}
            onOpenChange={setOverviewOpen}
            singleKeyEnabled={singleKeyEnabled}
            onSingleKeyChange={setSingleKeyEnabled}
          />
        ) : null}
      </Suspense>
    </div>
  );
}
