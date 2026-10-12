// Polling the run snapshot (T-B-300; FR-B-211 web half, SB-19; plan 12.5). One request per second while a
// run is active or the device code is on screen, one per two seconds in a hidden tab, with the cursor
// `after=<seq>` so only new log lines travel. Polling stops by itself when nothing is happening and
// starts again when the page starts a run (`poke`). The clock is the page's `setTimeout`, so a test with
// fake timers moves it by hand.
//
// The state is a small external store read with `useSyncExternalStore`: no `setState` in an effect (the
// lint rule `react-hooks/set-state-in-effect` is on), and a render always reads one consistent value.
import { LIMITS } from '@m365portal/shared/limits';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ApiClient } from '../../lib/api';
import { connectionApi, type LogLine, type RunSnapshot } from './setup-api';

export const POLL_INTERVAL_MS = 1000;
export const POLL_INTERVAL_HIDDEN_MS = 2000;
/** The page keeps this many lines, the number the server keeps. */
export const LOG_LINES_KEPT = 1000;

export interface RunPollState {
  /** The last snapshot, or null before the first answer. */
  readonly snapshot: RunSnapshot | null;
  /** Every line seen so far, oldest first. */
  readonly lines: readonly LogLine[];
  /** The server dropped older lines than the ones shown. */
  readonly truncated: boolean;
  /** The last request failed (cleared by the next answer). */
  readonly error: unknown;
  /** The server's clock minus this browser's at the last answer (0 before the first). */
  readonly offsetMs: number;
}

export interface RunPoller {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getState: () => RunPollState;
  /** Starts polling (one request now). */
  readonly start: () => void;
  readonly stop: () => void;
  /** A run was just started or changed: ask now and keep asking while it is active. */
  readonly poke: () => void;
  /** Ask once now (the page changed something that shows in the snapshot) without assuming a run. */
  readonly refresh: () => void;
}

export interface RunPollerOptions {
  readonly api: ApiClient;
  /** Called once each time an active run (or device code) has ended. */
  readonly onSettled?: (snapshot: RunSnapshot) => void;
  /** Is the tab visible? Defaults to the document's state. */
  readonly visible?: () => boolean;
}

/** Does the snapshot say something is going on that the page should keep watching? */
export function isActive(snapshot: RunSnapshot | null): boolean {
  if (snapshot === null) return false;
  const run = snapshot.run;
  if (run !== null && (run.status === 'running' || run.status === 'waiting')) return true;
  return snapshot.deviceCode?.state === 'waiting_for_user' || snapshot.adoption !== null;
}

const INITIAL: RunPollState = Object.freeze({ snapshot: null, lines: [], truncated: false, error: null, offsetMs: 0 });

export function createRunPoller(options: RunPollerOptions): RunPoller {
  const api = connectionApi(options.api);
  const visible = options.visible ?? (() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  const listeners = new Set<() => void>();
  let state: RunPollState = INITIAL;
  let cursor = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let inFlight = false;
  let again = false;
  let wasActive = false;
  let controller: AbortController | undefined;

  function publish(next: RunPollState): void {
    state = next;
    for (const listener of [...listeners]) listener();
  }

  function schedule(): void {
    if (!running) return;
    clearTimeout(timer);
    timer = setTimeout(() => void poll(), visible() ? POLL_INTERVAL_MS : POLL_INTERVAL_HIDDEN_MS);
  }

  async function poll(): Promise<void> {
    if (!running) return;
    if (inFlight) {
      again = true;
      return;
    }
    inFlight = true;
    controller = new AbortController();
    try {
      const snapshot = await api.snapshot(cursor, controller.signal);
      if (!running) return;
      // A line is shown once: whatever the server repeats (or a slow answer that arrives twice) is dropped.
      const fresh = snapshot.log.lines.filter((line) => line.seq > cursor);
      cursor = Math.max(cursor, snapshot.log.lastSeq);
      const lines = fresh.length === 0 ? state.lines : [...state.lines, ...fresh].slice(-LOG_LINES_KEPT);
      publish({
        snapshot,
        lines,
        truncated: state.truncated || snapshot.log.truncated,
        error: null,
        offsetMs: Date.parse(snapshot.serverTime) - Date.now(),
      });
      const active = isActive(snapshot);
      if (wasActive && !active) options.onSettled?.(snapshot);
      wasActive = active;
      if (active || again) schedule();
      else if (!active) {
        // Nothing to watch: stop until `poke`. (A failed request below keeps trying.)
        clearTimeout(timer);
        timer = undefined;
      }
    } catch (error) {
      if (!running) return;
      publish({ ...state, error });
      // A failed request is tried again: the run may well be going on.
      schedule();
    } finally {
      inFlight = false;
      if (again && running) {
        again = false;
        void poll();
      }
    }
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getState: () => state,
    start() {
      if (running) return;
      running = true;
      void poll();
    },
    stop() {
      running = false;
      clearTimeout(timer);
      timer = undefined;
      controller?.abort();
    },
    refresh() {
      if (!running) return;
      clearTimeout(timer);
      void poll();
    },
    poke() {
      if (!running) return;
      wasActive = true;
      clearTimeout(timer);
      void poll();
    },
  };
}

export interface UseRunPolling {
  readonly state: RunPollState;
  readonly poke: () => void;
  readonly refresh: () => void;
}

/** The run snapshot of the page, polled while something is going on. */
export function useRunPolling(options: RunPollerOptions): UseRunPolling {
  const settled = useRef(options.onSettled);
  useEffect(() => {
    settled.current = options.onSettled;
  });
  // One poller per mounted wizard; the API client is the page's and never changes.
  const [poller] = useState(() =>
    createRunPoller({ ...options, onSettled: (snapshot) => settled.current?.(snapshot) }),
  );
  useEffect(() => {
    poller.start();
    return () => {
      poller.stop();
    };
  }, [poller]);
  const state = useSyncExternalStore(poller.subscribe, poller.getState);
  return { state, poke: poller.poke, refresh: poller.refresh };
}

// The number the page and the server agree on, so a page never asks for more lines than a window holds.
export const LOG_WINDOW = LIMITS.setup.logPageMax;
