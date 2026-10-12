import { useSyncExternalStore } from 'react';
import { secondsLeft } from './countdown';

/** Calls `notify` every second while subscribed. */
function everySecond(notify: () => void): () => void {
  const interval = setInterval(notify, 1000);
  return () => {
    clearInterval(interval);
  };
}

/** The current second: a number that changes once a second, so a render reads a stable value. */
function currentSecond(): number {
  return Math.floor(Date.now() / 1000);
}

/** The whole seconds left until `untilMs`, read again every second. */
export function useSecondsLeft(untilMs: number): number {
  const second = useSyncExternalStore(everySecond, currentSecond);
  return secondsLeft(untilMs, second * 1000);
}
