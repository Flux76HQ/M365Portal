// A scheduler the test owns: timers fire when the test says time has passed, never on the wall clock
// (plan 13.2: timing is never tested with sleeps). It has the shape of `Scheduler` in
// `src/lifecycle/sweepers.ts`, so the sweeper registry and the shutdown sequence take it as given.
import type { Scheduler } from '../../src/lifecycle/sweepers.js';

interface Timer {
  readonly id: number;
  readonly callback: () => void;
  readonly every: number | undefined;
  due: number;
}

export interface FakeScheduler extends Scheduler {
  /** Let `milliseconds` pass; every timer that falls due fires, in order of its due time. */
  advance(milliseconds: number): void;
  /** How many timers are armed (a cleared or fired one-shot timer is not). */
  pending(): number;
}

export function createFakeScheduler(): FakeScheduler {
  const timers = new Map<number, Timer>();
  let now = 0;
  let nextId = 1;

  const add = (callback: () => void, ms: number, every: number | undefined): number => {
    const id = nextId;
    nextId += 1;
    timers.set(id, { id, callback, every, due: now + ms });
    return id;
  };

  const remove = (handle: unknown): void => {
    if (typeof handle === 'number') timers.delete(handle);
  };

  return {
    setTimeout: (callback, ms) => add(callback, ms, undefined),
    clearTimeout: remove,
    setInterval: (callback, ms) => add(callback, ms, ms),
    clearInterval: remove,
    pending: () => timers.size,
    advance(milliseconds) {
      const target = now + milliseconds;
      for (;;) {
        const next = [...timers.values()]
          .filter((timer) => timer.due <= target)
          .sort((a, b) => a.due - b.due || a.id - b.id)[0];
        if (next === undefined) break;
        now = next.due;
        if (next.every === undefined) timers.delete(next.id);
        else next.due += next.every;
        next.callback();
      }
      now = target;
    },
  };
}
