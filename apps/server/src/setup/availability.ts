// The availability gate of the setup routes (T-B-126, FR-B-201, FR-B-206, FR-B-207, plan 9.2): the one
// predicate `AppModule.availability.setupOpen` the route wrapper calls. Setup exists for a request when
//
//   - the state is not `completed` (read from the database on every call; a CLI reopen takes effect
//     at once), and
//   - the loopback guard passes (only over a plain-http base URL).
//
// A closed gate makes the route not exist: the wrapper answers it like an unknown path. In degraded
// mode (no database at all, EB-33) the gate stays open for a request the guard lets through, so that a
// setup route answers 503 `storage_unavailable` like every route that needs storage; a database that is
// open but has no readable state row closes the gate: nothing about setup is shown to a process that
// cannot say what state it is in.
import type { SetupState } from '@m365portal/shared/setup/steps';
import type { AppConfig } from '../config/env.js';
import type { DatabaseHandle } from '../db/index.js';
import { loopbackGuardOpen } from './loopback-guard.js';
import type { SetupStateRepository } from './state.js';

export interface SetupGate {
  /** The state now, or `undefined` without a database. */
  state(): SetupState | undefined;
  /** Does the loopback guard let this request reach setup? */
  guardOpen(request: Request): boolean;
  /** `setupOpen`: the state is not `completed` and the guard passes. */
  isOpen(request: Request): boolean;
  /** Is the setup open at all, whoever asks? (The sessions exist only while it is.) */
  stateOpen(): boolean;
}

export interface SetupGateDeps {
  readonly config: Pick<AppConfig, 'publicIsHttps'>;
  readonly database: () => DatabaseHandle | undefined;
  readonly repository: SetupStateRepository;
}

export function createSetupGate(deps: SetupGateDeps): SetupGate {
  const state = (): SetupState | undefined => deps.repository.stateOf(deps.database());
  const guardOpen = (request: Request): boolean => {
    let urlHost: string | undefined;
    try {
      urlHost = new URL(request.url).host;
    } catch {
      urlHost = undefined;
    }
    return loopbackGuardOpen({
      publicIsHttps: deps.config.publicIsHttps,
      headers: request.headers,
      ...(urlHost === undefined ? {} : { urlHost }),
    });
  };
  const stateOpen = (): boolean => {
    const current = state();
    return current !== undefined && current !== 'completed';
  };
  return {
    state,
    guardOpen,
    stateOpen,
    isOpen: (request) => {
      if (!guardOpen(request)) return false;
      return deps.database() === undefined || stateOpen();
    },
  };
}
