// T-D-112, T-D-117: the production build ships the PowerShell worker script next to the bundle, byte for
// byte, at `exchange/worker-script.ps1`, because the image runs `dist/exchange/worker-script.ps1`
// (Dockerfile, scripts/image-smoke.ts). The build is run for real into a scratch directory.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ALLOW_LIST_MANIFEST_SHA256,
  PROJECTION_MANIFEST_SHA256,
} from '../../src/integrations/exchange/pwsh/generated-allow-list.js';

const SERVER = fileURLToPath(new URL('../..', import.meta.url));
const SOURCE = join(SERVER, 'src/integrations/exchange/pwsh/worker-script.ps1');
const scratch = mkdtempSync(join(tmpdir(), 'm365-build-'));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('the build copies the worker script', () => {
  it('puts worker-script.ps1 under <outdir>/exchange, identical to the source, with both hashes in it', () => {
    const done = spawnSync(process.execPath, [join(SERVER, 'build.mjs'), '--outdir', scratch], {
      encoding: 'utf8',
    });
    expect(done.status, done.stderr).toBe(0);
    const built = readFileSync(join(scratch, 'exchange', 'worker-script.ps1'), 'utf8');
    expect(built).toBe(readFileSync(SOURCE, 'utf8'));
    expect(built).toContain(ALLOW_LIST_MANIFEST_SHA256);
    expect(built).toContain(PROJECTION_MANIFEST_SHA256);
  }, 60_000);
});
