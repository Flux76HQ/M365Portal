// Shared by the branding component tests: the language provider the components read their words from,
// and a toast region for the ones that raise a toast. Not a test file.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { ToastProvider } from '../../src/components/ui/toast';
import { createApiClient, type ApiClient, type FetchFunction } from '../../src/lib/api';
import { LanguageProvider, createLanguageController } from '../../src/lib/locale';
import { createStorage } from '../../src/lib/storage';

export function languageController(language: 'en' | 'nl') {
  return createLanguageController({
    storage: createStorage(null),
    languages: [language],
    root: document.createElement('html'),
  });
}

export function renderInLanguage(ui: ReactElement, language: 'en' | 'nl' = 'en') {
  const user = userEvent.setup();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <LanguageProvider controller={languageController(language)}>
        <ToastProvider regionLabel="Notifications" closeLabel="Close">
          {ui}
        </ToastProvider>
      </LanguageProvider>
    </QueryClientProvider>,
  );
  return { user, queryClient, ...view };
}

// ---------------------------------------------------------------------------------------------
// A fake network for the components that call the branding routes
// ---------------------------------------------------------------------------------------------

export interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: BodyInit | null | undefined;
  readonly signal: AbortSignal | null | undefined;
}

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  return new Response(JSON.stringify(body), { status: 200, ...init, headers });
}

export function problemResponse(
  status: number,
  code: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response {
  return new Response(
    JSON.stringify({
      type: `urn:m365portal:problem:${code}`,
      title: 'English title',
      status,
      detail: 'English detail',
      code,
      requestId: 'req-0123456789',
      ...extra,
    }),
    { status, headers: { 'Content-Type': 'application/problem+json', ...headers } },
  );
}

/**
 * An API client over a fake `fetch`. `handler` answers every request except the CSRF token. It may
 * return a promise, so a test can hold a request open.
 */
export function fakeApi(
  handler: (call: RecordedCall) => Response | Promise<Response>,
): { readonly api: ApiClient; readonly calls: RecordedCall[]; readonly writes: () => RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const send: FetchFunction = (input, init) => {
    const call: RecordedCall = {
      url: input,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: init?.body,
      signal: init?.signal,
    };
    if (new URL(input, 'http://panel.test').pathname === '/api/v1/csrf') {
      return Promise.resolve(
        jsonResponse({ token: 'throwaway-token-value', expiresAt: '2099-01-01T00:00:00.000Z' }),
      );
    }
    calls.push(call);
    return Promise.resolve(handler(call));
  };
  return {
    api: createApiClient({ fetch: send, buildVersion: null }),
    calls,
    writes: () => calls.filter((call) => call.method !== 'GET'),
  };
}
