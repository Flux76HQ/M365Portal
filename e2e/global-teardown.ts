// Stops the three processes and removes the run directory (their DATA_DIRs, logs, storage states and
// the state file). Runs after an aborted run too; a `kill -9` of the runner is the only way to leave a
// `m365portal-e2e-*` directory behind.
import { existsSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { INSTANCE_NAMES, readState, stopProcess } from './servers.js';

export default async function globalTeardown(): Promise<void> {
  const file = process.env.E2E_STATE_FILE;
  if (file === undefined || !existsSync(file)) return;
  const state = readState();
  for (const name of INSTANCE_NAMES) {
    const pid = state.instances[name].pid;
    if (pid > 0) await stopProcess(pid);
  }
  if (state.fakePid > 0) await stopProcess(state.fakePid);
  rmSync(dirname(file), { recursive: true, force: true });
}
