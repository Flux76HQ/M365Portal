import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { NetworkError } from '../../lib/api';
import { useTranslator } from '../../lib/locale';
import { Banner } from '../ui/banner';
import { Button } from '../ui/button';

// The offline state (FR-A-142 API part, E-08, A-55): when the browser is offline, or a request got no
// answer at all, the page says so in the person's language and the save buttons switch off. Nothing is
// queued and nothing is replayed: coming back online enables the buttons, and the person saves again.

/** The id of the explanation, for `aria-describedby` on a disabled save button. */
export const OFFLINE_STATE_ID = 'offline-state';

function subscribeToConnection(listener: () => void): () => void {
  window.addEventListener('online', listener);
  window.addEventListener('offline', listener);
  return () => {
    window.removeEventListener('online', listener);
    window.removeEventListener('offline', listener);
  };
}

const browserIsOnline = (): boolean => navigator.onLine;
const assumeOnline = (): boolean => true;

/** `navigator.onLine`, live. */
export function useOnlineStatus(): boolean {
  return useSyncExternalStore(subscribeToConnection, browserIsOnline, assumeOnline);
}

export interface OfflineSave {
  /** The browser is offline, or the last request got no answer. */
  readonly offline: boolean;
  /** Put this on every save, apply and import button of a page. */
  readonly saveDisabled: boolean;
  /** The id of the explanation to point `aria-describedby` at; undefined when saving is possible. */
  readonly describedBy: string | undefined;
  /** Forget the failure at hand: the person is about to try again. */
  readonly tryAgain: () => void;
}

/**
 * Whether saving is possible. `error` is the last failure of a request of the page (a query or a
 * mutation); only a `NetworkError` counts (the server answered, so it is reachable). The failure is
 * forgotten when the browser says it is online (the event fires after a reconnect) and when the person
 * asks to try again: a failure that stays put while the server is back would keep the button disabled
 * for good. The next failure is a new error object and counts again.
 */
export function useOfflineSave(error?: unknown): OfflineSave {
  const online = useOnlineStatus();
  const [forgotten, setForgotten] = useState<unknown>(null);
  const latest = useRef(error);
  useEffect(() => {
    latest.current = error;
  });

  const tryAgain = useCallback(() => {
    setForgotten(latest.current);
  }, []);

  useEffect(() => {
    window.addEventListener('online', tryAgain);
    return () => {
      window.removeEventListener('online', tryAgain);
    };
  }, [tryAgain]);

  const lost = error instanceof NetworkError && error !== forgotten;
  const offline = !online || lost;
  return {
    offline,
    saveDisabled: offline,
    describedBy: offline ? OFFLINE_STATE_ID : undefined,
    tryAgain,
  };
}

export interface OfflineStateProps {
  /**
   * The result of `useOfflineSave` that the page's buttons use, so the explanation and the buttons
   * agree (they share what was forgotten). Without it the component works from `error` alone.
   */
  readonly save?: OfflineSave;
  /** The last failure of a request of the page. */
  readonly error?: unknown;
  /** Lets the person try the request again. */
  readonly onRetry?: () => void;
}

/** The explanation. Renders nothing while saving is possible. */
export function OfflineState({ save, error, onRetry }: OfflineStateProps) {
  const { t } = useTranslator();
  const own = useOfflineSave(error);
  const { offline, tryAgain } = save ?? own;
  const retry = useCallback(() => {
    tryAgain();
    onRetry?.();
  }, [tryAgain, onRetry]);
  if (!offline) return null;
  return (
    <div id={OFFLINE_STATE_ID} data-slot="offline-state">
      <Banner
        tone="warning"
        title={t('pwa.offline.title')}
        action={
          onRetry === undefined ? undefined : (
            <Button size="sm" onClick={retry}>
              {t('pwa.offline.retry')}
            </Button>
          )
        }
      >
        {t('pwa.offline.description')}
      </Banner>
    </div>
  );
}
