// `setup-reopen --confirm` (T-B-124, FR-B-222, FR-B-223, EB-11, EB-37): the one way back from
// `awaiting_first_signin` or `completed` to `in_progress`. It sets the state, issues a new token file,
// writes the audit entry `setup.reopen` (actor `cli`) in the same transaction as the state change, and
// prints the next steps. Existing user sessions continue; sign-in is refused until the wizard has
// finished (`setup_required`). Without `--confirm` it only explains and exits 1. While `SETUP_TOKEN` is
// set in its environment it refuses (exit 1) and names the remedy: the variable would outlive the
// reopen as a standing credential, so the operator removes it, recreates the container, and then the
// token is the generated file that `setup-token` prints.
import type { CommandIo } from '../../cli.js';
import { appendAudit } from '../../audit/index.js';
import { withTransaction } from '../../db/index.js';
import { SetupToken } from '../../setup/token.js';
import { openSetupScene } from '../../setup/cli-support.js';
import { systemRandom } from '../../system-random.js';

export const SETUP_REOPEN_USAGE = 'usage: node dist/cli.js setup-reopen --confirm\n';

const EXPLANATION =
  'setup-reopen: this reopens the setup wizard. The state goes back to in_progress, a new setup token\n' +
  'is issued, and sign-in is refused until the wizard has finished again. Users who are signed in stay\n' +
  'signed in. Run "setup-reopen --confirm" to do it.\n';

export function runSetupReopen(args: readonly string[], io: CommandIo): Promise<number> {
  const confirmed = args.length === 1 && args[0] === '--confirm';
  if (args.length > 1 || (args.length === 1 && !confirmed)) {
    io.stderr.write(SETUP_REOPEN_USAGE);
    return Promise.resolve(2);
  }
  if (!confirmed) {
    io.stderr.write(EXPLANATION);
    return Promise.resolve(1);
  }
  const opened = openSetupScene('setup-reopen', io, io.now ?? (() => Date.now()));
  if ('exit' in opened) return Promise.resolve(opened.exit);
  const { config, database, repository, state } = opened.scene;
  try {
    if (config.setupToken !== undefined) {
      io.stderr.write(
        'setup-reopen: refused: SETUP_TOKEN is set in the environment. Remove the variable, recreate the container, then run "setup-reopen --confirm" again; the token is then the generated file that "setup-token" prints.\n',
      );
      return Promise.resolve(1);
    }
    const now = io.now ?? (() => Date.now());
    const token = new SetupToken({
      envToken: undefined,
      dataDir: config.dataDir,
      random: io.random ?? systemRandom,
    });
    if (state.state === 'unconfigured' || state.state === 'in_progress') {
      token.ensureFile();
      io.stdout.write(
        'setup is already open. Print the token with "setup-token" and open the wizard in the browser.\n',
      );
      return Promise.resolve(0);
    }
    withTransaction(database, (tx) => {
      const { from } = repository.apply(tx, 'reopen');
      appendAudit(tx, {
        ts: new Date(now()).toISOString(),
        actorKind: 'cli',
        actorId: 'cli',
        action: 'setup.reopen',
        targetType: 'setup',
        outcome: 'success',
        detail: { fromState: from },
      });
    });
    // A new token for the new wizard: the old file (if any) is replaced after the commit.
    token.remove();
    token.ensureFile();
    io.stdout.write(
      'setup is reopened (state in_progress).\n' +
        'Next: print the new token with "setup-token", open /setup in the browser, unlock it and finish the wizard.\n' +
        'Sign-in is refused until the wizard has finished again; users who are signed in stay signed in.\n',
    );
    return Promise.resolve(0);
  } catch {
    io.stderr.write('setup-reopen: failed: the state could not be changed (nothing was changed)\n');
    return Promise.resolve(1);
  } finally {
    database.close();
  }
}
