import { Outlet } from '@tanstack/react-router';
import { BreakGlassBanner } from '../../features/auth/BreakGlassBanner';
import { MAIN_ID } from './main-id';
import { LanguageSwitcher } from './LanguageSwitcher';
import { SkipLink } from './SkipLink';
import { ThemeSwitcher } from './ThemeSwitcher';

/**
 * The frame of the public pages (T-B-297, T-B-298; FR-B-607, FR-B-608): the sign-in page, the no-access
 * page, the break-glass form and the setup wizard. There is no sidebar and no navigation: the visitor
 * has no session, so there is nothing to navigate to, and the page shows the organisation mark and name
 * itself. The header keeps what any visitor may change, the theme and the language, and the page keeps
 * exactly one `main` landmark with a skip link in front of it.
 */
export function BareLayout() {
  return (
    <div className="flex min-h-dvh flex-col bg-surface-page text-fg">
      <SkipLink targetId={MAIN_ID} />
      <BreakGlassBanner />
      <header
        data-slot="header"
        className="glass-header sticky top-0 z-chrome flex h-14 shrink-0 items-center justify-end gap-2 border-b border-line-subtle px-4"
      >
        <ThemeSwitcher className="hidden sm:inline-flex" />
        <LanguageSwitcher />
      </header>
      <main
        id={MAIN_ID}
        tabIndex={-1}
        className="mx-auto w-full max-w-content flex-1 px-4 py-6 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring sm:px-6"
      >
        <Outlet />
      </main>
    </div>
  );
}
