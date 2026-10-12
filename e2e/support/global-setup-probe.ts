// Runs the global setup in a process of its own and reports the outcome in the exit code: 0 and the
// line `SETUP_OK` when it seeded the topology (then it tears it down again), 1 and the error on
// standard error when it did not. Used by fixtures-selftest.spec.ts to see a failing seed fail loudly
// (T-B-370). Needs its own E2E_PORT block and E2E_SABOTAGE_SEED to fail on purpose.
import globalSetup from './global-setup.js';
import globalTeardown from '../global-teardown.js';

try {
  await globalSetup();
  process.stdout.write('SETUP_OK\n');
  await globalTeardown();
} catch (error) {
  process.stderr.write(`SETUP_FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  await globalTeardown().catch(() => undefined);
  process.exit(1);
}
