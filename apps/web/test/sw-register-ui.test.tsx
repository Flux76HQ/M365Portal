// The two shell pieces of the PWA (FR-A-141, FR-A-142 API part; E-21, E-08): the "Update available"
// toast and the offline state with the save switch. Extra control next to sw-register.test.ts (TA-08).
import { createTranslator } from '@m365portal/shared/i18n';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { OfflineState, useOfflineSave } from '../src/components/shell/OfflineState';
import { UpdateToast } from '../src/components/shell/UpdateToast';
import { ToastProvider } from '../src/components/ui/toast';
import { ApiError, NetworkError, createApiClient } from '../src/lib/api';
import { LanguageProvider, createLanguageController } from '../src/lib/locale';
import { createStorage } from '../src/lib/storage';
import type { ServiceWorkerClient } from '../src/lib/sw-register';

function controller(language: 'en' | 'nl') {
  return createLanguageController({
    storage: createStorage(null),
    languages: [language],
    root: document.createElement('html'),
  });
}

function fakeClient() {
  let waiting = false;
  const listeners = new Set<() => void>();
  const client: ServiceWorkerClient = {
    register: vi.fn(() => Promise.resolve(true)),
    updateWaiting: {
      get: () => waiting,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    acceptUpdate: vi.fn(),
    checkForUpdate: vi.fn(),
  };
  return {
    client,
    setWaiting() {
      waiting = true;
      act(() => {
        for (const listener of listeners) listener();
      });
    },
  };
}

function mount(language: 'en' | 'nl', ui: React.ReactNode) {
  return render(
    <LanguageProvider controller={controller(language)}>
      <ToastProvider regionLabel="Notifications" closeLabel="Close">
        {ui}
      </ToastProvider>
    </LanguageProvider>,
  );
}

describe('UpdateToast', () => {
  it('shows nothing while the app is current', () => {
    const { client } = fakeClient();
    mount('en', <UpdateToast api={createApiClient({ buildVersion: '1.0.0' })} client={client} />);
    expect(screen.queryByText('Update available')).toBeNull();
    expect(client.checkForUpdate).not.toHaveBeenCalled();
  });

  it('shows the translated toast when a worker is waiting, and accepting activates it', async () => {
    const { client, setWaiting } = fakeClient();
    mount('nl', <UpdateToast api={createApiClient({ buildVersion: '1.0.0' })} client={client} />);
    setWaiting();
    const t = createTranslator('nl').t;
    expect(await screen.findByText(t('pwa.update.title'))).toBeInTheDocument();
    expect(t('pwa.update.title')).toBe('Update beschikbaar');
    await userEvent.click(screen.getByRole('button', { name: t('pwa.update.action') }));
    expect(client.acceptUpdate).toHaveBeenCalledTimes(1);
  });

  it('shows the toast and asks for a new worker when the server reports another version (E-21)', async () => {
    const { client } = fakeClient();
    const api = createApiClient({ buildVersion: '1.0.0' });
    mount('en', <UpdateToast api={api} client={client} />);
    act(() => {
      api.observeVersion('1.0.1');
    });
    expect(await screen.findByText('Update available')).toBeInTheDocument();
    expect(client.checkForUpdate).toHaveBeenCalledTimes(1);
  });

  it('does not show the toast for the same version', () => {
    const { client } = fakeClient();
    const api = createApiClient({ buildVersion: '1.0.0' });
    mount('en', <UpdateToast api={api} client={client} />);
    act(() => {
      api.observeVersion('1.0.0');
    });
    expect(screen.queryByText('Update available')).toBeNull();
  });
});

function SaveForm({ error, onRetry }: { readonly error?: unknown; readonly onRetry?: () => void }) {
  const save = useOfflineSave(error);
  return (
    <>
      <OfflineState save={save} onRetry={onRetry} />
      <button type="button" disabled={save.saveDisabled} aria-describedby={save.describedBy}>
        Save
      </button>
    </>
  );
}

describe('the offline state', () => {
  it('is absent and leaves save enabled while the connection works', () => {
    mount('en', <SaveForm />);
    expect(screen.queryByText('You are offline')).toBeNull();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('shows in the page language and disables save after a failure without an answer', () => {
    mount('nl', <SaveForm error={new NetworkError('offline')} />);
    expect(screen.getByText('Je bent offline')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/niets in de wachtrij/);
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    expect(save).toHaveAccessibleDescription(/Je bent offline/);
  });

  it('is not triggered by an answer of the server, however bad', () => {
    mount(
      'en',
      <SaveForm
        error={
          new ApiError({
            code: 'internal_error',
            status: 500,
            requestId: null,
            errors: [],
            expectedOrigin: null,
            retryAfterSeconds: null,
          })
        }
      />,
    );
    expect(screen.queryByText('You are offline')).toBeNull();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('follows the browser: offline event disables save, online event enables it again', () => {
    mount('en', <SaveForm />);
    const online = vi.spyOn(window.navigator, 'onLine', 'get');
    online.mockReturnValue(false);
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(screen.getByText('You are offline')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    online.mockReturnValue(true);
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    expect(screen.queryByText('You are offline')).toBeNull();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    online.mockRestore();
  });

  it('enables save again when the connection returns, though the old error is still there', () => {
    mount('en', <SaveForm error={new NetworkError('offline')} />);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('enables save again when the person asks to try again, and calls back once', async () => {
    const retry = vi.fn();
    mount('en', <SaveForm error={new NetworkError('server stopped')} onRetry={retry} />);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    expect(screen.queryByText('You are offline')).toBeNull();
  });

  it('offers a retry that calls back, and queues nothing itself', async () => {
    const retry = vi.fn();
    mount('en', <OfflineState error={new NetworkError('offline')} onRetry={retry} />);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
