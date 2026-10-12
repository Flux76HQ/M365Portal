// A stand-in for the setup sessions that the setup module keeps in memory (T-B-125): the resolver reads
// them through `SetupSessionReader`, and a test that needs the setup actor registers a session here.
// `end()` is what the end of a setup session (the explicit `DELETE`, the idle deadline, the state
// `completed`) looks like to the resolver.
import type { SetupSessionReader } from '../../src/policy/index.js';

export interface FakeSetupSessions extends SetupSessionReader {
  add(idHash: string): void;
  remove(idHash: string): void;
  /** Every setup session ends at once. */
  end(): void;
}

export function createFakeSetupSessions(now: () => string): FakeSetupSessions {
  const live = new Set<string>();
  return {
    find: (idHash) => (live.has(idHash) ? { createdAt: now() } : undefined),
    add: (idHash) => {
      live.add(idHash);
    },
    remove: (idHash) => {
      live.delete(idHash);
    },
    end: () => {
      live.clear();
    },
  };
}
