// The Lighthouse harness's view of the e2e topology (T-B-380). Started by run.mjs through tsx: it
// runs the e2e global setup (fake tenant, instance A configured, instance B empty, the owner signed
// in), prints ONE json line with what the harness needs, and keeps the servers up until stdin closes
// or a signal arrives; then it runs the e2e teardown. The owner cookie goes to the harness on that
// line only, never to a file or a log.
import { readFileSync } from 'node:fs';
import globalTeardown from '../global-teardown.js';
import { fakeControl } from '../support/fake-control.js';
import globalSetup, { storageStateFile } from '../support/global-setup.js';
import { originOf } from '../support/ports.js';
import { statesDir } from '../servers.js';

interface StoredCookie {
  readonly name: string;
  readonly value: string;
}

async function main(): Promise<void> {
  await globalSetup();
  const stored = JSON.parse(readFileSync(storageStateFile(statesDir(), 'owner'), 'utf8')) as {
    cookies: StoredCookie[];
  };
  const cookie = stored.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  // Phase C (FR-C-508): the seeded directory, so that /users and /groups are measured with a full page of
  // rows, and one user and one group (with owners and members) give the detail pages their addresses.
  const seeded = await fakeControl('a').seedDirectory();
  const directory = {
    user: seeded.ids.userWithManager ?? null,
    group: seeded.ids.m365Group ?? null,
  };
  process.stdout.write(
    `${JSON.stringify({ a: originOf('a'), b: originOf('b'), ownerCookie: cookie, directory })}\n`,
  );
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    globalTeardown().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.stdin.resume();
  process.stdin.on('end', stop);
  process.stdin.on('close', stop);
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((error: unknown) => {
  process.stderr.write(`topology: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
});
