// T-D-112, T-D-114 (part B): where the server finds the generated worker script. The build copies it next to
// the bundle (`dist/exchange/worker-script.ps1`, build.mjs); under tsx and Vitest it is read from the source
// tree. The path must pass the launcher's own check (an absolute path of safe characters, no `..`).
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildWorkerArguments } from '../../src/integrations/exchange/pwsh/worker-launcher.js';
import { defaultExchangeScript } from '../../src/integrations/exchange/runtime.js';

describe('defaultExchangeScript', () => {
  it('is the file next to the bundle when the build put one there', () => {
    const root = mkdtempSync(join(tmpdir(), 'm365portal-dist-'));
    try {
      mkdirSync(join(root, 'exchange'));
      writeFileSync(join(root, 'exchange', 'worker-script.ps1'), '# test\n');
      expect(defaultExchangeScript(root)).toBe(join(root, 'exchange', 'worker-script.ps1'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is the generated script of the source tree otherwise, and that file exists and is a safe path for pwsh', () => {
    const path = defaultExchangeScript(join(tmpdir(), 'no-such-dist'));
    expect(path.endsWith('/pwsh/worker-script.ps1')).toBe(true);
    const here = defaultExchangeScript();
    expect(existsSync(here)).toBe(true);
    expect(() =>
      buildWorkerArguments({ scriptPath: here, certificateMode: 'memory' }),
    ).not.toThrow();
  });
});
