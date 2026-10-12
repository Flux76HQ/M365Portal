import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Banner } from '../../components/ui/banner';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { currentReturnTo, signInUrl } from '../../lib/auth-nav';
import { useTranslator } from '../../lib/locale';
import { meQueryOptions } from '../../lib/query';
import { useMe, useRouterContext } from '../../lib/router-context';
import { formatCountdown } from './countdown';
import { useSecondsLeft } from './use-seconds-left';
import { useAuthRuntime, useSessionSnapshot } from './runtime';
import { useSignOut } from './use-sign-out';

/** The dialog opens this long before the idle deadline (FR-B-416). */
export const IDLE_WARNING_MS = 2 * 60_000;
/** The notice appears this long before the absolute end (FR-B-416). */
export const EXPIRY_NOTICE_MS = 5 * 60_000;
/** A timeout cannot be longer than this (a 32-bit number of milliseconds). */
const MAX_TIMEOUT_MS = 2_147_483_647;

type Phase = 'ok' | 'notice' | 'idle' | 'expired';

interface Deadlines {
  readonly idle: number;
  readonly absolute: number;
  /** A break-glass session never slides and has no warnings: its banner counts down. */
  readonly warns: boolean;
}

function phaseAt(now: number, { idle, absolute, warns }: Deadlines): Phase {
  if (now >= Math.min(idle, absolute)) return 'expired';
  if (!warns) return 'ok';
  if (now >= idle - IDLE_WARNING_MS) return 'idle';
  if (now >= absolute - EXPIRY_NOTICE_MS) return 'notice';
  return 'ok';
}

/** The next moment at which the phase changes, or null when nothing is left to wait for. */
function nextChange(now: number, { idle, absolute, warns }: Deadlines): number | null {
  const marks = [Math.min(idle, absolute)];
  if (warns) marks.push(idle - IDLE_WARNING_MS, absolute - EXPIRY_NOTICE_MS);
  const future = marks.filter((mark) => mark > now);
  return future.length === 0 ? null : Math.min(...future);
}

/**
 * Timing adjustable (FR-B-416, WCAG 2.2.1; plan 12.4). Mounted for a signed-in user and for a break-glass
 * session:
 *   - two minutes before the idle deadline, a dialog with "Sessie verlengen", which calls
 *     `GET /api/v1/me` (that slides the session); the deadline is the last `X-Session-Idle-Expires`
 *     the client saw, so any request that slides the session moves it and closes the dialog;
 *   - five minutes before the absolute end, a polite notice;
 *   - at either end, the sign-in page with `error=session_expired` and the current page as `returnTo`.
 * A break-glass session has no idle window: its banner shows the countdown, and this component only
 * sends the browser to the sign-in page at the end.
 */
export function SessionTimers() {
  const me = useMe();
  const snapshot = useSessionSnapshot();
  const session = me.session;
  if (session === null || (me.actor.kind !== 'user' && me.actor.kind !== 'break_glass'))
    return null;
  const absolute = Date.parse(session.expiresAt);
  const warns = me.actor.kind === 'user';
  const idle = warns ? (snapshot.idleExpiresAt ?? Date.parse(session.idleExpiresAt)) : absolute;
  return <Timers idle={idle} absolute={absolute} warns={warns} />;
}

function Timers({ idle, absolute, warns }: Deadlines) {
  const { location } = useAuthRuntime();

  // The phase is read from the clock and re-read at the moments it can change: the subscription arms a
  // timer for the next of those moments each time, so the boundaries are exact and nothing polls.
  const subscribe = useCallback(
    (notify: () => void) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const arm = () => {
        const now = Date.now();
        const next = nextChange(now, { idle, absolute, warns });
        if (next === null) return;
        timer = setTimeout(
          () => {
            notify();
            arm();
          },
          Math.min(next - now, MAX_TIMEOUT_MS),
        );
      };
      arm();
      return () => {
        clearTimeout(timer);
      };
    },
    [idle, absolute, warns],
  );
  const phase = useSyncExternalStore(subscribe, () =>
    phaseAt(Date.now(), { idle, absolute, warns }),
  );

  // At the end, go to the sign-in page, once.
  const left = useRef(false);
  useEffect(() => {
    if (phase !== 'expired' || left.current) return;
    left.current = true;
    location.replace(signInUrl({ error: 'session_expired', returnTo: currentReturnTo(location) }));
  }, [phase, location]);

  if (phase === 'idle') return <IdleDialog idle={idle} />;
  if (phase === 'notice') return <ExpiryNotice absolute={absolute} />;
  return null;
}

function ExpiryNotice({ absolute }: { readonly absolute: number }) {
  const { t, d } = useTranslator();
  return (
    <Banner tone="warning" data-testid="session-notice">
      {t('session.expiry.notice', { time: d(new Date(absolute), { timeStyle: 'short' }) })}
    </Banner>
  );
}

function IdleDialog({ idle }: { readonly idle: number }) {
  const { t } = useTranslator();
  const { api } = useRouterContext();
  const queryClient = useQueryClient();
  const { store } = useAuthRuntime();
  const signOut = useSignOut();
  const seconds = useSecondsLeft(idle);
  const [dismissedFor, setDismissedFor] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  const extend = useCallback(async () => {
    setPending(true);
    setFailed(false);
    try {
      // A request with a valid session slides it; the deadline arrives in the header of the answer.
      const me = await queryClient.query({ ...meQueryOptions(api), staleTime: 0, retry: false });
      store.noteMeSession(me.session);
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  }, [api, queryClient, store]);

  return (
    <Dialog
      open={dismissedFor !== idle}
      onOpenChange={(open) => {
        if (!open) setDismissedFor(idle);
      }}
      title={t('session.idle.title')}
      description={t('session.idle.message', { time: formatCountdown(seconds) })}
      closeLabel={t('session.close')}
      size="sm"
      initialFocus="[data-extend]"
      footer={
        <>
          <Button
            variant="secondary"
            onClick={() => {
              void signOut(false);
            }}
          >
            {t('session.idle.signOut')}
          </Button>
          <Button
            variant="primary"
            data-extend=""
            disabled={pending}
            aria-busy={pending ? true : undefined}
            onClick={() => {
              void extend();
            }}
          >
            {t('session.idle.extend')}
          </Button>
        </>
      }
    >
      {failed ? (
        <p role="alert" className="text-body text-danger">
          {t('session.idle.extendFailed')}
        </p>
      ) : null}
    </Dialog>
  );
}
