// The services of the setup module (T-B-129, T-B-139): the repositories, the gate, the token, the
// sessions and the bootstrap slot, built once from `ModuleDeps`. The engine and the routes take this
// one object; nothing else builds a repository.
import type { ModuleDeps } from '../module.js';
import { createSetupGate } from './availability.js';
import { createBootstrapSlot } from './bootstrap-slot.js';
import type { SetupServices } from './context.js';
import { SetupLog } from './log.js';
import { createSetupSessions, type EmptyReason } from './session.js';
import { SetupStateRepository } from './state.js';
import { SetupStepRepository } from './step-repository.js';
import { TenantConnectionRepository } from './tenant-connection.js';
import { SetupToken } from './token.js';

export interface SetupServicesOptions {
  /** Called when the last setup session ended or expired (FR-B-215c): the bootstrap is discarded. */
  readonly onSessionsEmpty?: (reason: EmptyReason) => void;
}

export function createSetupServices(
  deps: ModuleDeps,
  options: SetupServicesOptions = {},
): SetupServices {
  const clock = { now: deps.now };
  const state = new SetupStateRepository({ now: clock.now, random: deps.random });
  const gate = createSetupGate({ config: deps.config, database: deps.database, repository: state });
  const bootstrap = createBootstrapSlot();
  return {
    deps,
    log: deps.log.child({ module: 'setup' }),
    state,
    steps: new SetupStepRepository(clock),
    wizardLog: new SetupLog(clock),
    connections: new TenantConnectionRepository(clock),
    gate,
    token: new SetupToken({
      envToken: deps.config.setupToken,
      dataDir: deps.config.dataDir,
      random: deps.random,
    }),
    sessions: createSetupSessions({
      now: clock.now,
      random: deps.random,
      isOpen: () => gate.stateOpen(),
      onEmpty: (reason) => {
        bootstrap.discard('session_end');
        options.onSessionsEmpty?.(reason);
      },
    }),
    bootstrap,
  };
}
