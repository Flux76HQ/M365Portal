import { Outlet } from '@tanstack/react-router';
import { lazy, Suspense, useCallback, useState } from 'react';
import { useSidebarState } from '../../lib/sidebar';
import {
  useGlobalShortcuts,
  useSingleKeyShortcuts,
  type ShortcutAction,
} from '../../lib/shortcuts';
import { BreadcrumbsBar } from './BreadcrumbsBar';
import { Header } from './Header';
import { PreviewBanner } from './PreviewBanner';
import { NavDrawer, Sidebar } from './Sidebar';
import { SkipLink } from './SkipLink';

// The palette (with cmdk) and the overview are lazy chunks: nothing of them is in the entry (plan 9.3).
const CommandPalette = lazy(() => import('./CommandPalette'));
const ShortcutsOverview = lazy(() => import('./ShortcutsOverview'));

/** The id of the `main` landmark, the target of the skip link. */
export const MAIN_ID = 'main-content';

/**
 * The frame of every page (plan 9.5): skip link, sidebar (a drawer below 768 px), the preview banner,
 * the header, breadcrumbs and exactly one `main` landmark that holds the page, capped at 1600 px and
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
        <PreviewBanner />
        <Header
          onOpenMenu={() => {
            setDrawerOpen(true);
          }}
          onOpenSearch={openPalette}
        />
        <BreadcrumbsBar />
        <main
          id={MAIN_ID}
          tabIndex={-1}
          className="mx-auto w-full max-w-content flex-1 px-4 py-6 outline-none sm:px-6"
        >
          <Outlet />
        </main>
      </div>
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
