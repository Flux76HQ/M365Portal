// `setup-token` (T-B-124, FR-B-203, EB-01): prints the setup token and a newline, creating the token
// file first if it is not there yet, while the state is not `completed`. With the state `completed` it
// refuses (exit 1) and names the command that reopens setup. The token is printed to standard output
// only, never to a log; when `SETUP_TOKEN` is set in the environment of the command, that is the token.
import type { CommandIo } from '../../cli.js';
import { SetupToken } from '../../setup/token.js';
import { openSetupScene } from '../../setup/cli-support.js';
import { systemRandom } from '../../system-random.js';

export const SETUP_TOKEN_USAGE = 'usage: node dist/cli.js setup-token\n';

export function runSetupToken(args: readonly string[], io: CommandIo): Promise<number> {
  if (args.length > 0) {
    io.stderr.write(SETUP_TOKEN_USAGE);
    return Promise.resolve(2);
  }
  const opened = openSetupScene('setup-token', io);
  if ('exit' in opened) return Promise.resolve(opened.exit);
  const { config, database, state } = opened.scene;
  try {
    if (state.state === 'completed') {
      io.stderr.write(
        'setup-token: refused: setup is completed and there is no token; run "setup-reopen --confirm" to reopen it\n',
      );
      return Promise.resolve(1);
    }
    const token = new SetupToken({
      envToken: config.setupToken,
      dataDir: config.dataDir,
      random: io.random ?? systemRandom,
    });
    token.ensureFile();
    const value = token.reveal();
    if (value === undefined) {
      io.stderr.write('setup-token: refused: the token file could not be read\n');
      return Promise.resolve(1);
    }
    io.stdout.write(`${value}\n`);
    return Promise.resolve(0);
  } catch {
    io.stderr.write('setup-token: failed: the token file could not be created in DATA_DIR\n');
    return Promise.resolve(1);
  } finally {
    database.close();
  }
}
