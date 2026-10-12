// T-B-131: the lifetime of the bootstrap tokens (FR-B-215). The access and refresh tokens of the device
// code flow live only in the MSAL cache of the single bootstrap object. They are never persisted,
// logged, audited, serialised or returned, and the object is discarded on every end condition.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotConnectedError } from '../../src/ports/errors.js';
import type { BootstrapAuthenticator } from '../../src/ports/identity.js';
import { subActionRegistry } from '../../src/setup/steps/index.js';
import { tenantScene, useWizardTimers, type TenantScene } from './support/tenant-scene.js';

beforeEach(() => {
  useWizardTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Remember every token the fake Entra hands out, and the authenticators the wizard creates. */
function watch(scene: TenantScene) {
  const tokens = new Set<string>();
  const authenticators: BootstrapAuthenticator[] = [];
  const original = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const response = await original(input, init);
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/oauth2/v2.0/token') && response.status === 200) {
      const body = (await response.clone().json()) as Record<string, unknown>;
      for (const name of ['access_token', 'refresh_token', 'id_token']) {
        const value = body[name];
        if (typeof value === 'string' && value.length > 20) tokens.add(value);
      }
    }
    return response;
  });
  const create = scene.clients.createBootstrap.bind(scene.clients);
  vi.spyOn(scene.clients, 'createBootstrap').mockImplementation(() => {
    const created = create();
    authenticators.push(created);
    return created;
  });
  return { tokens, authenticators };
}

function everything(scene: TenantScene): string {
  const tables = scene.rows<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  );
  const database = tables.map(({ name }) => JSON.stringify(scene.rows(`SELECT * FROM "${name}"`))).join('\n');
  const snapshot = JSON.stringify(scene.engine.snapshot(0));
  return `${database}\n${scene.logs.text()}\n${snapshot}`;
}

async function cacheIsEmpty(authenticator: BootstrapAuthenticator | undefined): Promise<boolean> {
  if (authenticator === undefined) return false;
  try {
    await authenticator.bearer()();
    return false;
  } catch (failure) {
    return failure instanceof NotConnectedError;
  }
}

describe('a signed-in bootstrap', () => {
  it('holds tokens that are in no table, log line, audit row or snapshot, and the bearer works while it lives', async () => {
    const scene = await tenantScene();
    const seen = watch(scene);
    await scene.run(['connect']);
    expect(seen.tokens.size).toBeGreaterThanOrEqual(2);
    const text = everything(scene);
    for (const token of seen.tokens) expect(text).not.toContain(token);
    // The provisioner makes its delegated calls with it.
    expect(scene.services.bootstrap.live()).toBe(true);
    expect(await scene.services.bootstrap.provisioner()?.findServicePrincipalByAppId('00000003-0000-0000-c000-000000000000')).not.toBeNull();
  });
});

describe('the cache is empty after each end condition', () => {
  it('failure: a refused sign-in', async () => {
    const scene = await tenantScene();
    const seen = watch(scene);
    scene.startRun(['connect']);
    await scene.drive({ approve: false, maxSeconds: 2 });
    scene.world.entra.control.device.decline();
    await scene.drive({ approve: false, maxSeconds: 30 });
    await scene.engine.idle();
    expect(await cacheIsEmpty(seen.authenticators.at(-1))).toBe(true);
    expect(scene.services.bootstrap.lastDiscard()).toBe('failure');
  });

  it('timeout: the device code expires', async () => {
    const scene = await tenantScene();
    const seen = watch(scene);
    scene.startRun(['connect']);
    await scene.drive({ approve: false, maxSeconds: 2 });
    scene.world.entra.control.device.expire();
    await scene.drive({ approve: false, maxSeconds: 30 });
    await scene.engine.idle();
    expect(await cacheIsEmpty(seen.authenticators.at(-1))).toBe(true);
  });

  it('cancel: the run stops, the object is discarded and so is a sign-in that had completed', async () => {
    const scene = await tenantScene({
      registry: [
        ...subActionRegistry(),
        {
          step: 'configure',
          key: 'application',
          run: async (ctx) => {
            await ctx.wait(10 * 60_000);
            return { status: 'succeeded' };
          },
        },
      ],
    });
    const seen = watch(scene);
    scene.startRun(['connect', 'configure']);
    await scene.drive({ until: () => scene.services.bootstrap.live(), maxSeconds: 30 });
    expect(scene.services.bootstrap.live()).toBe(true);
    scene.engine.cancel();
    await scene.engine.idle();
    expect(scene.services.bootstrap.live()).toBe(false);
    expect(scene.services.bootstrap.lastDiscard()).toBe('cancel');
    expect(await cacheIsEmpty(seen.authenticators[0])).toBe(true);
  });

  it('setup session expiry (idle 60 minutes) discards it, and so does ending the last session', async () => {
    const scene = await tenantScene();
    const seen = watch(scene);
    await scene.run(['connect']);
    scene.services.sessions.create();
    await scene.elapse(61 * 60_000);
    scene.services.sessions.sweep();
    expect(scene.services.bootstrap.live()).toBe(false);
    expect(scene.services.bootstrap.lastDiscard()).toBe('session_end');
    expect(await cacheIsEmpty(seen.authenticators[0])).toBe(true);

    // Ending the last session explicitly does the same.
    await scene.run(['connect'], { mode: 'reconcile' });
    expect(scene.services.bootstrap.live()).toBe(true);
    const session = scene.services.sessions.create();
    const hash = (await import('../../src/policy/session-hash.js')).hashSessionId(session.id);
    scene.services.sessions.end(hash);
    expect(scene.services.bootstrap.live()).toBe(false);
  });

  it('process exit: stop() discards it', async () => {
    const scene = await tenantScene();
    const seen = watch(scene);
    await scene.run(['connect']);
    await scene.engine.stop();
    expect(scene.services.bootstrap.live()).toBe(false);
    expect(scene.services.bootstrap.lastDiscard()).toBe('exit');
    expect(await cacheIsEmpty(seen.authenticators[0])).toBe(true);
  });

  it('discard is idempotent', async () => {
    const scene = await tenantScene();
    await scene.run(['connect']);
    scene.services.bootstrap.discard('exit');
    expect(() => {
      scene.services.bootstrap.discard('exit');
    }).not.toThrow();
  });
});

describe('no cache plugin', () => {
  it('no source of the wizard or the bootstrap authenticator configures a cachePlugin', () => {
    const files = [
      '../../src/integrations/identity/bootstrap.ts',
      '../../src/setup/steps/connect.ts',
      '../../src/setup/bootstrap-slot.ts',
      '../../src/setup/runner.ts',
    ];
    for (const file of files) {
      const text = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
      expect(text, file).not.toMatch(/cachePlugin|serialize\(|deserialize\(/);
    }
  });
});
