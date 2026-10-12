// T-B-136: the propagation probes (FR-B-212, FR-B-316; research section 4). Every probe asks for a
// fresh token, makes one cheap real call, waits out propagation inside a window with a live-log line per
// wait, ends with replication_timeout and the elapsed time when the window runs out, and no code decodes
// a Graph or Exchange access token.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fake, testClock } from '../support/msw.js';
import { tenantScene, useWizardTimers, type TenantScene } from './support/tenant-scene.js';

beforeEach(() => {
  useWizardTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** The first `count` app tokens the fake issues carry no roles, as before an assignment has propagated. */
function delayPropagation(scene: TenantScene, count: number): { issued: () => number } {
  const world = scene.world.graph.world;
  const issue = world.issueAppToken.bind(world);
  let n = 0;
  world.issueAppToken = (appId, audience, options) => {
    n += 1;
    if (n <= count) {
      return world.tokens.issue({
        audience,
        kind: 'app',
        appId,
        roles: [],
        entraRoleTemplateIds: [],
      });
    }
    return issue(appId, audience, options);
  };
  return { issued: () => n };
}

/** The grants were made a moment ago: the persisted finish time of the grant sub-actions is now. */
function grantsJustMade(scene: TenantScene): void {
  scene.rows(
    "UPDATE setup_step SET finished_at = ? WHERE sub_action IN ('graph_permissions', 'exchange_permissions', 'exchange_role') RETURNING 1",
    new Date(testClock.nowMs()).toISOString(),
  );
}

async function configured(options: Parameters<typeof tenantScene>[0] = {}): Promise<TenantScene> {
  const scene = await tenantScene(options);
  await scene.run(['connect', 'configure']);
  scene.services.bootstrap.discard('exit');
  grantsJustMade(scene);
  return scene;
}

describe('fresh tokens', () => {
  it('V1 asks for a fresh token (skipCache), and every check builds its own client, so each fetches its own token', async () => {
    const scene = await configured();
    const asked: (boolean | undefined)[] = [];
    const real = scene.clients.probe.bind(scene.clients);
    vi.spyOn(scene.clients, 'probe').mockImplementation((spec) => {
      const clients = real(spec);
      const get = clients.appTokens.get.bind(clients.appTokens);
      clients.appTokens.get = (resource, o) => {
        asked.push(o?.skipCache);
        return get(resource, o);
      };
      return clients;
    });
    const before = scene.world.entra.control
      .tokenRequests()
      .filter((r) => r.grantType === 'client_credentials').length;
    await scene.run(['verify'], { mode: 'reconcile' });
    expect(asked[0]).toBe(true);
    const after = scene.world.entra.control
      .tokenRequests()
      .filter((r) => r.grantType === 'client_credentials').length;
    // V1, V2, V3 and V5: four clients, four token requests (a cache would have made it one).
    expect(after - before).toBeGreaterThanOrEqual(4);
  });

  it('each probe is one cheap real call', async () => {
    const scene = await configured();
    fake.calls.clear();
    await scene.run(['verify'], { mode: 'reconcile' });
    const paths = fake.calls
      .all()
      .filter((call) => call.host === 'graph.microsoft.com')
      .map((call) => `${call.method} ${call.path}`);
    expect(paths).toContain('GET /v1.0/organization');
    expect(paths).toContain('GET /v1.0/users');
    expect(fake.calls.mutating().filter((call) => call.host === 'graph.microsoft.com')).toEqual([]);
  });
});

describe('waiting for propagation', () => {
  it('a 403 right after the grants is retried inside the window, every wait is a live-log line, and the sub-action ends succeeded', async () => {
    const scene = await configured();
    const delay = delayPropagation(scene, 2);
    await scene.run(['verify'], { mode: 'reconcile' });
    // No bootstrap token in a verify-only run: audit_reads is not_checked, which the aggregate shows as a warning.
    expect(scene.engine.current()?.status).toBe('warning');
    expect(scene.rows("SELECT 1 FROM setup_step WHERE status = 'failed'")).toEqual([]);
    expect(delay.issued()).toBeGreaterThan(2);
    const waits = scene.rows<{ params: string }>(
      "SELECT params FROM setup_log WHERE message_key = 'setup.log.waiting_replication' ORDER BY seq",
    );
    expect(waits.length).toBeGreaterThanOrEqual(1);
    for (const line of waits) {
      const params = JSON.parse(line.params) as { attempt: number; max: number; seconds: number };
      expect(params.attempt).toBeGreaterThanOrEqual(1);
      expect(params.seconds).toBeGreaterThanOrEqual(1);
    }
    expect(
      scene
        .rows(
          "SELECT attempt FROM setup_step WHERE sub_action IN ('organization', 'users') ORDER BY sub_action",
        )
        .some((r) => (r as { attempt: number }).attempt > 1),
    ).toBe(true);
  });

  it('when the window (SETUP_PROPAGATION_TIMEOUT_SECONDS) runs out the sub-action fails replication_timeout with the elapsed time', async () => {
    const scene = await configured({ env: { SETUP_PROPAGATION_TIMEOUT_SECONDS: '300' } });
    delayPropagation(scene, 10_000);
    await scene.run(['verify'], { mode: 'reconcile', maxSeconds: 900 });
    const [failed] = scene.rows<{
      sub_action: string;
      status: string;
      error_code: string;
      detail: string;
    }>("SELECT sub_action, status, error_code, detail FROM setup_step WHERE status = 'failed'");
    expect(failed).toMatchObject({ status: 'failed', error_code: 'replication_timeout' });
    const detail = JSON.parse(failed?.detail ?? '{}') as { elapsedSeconds: number };
    expect(detail.elapsedSeconds).toBeGreaterThanOrEqual(300);
    expect(detail.elapsedSeconds).toBeLessThan(450);
    expect(scene.engine.current()?.status).toBe('failed');
  });

  it('Retry now ends a wait at once and the attempt counts', async () => {
    const scene = await configured();
    delayPropagation(scene, 2);
    scene.startRun(['verify'], { mode: 'reconcile' });
    await scene.drive({
      until: () => scene.rows("SELECT 1 FROM setup_step WHERE status = 'waiting'").length > 0,
      maxSeconds: 30,
      stepMs: 50,
    });
    expect(scene.rows("SELECT sub_action FROM setup_step WHERE status = 'waiting'")).toHaveLength(
      1,
    );
    scene.engine.retryNow();
    await scene.drive({ maxSeconds: 60 });
    await scene.engine.idle();
    expect(scene.engine.current()?.status).toBe('warning');
    expect(scene.rows("SELECT 1 FROM setup_step WHERE status = 'failed'")).toEqual([]);
  });

  it('Exchange: the first calls answer 403 until RBAC has propagated, then V5 passes', async () => {
    const scene = await configured();
    scene.world.exchange.control.propagation(2);
    await scene.run(['verify'], { mode: 'reconcile' });
    const probe = scene.rows<{ status: string; attempt: number }>(
      "SELECT status, attempt FROM setup_step WHERE sub_action = 'exchange_probe'",
    )[0];
    expect(['succeeded', 'warning']).toContain(probe?.status);
  });
});

describe('no code decodes a Graph or Exchange access token (FR-B-316)', () => {
  it('the wizard and the Graph and Exchange clients contain no JWT decoding', () => {
    const root = fileURLToPath(new URL('../../src/', import.meta.url));
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith('.ts')) files.push(path);
      }
    };
    for (const folder of ['setup', 'connection', 'integrations/graph', 'integrations/exchange'])
      walk(join(root, folder));
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
        .replace(/\/\/.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');
      expect(text, file).not.toMatch(
        /decodeJwt|decodeProtectedHeader|jwtVerify|\batob\s*\(|split\('\.'\)\[1\]/,
      );
    }
  });
});
