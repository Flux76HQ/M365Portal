// T-B-143: the audit entries of the setup engine (FR-B-601, plan 9.5). A change in the tenant is recorded
// in ONE transaction with its `setup_object` row, its step row, its log line and its audit entry: a fault
// between the change and the entry rolls all of them back, and the next run finishes without a duplicate.
// The details use the allow-list of the action and nothing else; the actors are the ones the plan names.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUDIT_ACTIONS } from '../../src/audit/actions.js';
import { tenantScene, useWizardTimers, type TenantScene } from './support/tenant-scene.js';

vi.setConfig({ testTimeout: 30_000 });

beforeEach(() => {
  useWizardTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const ALL = ['connect', 'configure', 'verify'] as const;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface Row {
  seq: number;
  actor_kind: string;
  actor_id: string;
  action: string;
  outcome: string;
  target_id: string | null;
  detail: string;
}
const entries = (scene: TenantScene, ...actions: string[]): Row[] =>
  scene
    .rows<Row>(
      'SELECT seq, actor_kind, actor_id, action, outcome, target_id, detail FROM audit_log ORDER BY seq',
    )
    .filter((row) => (actions.length === 0 ? true : actions.includes(row.action)));

describe('a fault between the change and its entry', () => {
  it('rolls back the object row, the step row, the log line and the entry together; the next run finishes with one application', async () => {
    const scene = await tenantScene();
    scene.db.sqlite.exec(
      "CREATE TRIGGER audit_fault BEFORE INSERT ON audit_log WHEN NEW.action = 'setup.object.change' BEGIN SELECT RAISE(ABORT, 'injected fault'); END",
    );
    await scene.run(ALL);
    expect(scene.engine.current()?.status).toBe('failed');
    // The application exists in the tenant (the call was made); the panel recorded nothing of it.
    expect(scene.world.graph.directory.applications.size).toBe(1);
    expect(scene.rows("SELECT 1 FROM setup_object WHERE kind = 'application'")).toEqual([]);
    expect(entries(scene, 'setup.object.change')).toEqual([]);
    expect(
      scene.rows("SELECT status FROM setup_step WHERE sub_action = 'application'"),
    ).not.toEqual([{ status: 'succeeded' }]);
    expect(
      scene.rows(
        "SELECT 1 FROM setup_log WHERE message_key = 'setup.log.created' AND params LIKE '%application%'",
      ),
    ).toEqual([]);

    scene.db.sqlite.exec('DROP TRIGGER audit_fault');
    await scene.run(ALL);
    expect(scene.engine.current()?.status).toMatch(/succeeded|warning/);
    expect(scene.world.graph.directory.applications.size).toBe(1);
    expect(scene.rows("SELECT 1 FROM setup_object WHERE kind = 'application'")).toHaveLength(1);
    expect(
      entries(scene, 'setup.object.change').filter(
        (row) =>
          (JSON.parse(row.detail) as { kind: string; op: string }).kind === 'application' &&
          (JSON.parse(row.detail) as { op: string }).op !== 'update',
      ),
    ).toHaveLength(1);
  });

  it('does the same for the step entry: the step row of a result is not written without it', async () => {
    const scene = await tenantScene();
    scene.db.sqlite.exec(
      "CREATE TRIGGER step_fault BEFORE INSERT ON audit_log WHEN NEW.action = 'setup.step.run' BEGIN SELECT RAISE(ABORT, 'injected fault'); END",
    );
    await scene.run(['connect']);
    expect(scene.engine.current()?.status).toBe('failed');
    expect(entries(scene, 'setup.step.run')).toEqual([]);
    expect(
      scene.rows(
        "SELECT sub_action, status FROM setup_step WHERE status NOT IN ('pending', 'running')",
      ),
    ).toEqual([]);
    expect(
      scene.rows(
        "SELECT 1 FROM setup_log WHERE message_key = 'setup.log.run_finished' AND params LIKE '%succeeded%'",
      ),
    ).toEqual([]);
  });
});

describe('the entries of a whole run', () => {
  it('use the allow-listed detail keys of their action, and the outcomes and actors the action names', async () => {
    const scene = await tenantScene();
    await scene.run(ALL);
    const seen = new Set<string>();
    for (const row of entries(scene)) {
      const definition = (
        AUDIT_ACTIONS as Record<
          string,
          {
            detailKeys: readonly string[];
            outcomes: readonly string[];
            actorKinds: readonly string[];
          }
        >
      )[row.action];
      if (definition === undefined) continue;
      seen.add(row.action);
      expect(
        Object.keys(JSON.parse(row.detail) as object).every((key) =>
          definition.detailKeys.includes(key),
        ),
        `${row.action} detail keys`,
      ).toBe(true);
      expect(definition.outcomes, `${row.action} outcome`).toContain(row.outcome);
      expect(definition.actorKinds, `${row.action} actor`).toContain(row.actor_kind);
    }
    expect([...seen]).toEqual(
      expect.arrayContaining([
        'setup.step.run',
        'setup.object.change',
        'setup.tenant.pin',
        'secrets.certificate.create',
      ]),
    );
  });

  it('are written as the setup actor, and an object id is a GUID only for an application and a service principal', async () => {
    const scene = await tenantScene();
    await scene.run(ALL);
    for (const row of entries(scene, 'setup.step.run', 'setup.object.change', 'setup.tenant.pin')) {
      expect(row.actor_kind).toBe('setup');
      expect(row.actor_id).toBe('setup');
    }
    for (const row of entries(scene, 'setup.object.change')) {
      const detail = JSON.parse(row.detail) as { kind: string; objectId?: string; op: string };
      if (detail.kind === 'application' || detail.kind === 'service_principal') {
        if (detail.op === 'create') expect(detail.objectId).toMatch(GUID);
      } else {
        expect(detail.objectId).toBeUndefined();
      }
    }
    const pin = JSON.parse(entries(scene, 'setup.tenant.pin')[0]?.detail ?? '{}') as {
      tid: string;
      mode: string;
    };
    expect(pin).toEqual({ tid: scene.world.tenantId, mode: 'automatic' });
  });

  it('hold no token, key, certificate body, device code or free text of Microsoft (audit, log and step rows alike)', async () => {
    const scene = await tenantScene();
    await scene.run(ALL);
    const text = JSON.stringify([
      entries(scene),
      scene.rows('SELECT message_key, params FROM setup_log'),
      scene.rows('SELECT detail, rollback_hint_key FROM setup_step'),
    ]);
    expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/); // a JWT
    expect(text).not.toMatch(/MII[A-Za-z0-9+/]{40,}/); // base64 DER
    expect(text).not.toMatch(/-----BEGIN/);
    expect(text).not.toMatch(
      /user_code|verification_uri|client_secret|access_token|refresh_token|client_assertion/i,
    );
    expect(text).not.toContain(scene.world.admin.userPrincipalName);
  });
});
