// Starts the two instances of the production build with a fresh temporary DATA_DIR each
// (FR-A-157). The state file in the run directory is what `servers.ts` (the workers) and
// `global-teardown.ts` read. A server already answering on one of the ports fails the run on
// purpose: it would serve a stale build.
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  INSTANCE_NAMES,
  isRunning,
  portOf,
  repoRoot,
  spawnInstance,
  stopProcess,
  writeState,
  type ServersState,
} from './servers.js';

export default async function globalSetup(): Promise<void> {
  for (const output of ['apps/server/dist/index.js', 'apps/web/dist/index.html']) {
    if (!existsSync(join(repoRoot, output))) {
      throw new Error(
        `${output} is missing: run pnpm build first (the e2e tests need the production build)`,
      );
    }
  }
  for (const name of INSTANCE_NAMES) {
    if (await isRunning(name)) {
      throw new Error(
        `port ${String(portOf(name))} already answers: stop that server or set E2E_PORT (the ${name} instance needs it, and so does E2E_PORT + 1 for the anonymous one)`,
      );
    }
  }

  const runDir = mkdtempSync(join(tmpdir(), 'm365portal-e2e-'));
  process.env.E2E_STATE_FILE = join(runDir, 'state.json');
  const state: Partial<ServersState> = {};
  try {
    for (const name of INSTANCE_NAMES) {
      const dataDir = join(runDir, `data-${name}`);
      mkdirSync(dataDir);
      state[name] = { port: portOf(name), dataDir, pid: 0 };
      writeState(state as ServersState);
      const pid = await spawnInstance(name, dataDir, join(runDir, 'logs'));
      state[name].pid = pid;
      writeState(state as ServersState);
    }
  } catch (error) {
    for (const name of INSTANCE_NAMES) {
      const pid = state[name]?.pid ?? 0;
      if (pid > 0) await stopProcess(pid);
    }
    rmSync(runDir, { recursive: true, force: true });
    throw error;
  }
}
