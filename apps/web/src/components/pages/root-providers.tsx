import { PRODUCT_NAME } from '@m365portal/shared';
import { RouterProvider, useRouterState } from '@tanstack/react-router';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { useEffect, type ReactNode } from 'react';
import { LanguageProvider, useTranslator, type LanguageController } from '../../lib/locale';
import { useBranding } from '../../lib/router-context';
import type { AppRouter } from '../../router';
import { MotionProvider } from '../ui/motion-provider';
import { ToastProvider } from '../ui/toast';

// The providers of the application, outermost first (plan 9.1):
//
//   Query      the cache that holds `me` and `branding`, seeded from the boot data
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
}

export function RootProviders({ router, queryClient, language, nonce }: RootProvidersProps) {
  return (
    <QueryClientProvider client={queryClient}>
      <LanguageProvider controller={language}>
        <MotionProvider nonce={nonce}>
          <RouterProvider router={router} />
        </MotionProvider>
      </LanguageProvider>
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
      {children}
    </ToastProvider>
  );
}

/**
 * The router's `InnerWrap`: keeps `document.title` at `<page> - <organisation name>`. The page part is
 * the translated `titleKey` of the deepest route that has one; the organisation name is data and is
 * never translated. A page without a title key shows the organisation name alone.
 */
export function DocumentTitleSync({ children }: { readonly children: ReactNode }) {
  const { t } = useTranslator();
  const titleKey = useRouterState({
    select: (state) =>
      state.matches.findLast((match) => match.staticData.titleKey)?.staticData.titleKey,
  });
  const organisation = useBranding()?.orgName ?? PRODUCT_NAME;

  useEffect(() => {
    document.title = titleKey === undefined ? organisation : `${t(titleKey)} - ${organisation}`;
  }, [t, titleKey, organisation]);

  return <>{children}</>;
}
