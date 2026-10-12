// STUB (T-B-021): `setup-token` is owned by S-B3 (setup engine), handed over at gate GB0 (tasks.md
// section 1.3); the real command lands with T-B-124. Until then it answers "not implemented in this
// build" and exits 2, so the dispatcher, the usage text and the tests already know the command.
import type { CommandIo } from '../../cli.js';

export function runSetupToken(_args: readonly string[], io: CommandIo): Promise<number> {
  io.stderr.write('setup-token: not implemented in this build\n');
  return Promise.resolve(2);
}
