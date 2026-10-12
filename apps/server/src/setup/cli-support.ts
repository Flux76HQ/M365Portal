// What the two setup commands (`setup-token`, `setup-reopen`) share: the configuration, the existing
// database and the setup state. Opening for writing would create an empty database, so only a
// database that exists and holds the `setup_state` row is used; otherwise the command says the
// server has to be started once first.
import { existsSync } from 'node:fs';
import type { CommandIo } from '../cli.js';
import { formatConfigIssues, loadConfig } from '../config/index.js';
import type { AppConfig } from '../config/env.js';
import { databasePathOf, openDatabase, type AppDatabase } from '../db/open.js';
import { systemRandom } from '../system-random.js';
import { SetupStateRepository, type SetupStateRow } from './state.js';

export interface SetupCommandScene {
  readonly config: AppConfig;
  readonly database: AppDatabase;
  readonly repository: SetupStateRepository;
  readonly state: SetupStateRow;
}

/** The scene of a command, or the exit code to return (after the reason went to standard error). */
export function openSetupScene(
  command: string,
  io: CommandIo,
  now: () => number,
): { readonly scene: SetupCommandScene } | { readonly exit: number } {
  const loaded = loadConfig(io.env);
  if (!loaded.ok) {
    io.stderr.write(formatConfigIssues(loaded.issues));
    return { exit: 2 };
  }
  const { config } = loaded;
  const path = databasePathOf(config.dataDir);
  const refuse = (): { readonly exit: number } => {
    io.stderr.write(
      `${command}: refused: there is no usable setup state in DATA_DIR; start the server once first\n`,
    );
    return { exit: 1 };
  };
  if (!existsSync(path)) return refuse();
  let database: AppDatabase;
  try {
    database = openDatabase({ path });
  } catch {
    return refuse();
  }
  const repository = new SetupStateRepository({
    now,
    random: io.random ?? systemRandom,
  });
  try {
    return { scene: { config, database, repository, state: repository.read(database) } };
  } catch {
    database.close();
    return refuse();
  }
}
