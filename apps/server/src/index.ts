// The process entry (the composition root, FR-A-012): read the environment, run the start sequence
// of `start.ts`, and tie the signals to the shutdown sequence. Nothing else lives here.
//
// A failed start ends the process with the exit code of the failure (1 for every refusal) before the
// port opens; the log already says why, by code, never with a value. SIGTERM and SIGINT run the
// shutdown; the handlers are installed explicitly because the process is PID 1 in the container and
// PID 1 gets no default action for a signal.
import { StartError, startServer, type RunningServer } from './start.js';

let running: RunningServer;
try {
  running = await startServer({ env: process.env });
} catch (error) {
  if (error instanceof StartError) process.exit(error.exitCode);
  // Not a refusal we know: say what kind of failure it was (never its message) and stop.
  const name = error instanceof Error ? error.name : typeof error;
  process.stderr.write(`start_failed: unexpected ${name}\n`);
  process.exit(1);
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void running.stop(signal).then((code) => {
      process.exit(code);
    });
  });
}
