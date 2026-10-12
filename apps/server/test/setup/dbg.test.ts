import { afterEach, beforeEach, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { fake } from '../support/msw.js';
import { tenantScene, useWizardTimers } from './support/tenant-scene.js';
vi.setConfig({ testTimeout: 60_000 });
beforeEach(() => { useWizardTimers(); });
afterEach(() => { vi.useRealTimers(); });
it.each(Array.from({ length: 8 }, (_, i) => i))('dbg %i', async () => {
  const scene = await tenantScene();
  fake.control.crashAfterMutating(9);
  scene.startRun(['connect', 'configure', 'verify']);
  await scene.drive({ maxSeconds: 1500 });
  if (scene.engine.busy()) {
    writeFileSync('/tmp/dbg.out', JSON.stringify({
      run: scene.engine.current(),
      rows: scene.rows("SELECT step, sub_action, status, error_code, attempt, detail FROM setup_step WHERE status NOT IN ('succeeded','pending')"),
      log: scene.rows("SELECT message_key, params FROM setup_log ORDER BY seq DESC LIMIT 8"),
      calls: fake.calls.all().slice(-8).map((c) => `${c.method} ${c.path} ${c.status}`),
    }, null, 1));
    throw new Error('stuck');
  }
});
