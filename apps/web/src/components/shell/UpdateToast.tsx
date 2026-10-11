import { useEffect, useSyncExternalStore } from 'react';
import { getApiClient, type ApiClient } from '../../lib/api';
import { useTranslator } from '../../lib/locale';
import { getServiceWorkerClient, type ServiceWorkerClient } from '../../lib/sw-register';
import { useToast } from '../ui/toast';

export interface UpdateToastProps {
  /** Defaults to the API client of the page: it knows when the server runs another version (E-21). */
  readonly api?: ApiClient;
  /** Defaults to the service worker client of the page. */
  readonly client?: ServiceWorkerClient;
}

/**
 * Shows "Update available" as a toast that stays until it is answered, when either a new worker is
 * waiting or the server reports a version other than this bundle's. Accepting is the only thing that
 * activates the new worker (FR-A-141). It renders nothing itself: the toast region belongs to the
 * toast provider the router wraps around the app, so this component is mounted below that provider.
 */
export function UpdateToast({
  api = getApiClient(),
  client = getServiceWorkerClient(),
}: UpdateToastProps) {
  const { t } = useTranslator();
  const { toast, dismiss } = useToast();
  const serverIsNewer = useSyncExternalStore(
    api.updateAvailable.subscribe,
    api.updateAvailable.get,
  );
  const workerWaiting = useSyncExternalStore(
    client.updateWaiting.subscribe,
    client.updateWaiting.get,
  );
  const available = serverIsNewer || workerWaiting;

  // The server runs another version: ask the browser for the new worker now, so accepting can use it.
  useEffect(() => {
    if (serverIsNewer) client.checkForUpdate();
  }, [serverIsNewer, client]);

  useEffect(() => {
    if (!available) return undefined;
    const id = toast({
      title: t('pwa.update.title'),
      description: t('pwa.update.description'),
      tone: 'info',
      duration: Infinity,
      action: {
        label: t('pwa.update.action'),
        altText: t('pwa.update.actionAlt'),
        onAction: () => {
          client.acceptUpdate();
        },
      },
    });
    return () => {
      dismiss(id);
    };
  }, [available, client, toast, dismiss, t]);

  return null;
}
