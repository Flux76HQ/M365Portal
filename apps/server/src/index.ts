// The process entry (the composition root, FR-A-012): read the environment, run the start sequence
// of `start.ts`, and tie the signals to the shutdown sequence. Nothing else lives here.
//
// A failed start ends the process with the exit code of the failure (1 for every refusal) before the
// port opens; the log already says why, by code, never with a value.
import { installShutdownSignals, StartError, startServer, type RunningServer } from './start.js';

// The signals are tied first: the `listening` line is written inside `startServer`, and a signal that
// arrives between that line and the end of the start would otherwise meet no handler and kill the
// process with the default action. Until the server runs, a signal waits for it and then stops it.
let ready!: (server: RunningServer) => void;
const started = new Promise<RunningServer>((resolve) => {
  ready = resolve;
});
installShutdownSignals({ stop: async (signal) => (await started).stop(signal) });

try {
  ready(await startServer({ env: process.env }));
} catch (error) {
  if (error instanceof StartError) process.exit(error.exitCode);
  // Not a refusal we know: say what kind of failure it was (never its message) and stop.
  const name = error instanceof Error ? error.name : typeof error;
  process.stderr.write(`start_failed: unexpected ${name}\n`);
  process.exit(1);
}
