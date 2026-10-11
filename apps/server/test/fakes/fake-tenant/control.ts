// The control surface of the fake tenant (T-B-063): what a test turns to make Microsoft misbehave.
// The base has the crash switch; the Entra, Graph and Exchange modules add their toggles to the same
// object through `FakeTenantControl` (types.ts) when they land.
import type { FakeTenantClock, FakeTenantControl } from './types.js';

/** The client's view of a connection that died after the server had done its work. */
export class SimulatedNetworkFailure extends TypeError {
  constructor() {
    super('fetch failed', {
      cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
    });
    this.name = 'SimulatedNetworkFailure';
  }
}

export interface ControlState {
  /** Mutating calls since the last reset. */
  mutatingCalls: number;
  crashAt: number | null;
}

export function createControl(clock: FakeTenantClock, state: ControlState): FakeTenantControl {
  return {
    crashAfterMutating(n) {
      if (!Number.isInteger(n) || n < 1) {
        throw new RangeError('crashAfterMutating takes a whole number from 1');
      }
      state.crashAt = n;
    },
    cancelCrash() {
      state.crashAt = null;
    },
    get pendingCrash() {
      return state.crashAt;
    },
    now: () => clock.now(),
  };
}
