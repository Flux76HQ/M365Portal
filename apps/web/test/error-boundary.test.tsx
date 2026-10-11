//
// THE ERROR BOUNDARIES (FR-A-112, FR-A-130; E-20; PD-19; US-5.7; T-A-169).
//
// A failure at the root (`me` cannot be loaded) and a failure inside one page show the translated message
// and the request id when there is one, and never a stack trace or the server's English text. An unknown
// problem code shows the generic message with the code and the request id. The root boundary stands
// alone; the route boundary leaves the shell in place.
import { createTranslator } from '@m365portal/shared/i18n';
import { createMemoryHistory, createRoute, type AnyRoute } from '@tanstack/react-router';
import { QueryClient } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { RootError } from '../src/components/pages/RootError';
import { RouteError } from '../src/components/pages/RouteError';
import { RootProviders } from '../src/components/pages/root-providers';
import { ApiError, NetworkError, createApiClient } from '../src/lib/api';
import { createLanguageController } from '../src/lib/locale';
import { createAppRouter } from '../src/router';
import { createStorage } from '../src/lib/storage';
import { renderShell } from './helpers/render-shell';

const en = createTranslator('en');
const nl = createTranslator('nl');

function apiError(code: string, requestId: string | null, status = 500): ApiError {
  return new ApiError({
    code,
    status,
    requestId,
    errors: [],
    expectedOrigin: null,
    retryAfterSeconds: null,
  });
}

/** A boundary mounted on its own, with a language and a router (the buttons use it). */
async function mountBoundary(
  Boundary: typeof RootError | typeof RouteError,
  error: unknown,
  language: 'en' | 'nl' = 'en',
  reset: () => void = () => undefined,
) {
  const api = createApiClient({
    buildVersion: null,
    fetch: () => Promise.reject(new Error('offline')),
  });
  const queryClient = new QueryClient();
  const router = createAppRouter(createMemoryHistory({ initialEntries: ['/'] }), {
    queryClient,
    api,
  });
  const controller = createLanguageController({
    storage: createStorage(null),
    languages: [language],
    root: document.createElement('html'),
  });
  // The boundary renders in place of the page, so the router tree is not needed: the providers are.
  const { LanguageProvider } = await import('../src/lib/locale');
  const { QueryClientProvider } = await import('@tanstack/react-query');
  const { RouterContextProvider } = await import('@tanstack/react-router');
  const view = render(
    <QueryClientProvider client={queryClient}>
      <LanguageProvider controller={controller}>
        <RouterContextProvider router={router}>
          <Boundary error={error as Error} reset={reset} info={undefined} />
        </RouterContextProvider>
      </LanguageProvider>
    </QueryClientProvider>,
  );
  return { ...view, router, user: userEvent.setup() };
}

describe.each([
  ['the root boundary', RootError, 'errors.root.title', 'errors.root.description'],
  ['the route boundary', RouteError, 'errors.route.title', 'errors.route.description'],
] as const)('%s', (_name, Boundary, titleKey, descriptionKey) => {
  it('shows the translated title, description and the translated message of the problem code', async () => {
    await mountBoundary(Boundary, apiError('internal_error', 'req-abc-123'));

    expect(screen.getByRole('heading', { level: 1, name: en.t(titleKey) })).toBeInTheDocument();
    expect(screen.getByText(en.t(descriptionKey))).toBeInTheDocument();
    expect(screen.getByText(en.t('problem.internal_error'))).toBeInTheDocument();
  });

  it('shows the request id when there is one', async () => {
    await mountBoundary(Boundary, apiError('internal_error', 'req-abc-123'));

    expect(screen.getByText(en.t('errors.requestId'))).toBeInTheDocument();
    expect(screen.getByText('req-abc-123')).toBeInTheDocument();
  });

  it('does not show a request id line when there is none', async () => {
    await mountBoundary(Boundary, apiError('internal_error', null));

    expect(screen.queryByText(en.t('errors.requestId'))).not.toBeInTheDocument();
  });

  it('shows the generic message with the code and the request id for a code it does not know (E-20)', async () => {
    await mountBoundary(Boundary, apiError('flux_capacitor_failure', 'req-777'));

    expect(
      screen.getByText(
        en.t('problem.unknown', { code: 'flux_capacitor_failure', requestId: 'req-777' }),
      ),
    ).toBeInTheDocument();
  });

  it('never shows a stack, an exception message or a path', async () => {
    const error = new Error('ENOENT: /srv/secret-path/file.db');
    error.stack = 'Error: ENOENT\n    at readSecret (/srv/secret-path/file.js:12:3)';
    await mountBoundary(Boundary, error);

    const text = document.body.textContent;
    expect(text).not.toContain('secret-path');
    expect(text).not.toContain('ENOENT');
    expect(text).not.toContain('at readSecret');
    // The generic message names a code of its own instead.
    expect(
      screen.getByText(en.t('problem.unknown', { code: 'client_error', requestId: '-' })),
    ).toBeInTheDocument();
  });

  it('says it got no answer for a network failure, without the exception text', async () => {
    await mountBoundary(
      Boundary,
      new NetworkError('fetch failed: getaddrinfo ENOTFOUND internal.host'),
    );

    expect(document.body.textContent).not.toContain('internal.host');
    // The generic message, with a code of its own that tells support what kind of failure it was.
    expect(
      screen.getByText(en.t('problem.unknown', { code: 'network_error', requestId: '-' })),
    ).toBeInTheDocument();
  });

  it('never shows the English detail of the server', async () => {
    const error = apiError('permission_denied', 'req-1', 403);
    (error as { message: string }).message = 'Detail: the Frobnicator refused you';
    await mountBoundary(Boundary, error);

    expect(document.body.textContent).not.toContain('Frobnicator');
    expect(screen.getByText(en.t('problem.permission_denied'))).toBeInTheDocument();
  });

  it('is in Dutch when the page is Dutch', async () => {
    await mountBoundary(Boundary, apiError('internal_error', 'req-9'), 'nl');

    expect(screen.getByRole('heading', { level: 1, name: nl.t(titleKey) })).toBeInTheDocument();
    expect(screen.getByText(nl.t('problem.internal_error'))).toBeInTheDocument();
    expect(screen.getByText(nl.t('errors.requestId'))).toBeInTheDocument();
  });

  it('is an alert, so it is announced when it appears', async () => {
    await mountBoundary(Boundary, apiError('internal_error', 'req-9'));

    expect(screen.getByRole('alert')).toHaveTextContent(en.t(titleKey));
  });

  it('offers to try again, which resets the boundary', async () => {
    const reset = vi.fn();
    const { user } = await mountBoundary(
      Boundary,
      apiError('internal_error', 'req-9'),
      'en',
      reset,
    );

    await user.click(screen.getByRole('button', { name: en.t('errors.retry') }));

    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('offers a way back to the dashboard', async () => {
    await mountBoundary(Boundary, apiError('internal_error', 'req-9'));

    expect(screen.getByRole('link', { name: en.t('errors.home') })).toHaveAttribute('href', '/');
  });
});

describe('in the application', () => {
  it('the root boundary stands alone when `me` cannot be loaded', async () => {
    const api = createApiClient({
      buildVersion: null,
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              type: 'https://m365portal.invalid/problems/internal_error',
              title: 'Internal error',
              status: 500,
              detail: 'The Frobnicator exploded',
              code: 'internal_error',
              requestId: 'req-root-1',
            }),
            { status: 500, headers: { 'content-type': 'application/problem+json' } },
          ),
        ),
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createAppRouter(createMemoryHistory({ initialEntries: ['/'] }), {
      queryClient,
      api,
    });
    render(
      <RootProviders
        router={router}
        queryClient={queryClient}
        language={createLanguageController({
          storage: createStorage(null),
          languages: ['en'],
          root: document.createElement('html'),
        })}
      />,
    );

    expect(
      await screen.findByRole('heading', { level: 1, name: en.t('errors.root.title') }),
    ).toBeInTheDocument();
    expect(screen.getByText('req-root-1')).toBeInTheDocument();
    expect(screen.getByText(en.t('problem.internal_error'))).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('Frobnicator');
    // Without `me` there is no shell to draw.
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
  });

  it('the route boundary leaves the shell in place when one page throws', async () => {
    function Broken(): never {
      throw new Error('boom at /srv/secret-path');
    }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await renderShell({
      path: '/broken',
      extraRoutes: (root: AnyRoute) => [
        createRoute({
          getParentRoute: () => root,
          path: '/broken',
          staticData: { titleKey: 'nav.users' },
          component: Broken,
        }),
      ],
    });

    const main = await screen.findByRole('main');
    expect(
      await within(main).findByRole('heading', { level: 1, name: en.t('errors.route.title') }),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('secret-path');
    expect(
      screen.getByRole('navigation', { name: en.t('a11y.mainNavigation') }),
    ).toBeInTheDocument();
    spy.mockRestore();
  });

  it('retry runs the page again (the boundary resets and the router reloads)', async () => {
    let failing = true;
    function Flaky() {
      // React renders a component that throws a second time before it gives up, so the flag, not a
      // counter, decides.
      if (failing) throw new Error('the page is down');
      return <h1>Recovered page</h1>;
    }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { user } = await renderShell({
      path: '/flaky',
      extraRoutes: (root: AnyRoute) => [
        createRoute({ getParentRoute: () => root, path: '/flaky', component: Flaky }),
      ],
    });
    const retry = await screen.findByRole('button', { name: en.t('errors.retry') });
    failing = false;

    await user.click(retry);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Recovered page' }),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
    spy.mockRestore();
  });

  it('gives a page whose loader failed a title that says so', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await renderShell({
      path: '/loads',
      extraRoutes: (root: AnyRoute) => [
        createRoute({
          getParentRoute: () => root,
          path: '/loads',
          staticData: { titleKey: 'nav.users' },
          loader: () => {
            throw apiError('internal_error', 'req-loader-1');
          },
          component: () => <h1>Never shown</h1>,
        }),
      ],
    });

    expect(
      await screen.findByRole('heading', { level: 1, name: en.t('errors.route.title') }),
    ).toBeInTheDocument();
    expect(screen.getByText('req-loader-1')).toBeInTheDocument();
    await waitFor(() => {
      expect(document.title).toBe(`${en.t('errors.route.title')} - Acme`);
    });
    spy.mockRestore();
  });
});
