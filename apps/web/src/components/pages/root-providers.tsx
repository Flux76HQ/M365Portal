import { PRODUCT_NAME } from '@m365portal/shared';
import type { MessageKey } from '@m365portal/shared/i18n';
import { RouterProvider, useRouterState } from '@tanstack/react-router';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { useEffect, type ReactNode } from 'react';
import { useApplyBrandingToShell } from '../../features/branding/apply-to-shell';
import { LanguageProvider, useTranslator, type LanguageController } from '../../lib/locale';
import { accessOf } from '../../lib/gating';
import { useBranding } from '../../lib/router-context';
import type { AppStorage } from '../../lib/storage';
import { StorageProvider } from '../../lib/storage-context';
import type { AppRouter } from '../../router';
import { UpdateToast } from '../shell/UpdateToast';
import { MotionProvider } from '../ui/motion-provider';
import { ToastProvider } from '../ui/toast';

// The providers of the application, outermost first (plan 9.1):
//
//   Query      the cache that holds `me` and `branding`, seeded from the boot data
//   storage    where the components remember their choices (sidebar, shortcuts, table columns)
//   language   the translator and the way to switch language
//   Motion     LazyMotion and MotionConfig, with the CSP nonce for the styles Motion injects
//   Router     the routes
//   Toast      mounted by the router (its `Wrap` option), inside RouterProvider, so a toast action
//              may use the router and every route can show a toast
//
// Toast needs the translator, so it sits inside the language provider; the document title needs the
// router state, so it is the router's `InnerWrap`. Both are set in router.ts (`baseRouterOptions`).

export interface RootProvidersProps {
  readonly router: AppRouter;
  readonly queryClient: QueryClient;
  /** The page's language controller; defaults to the one of the document. */
  readonly language?: LanguageController;
  /** The CSP nonce of the page (src/boot/nonce-shim.ts reads it from the meta tag). */
  readonly nonce?: string;
  /** The storage the components remember their choices in; defaults to the one of the page. */
  readonly storage?: AppStorage;
}

export function RootProviders({
  router,
  queryClient,
  language,
  nonce,
  storage,
}: RootProvidersProps) {
  return (
    <QueryClientProvider client={queryClient}>
      <StorageProvider storage={storage}>
        <LanguageProvider controller={language}>
          <MotionProvider nonce={nonce}>
            <RouterProvider router={router} />
          </MotionProvider>
        </LanguageProvider>
      </StorageProvider>
    </QueryClientProvider>
  );
}

/** The router's `Wrap`: the toast region and the toasts, labelled in the language of the page. */
export function AppToastProvider({ children }: { readonly children: ReactNode }) {
  const { t } = useTranslator();
  return (
    <ToastProvider
      regionLabel={t('common.notifications')}
      notificationLabel={t('common.notification')}
      closeLabel={t('common.close')}
    >
      <UpdateToast />
      {children}
    </ToastProvider>
  );
}

/** Did the router mark this match as the one that answers an address it has no page for? */
function isUnmatched(match: object): boolean {
  return (match as { _notFound?: boolean })._notFound === true;
}

/**
 * The router's `InnerWrap`: keeps `document.title` at `<page> - <organisation name>`. The page part is
 * the translated `titleKey` of the deepest route that has one; the organisation name is data and is
 * never translated. A page without a title key shows the organisation name alone.
 */
export function DocumentTitleSync({ children }: { readonly children: ReactNode }) {
  const { t } = useTranslator();
  const titleKey = useRouterState({
    select: (state): MessageKey | undefined => {
      // A page that failed or that does not exist says so in its title; a page that was found has its own.
      if (state.matches.some((match) => match.status === 'error')) return 'errors.route.title';
      const verdict = accessOf(state.matches.at(-1)?.context);
      if (verdict === 'denied') return 'nav.noAccess';
      if (verdict === 'missing') return 'pages.notFound.title';
      // `_notFound` marks the route that answers an unknown URL; `notFound` status a route that said so itself.
      if (state.matches.some((match) => match.status === 'notFound' || isUnmatched(match))) {
        return 'pages.notFound.title';
      }
      return state.matches.findLast((match) => match.staticData.titleKey)?.staticData.titleKey;
    },
  });
  const organisation = useBranding()?.orgName ?? PRODUCT_NAME;
  // The accent, theme colour and icons follow the saved branding (T-A-215, seam of S5 in S4's file).
  useApplyBrandingToShell();

  useEffect(() => {
    document.title = titleKey === undefined ? organisation : `${t(titleKey)} - ${organisation}`;
  }, [t, titleKey, organisation]);

  return <>{children}</>;
}
