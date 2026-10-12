// T-B-133: the sub-actions `application` and `application_settings` (FR-B-303, FR-B-304, FR-B-318,
// EB-06, EB-07). The bodies the wizard sends are checked field by field against `buildDesiredState`,
// a second run writes nothing, and an application that is not ours waits for the operator.
import { redirectUris } from '@m365portal/shared/auth/redirect-uri';
import { buildDesiredState, INSTALL_TAG_PREFIX } from '@m365portal/shared/setup/desired-state';
import { GRAPH_APP_ROLES, GRAPH_RESOURCE_APP_ID } from '@m365portal/shared/setup/graph-roles';
import { expectGuardFails } from '@m365portal/shared/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedApplication } from '../fakes/fake-tenant/entra/index.js';
import { fake } from '../support/msw.js';
import { tenantScene, useWizardTimers, type TenantScene } from './support/tenant-scene.js';

beforeEach(() => {
  useWizardTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const REGISTERED = ((uris) => [uris.callback, uris.loggedOut])(redirectUris('http://localhost:9300'));

interface Sent {
  readonly method: string;
  readonly path: string;
  readonly body: Record<string, unknown>;
}

/** The JSON bodies of the writes to Graph, as they leave the product. */
function recordWrites(): Sent[] {
  const sent: Sent[] = [];
  const original = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (request.url.startsWith('https://graph.microsoft.com/') && request.method !== 'GET') {
      const text = await request.clone().text();
      sent.push({
        method: request.method,
        path: new URL(request.url).pathname,
        body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
      });
    }
    return original(input, init);
  });
  return sent;
}

function desiredFor(scene: TenantScene, name = 'M365Portal') {
  const graph = scene.world.graph.directory.servicePrincipalByAppId(GRAPH_RESOURCE_APP_ID);
  const exchange = scene.world.graph.directory.servicePrincipalByAppId('00000002-0000-0ff1-ce00-000000000000');
  const roleIds: Record<string, string> = {};
  for (const role of graph?.appRoles ?? []) roleIds[role.value] = role.id;
  for (const role of exchange?.appRoles ?? []) roleIds[role.value] = role.id;
  return buildDesiredState({
    baseUrl: 'http://localhost:9300',
    installId: scene.services.state.read(scene.db).installId,
    applicationName: name,
    roleIds: Object.fromEntries(
      Object.entries(roleIds).filter(([role]) => (GRAPH_APP_ROLES as readonly string[]).includes(role) || role.startsWith('Exchange.')),
    ),
    exchange: true,
  });
}

/** Throws unless a POST /applications body is exactly the desired state, member by member. */
function assertBodyIsDesired(body: Record<string, unknown>, desired: ReturnType<typeof desiredFor>): void {
  const web = body.web as { redirectUris?: string[]; implicitGrantSettings?: Record<string, boolean> } | undefined;
  const expect_ = (condition: boolean, what: string): void => {
    if (!condition) throw new Error(`the body differs from the desired state: ${what}`);
  };
  expect_(body.displayName === desired.displayName, 'displayName');
  expect_(body.signInAudience === 'AzureADMyOrg', 'signInAudience');
  expect_(JSON.stringify(body.tags) === JSON.stringify(desired.tags), 'tags');
  expect_(JSON.stringify(web?.redirectUris) === JSON.stringify(desired.web.redirectUris), 'redirectUris');
  expect_(
    web?.implicitGrantSettings?.enableIdTokenIssuance === false && web.implicitGrantSettings.enableAccessTokenIssuance === false,
    'implicit flows',
  );
  expect_(!(web?.redirectUris ?? []).some((uri) => uri.includes('*')), 'wildcard');
  expect_(
    JSON.stringify(body.requiredResourceAccess) === JSON.stringify(desired.requiredResourceAccess),
    'requiredResourceAccess',
  );
  expect_(
    JSON.stringify((body.optionalClaims as { idToken: unknown }).idToken) === JSON.stringify(desired.optionalClaims.idToken),
    'optionalClaims',
  );
  for (const forbidden of ['passwordCredentials', 'keyCredentials', 'identifierUris', 'groupMembershipClaims', 'isFallbackPublicClient', 'api']) {
    expect_(!(forbidden in body), `no ${forbidden}`);
  }
  expect_(!('logoutUrl' in (web ?? {})), 'no web.logoutUrl');
}

describe('a clean creation', () => {
  it('POSTs exactly the desired state and records the application', async () => {
    const scene = await tenantScene();
    const sent = recordWrites();
    await scene.run(['connect', 'configure']);
    const post = sent.find((entry) => entry.method === 'POST' && entry.path === '/v1.0/applications');
    expect(post).toBeDefined();
    assertBodyIsDesired(post?.body ?? {}, desiredFor(scene));
    const [application] = [...scene.world.graph.directory.applications.values()];
    expect(application).toMatchObject({ displayName: 'M365Portal', signInAudience: 'AzureADMyOrg', owners: [scene.world.admin.id] });
    expect(application?.passwordCredentials).toEqual([]);
    expect(application?.tags).toEqual(['m365portal', `${INSTALL_TAG_PREFIX}${scene.services.state.read(scene.db).installId}`]);

    expect(scene.rows("SELECT kind, tenant_object_id, app_id, name, origin FROM setup_object WHERE kind IN ('application', 'service_principal')")).toEqual([
      { kind: 'application', tenant_object_id: application?.id, app_id: application?.appId, name: 'M365Portal', origin: 'created' },
      { kind: 'service_principal', tenant_object_id: expect.any(String) as string, app_id: application?.appId, name: 'M365Portal', origin: 'created' },
    ]);
    const connection = scene.services.connections.read(scene.db);
    expect(connection).toMatchObject({ appObjectId: application?.id, appId: application?.appId, permissionSetVersion: 1 });
    expect(connection?.redirectUris).toEqual(REGISTERED);
    // The rollback hint carries the object ids.
    const sub = scene.engine.snapshot(0).steps.find((s) => s.step === 'configure')?.subActions.find((s) => s.key === 'application');
    expect(sub).toMatchObject({
      status: 'succeeded',
      hint: { key: 'setup.hint.application', params: { name: 'M365Portal', objectId: application?.id, appId: application?.appId } },
    });
  });

  it('audits the creation in the same transaction, with the GUID ids and no body', async () => {
    const scene = await tenantScene();
    await scene.run(['connect', 'configure']);
    const entries = scene.rows<{ detail: string; actor_kind: string }>("SELECT detail, actor_kind FROM audit_log WHERE action = 'setup.object.change' ORDER BY seq");
    const application = JSON.parse(entries[0]?.detail ?? '{}') as Record<string, unknown>;
    expect(application).toMatchObject({ kind: 'application', op: 'create', name: 'M365Portal' });
    expect(application.objectId).toMatch(/^[0-9a-f-]{36}$/);
    expect(entries[0]?.actor_kind).toBe('setup');
    expect(JSON.stringify(entries)).not.toMatch(/redirectUris|requiredResourceAccess/);
  });

  it('the body checker rejects a wildcard URI, a client secret, an implicit flow and a personal-account audience (negative)', async () => {
    const scene = await tenantScene();
    const sent = recordWrites();
    await scene.run(['connect', 'configure']);
    const good = sent.find((entry) => entry.path === '/v1.0/applications' && entry.method === 'POST')?.body ?? {};
    const desired = desiredFor(scene);
    const check = (mutate: (body: Record<string, unknown>) => void): void => {
      const body = structuredClone(good);
      mutate(body);
      assertBodyIsDesired(body, desired);
    };
    expect(() => {
      check(() => undefined);
    }).not.toThrow();
    expectGuardFails(check, (body) => { (body.web as { redirectUris: string[] }).redirectUris = ['https://*.example/auth/callback']; }, { reason: 'redirectUris' });
    expectGuardFails(check, (body) => { body.passwordCredentials = [{ displayName: 'x' }]; }, { reason: 'passwordCredentials' });
    expectGuardFails(check, (body) => { (body.web as { implicitGrantSettings: { enableIdTokenIssuance: boolean } }).implicitGrantSettings.enableIdTokenIssuance = true; }, { reason: 'implicit flows' });
    expectGuardFails(check, (body) => { body.signInAudience = 'AzureADandPersonalMicrosoftAccount'; }, { reason: 'signInAudience' });
  });

  it('the application name is the one of the request (3 to 64 characters)', async () => {
    const scene = await tenantScene();
    await scene.run(['connect', 'configure'], { applicationName: 'Contoso Beheer' });
    expect([...scene.world.graph.directory.applications.values()][0]?.displayName).toBe('Contoso Beheer');
  });
});

describe('a second run (idempotence)', () => {
  it('reconcile makes no write and creates no object twice', async () => {
    const scene = await tenantScene();
    await scene.run(['connect', 'configure']);
    const applications = scene.world.graph.directory.applications.size;
    fake.calls.clear();
    await scene.run(['connect', 'configure'], { mode: 'reconcile' });
    const writes = fake.calls.mutating().filter((call) => call.host === 'graph.microsoft.com');
    expect(writes).toEqual([]);
    expect(scene.world.graph.directory.applications.size).toBe(applications);
    expect(scene.rows('SELECT count(*) AS n FROM setup_object WHERE kind = ?', 'application')).toEqual([{ n: 1 }]);
  });
});

describe('application_settings patches only what drifted', () => {
  async function created() {
    const scene = await tenantScene();
    await scene.run(['connect', 'configure']);
    const application = [...scene.world.graph.directory.applications.values()][0];
    if (application === undefined) throw new Error('no application');
    return { scene, application };
  }

  it('a clean application costs no write', async () => {
    const { scene } = await created();
    const sent = recordWrites();
    await scene.run(['connect', 'configure'], { mode: 'reconcile' });
    expect(sent.filter((entry) => entry.method === 'PATCH')).toEqual([]);
  });

  it('redirect URIs after a PUBLIC_BASE_URL change: only web is sent', async () => {
    const { scene, application } = await created();
    application.web.redirectUris = ['http://localhost:1111/auth/callback'];
    const sent = recordWrites();
    await scene.run(['connect', 'configure'], { mode: 'reconcile' });
    const patches = sent.filter((entry) => entry.method === 'PATCH' && entry.path === `/v1.0/applications/${application.id}`);
    expect(patches).toHaveLength(1);
    expect(Object.keys(patches[0]?.body ?? {})).toEqual(['web']);
    expect(application.web.redirectUris).toEqual(REGISTERED);
  });

  it('a missing optional claim and a missing tag are repaired and nothing else is sent', async () => {
    const { scene, application } = await created();
    application.optionalClaims = { idToken: [{ name: 'amr', essential: false }] };
    application.tags = ['m365portal'];
    const sent = recordWrites();
    await scene.run(['connect', 'configure'], { mode: 'reconcile' });
    const patch = sent.find((entry) => entry.method === 'PATCH' && entry.path === `/v1.0/applications/${application.id}`);
    expect(Object.keys(patch?.body ?? {}).sort()).toEqual(['optionalClaims', 'tags']);
    expect(application.tags).toContain(`${INSTALL_TAG_PREFIX}${scene.services.state.read(scene.db).installId}`);
  });

  it('an extra requested permission is removed from the registration by the patch', async () => {
    const { scene, application } = await created();
    application.requiredResourceAccess[0]?.resourceAccess.push({ id: '5b567255-7703-4780-807c-7be8301ae99b', type: 'Role' });
    const sent = recordWrites();
    await scene.run(['connect', 'configure'], { mode: 'reconcile' });
    const patch = sent.find((entry) => entry.method === 'PATCH');
    expect(Object.keys(patch?.body ?? {})).toEqual(['requiredResourceAccess']);
    expect(application.requiredResourceAccess[0]?.resourceAccess).toHaveLength(4);
  });

  it('the audit of a repair after completion is connection.repair with the drift', async () => {
    const { scene, application } = await created();
    scene.db.sqlite.prepare("UPDATE setup_state SET state = 'awaiting_first_signin'").run();
    scene.db.sqlite.prepare("UPDATE setup_state SET state = 'completed', completed_at = '2026-10-10T12:00:00.000Z'").run();
    application.web.redirectUris = ['http://localhost:1111/auth/callback'];
    scene.db.sqlite.prepare("INSERT INTO tenant_connection (id, tenant_id, updated_at) VALUES (1, ?, '2026-10-10T12:00:00.000Z') ON CONFLICT(id) DO UPDATE SET tenant_id = excluded.tenant_id").run(scene.world.tenantId);
    scene.startRun(['connect', 'configure'], { kind: 'repair', mode: 'reconcile' });
    await scene.drive({ maxSeconds: 60 });
    await scene.engine.idle();
    const repairs = scene.rows<{ detail: string }>("SELECT detail FROM audit_log WHERE action = 'connection.repair'");
    const drift = repairs.map((row) => JSON.parse(row.detail) as { subAction: string; drift?: string[] }).find((entry) => entry.subAction === 'application_settings');
    expect(drift?.drift).toEqual(['redirect_uris']);
  });
});

describe('an application that is not ours (EB-06)', () => {
  function foreign(scene: TenantScene) {
    return seedApplication(scene.world.graph.world, { redirectUris: ['https://elsewhere.example/cb'], displayName: 'M365Portal', certificate: false });
  }

  it('the run waits with application_adoption_required and the prompt; nothing is written until the operator confirms', async () => {
    const scene = await tenantScene();
    const app = foreign(scene);
    const sent = recordWrites();
    scene.startRun(['connect', 'configure']);
    await scene.drive({ until: () => scene.engine.adoption() !== null, maxSeconds: 60 });
    expect(scene.engine.adoption()).toMatchObject({
      kind: 'application',
      requiresAcknowledgement: false,
      candidate: { objectId: app.objectId, appId: app.appId, displayName: 'M365Portal' },
    });
    expect(scene.rows("SELECT status, error_code FROM setup_step WHERE sub_action = 'application'")).toEqual([
      { status: 'waiting', error_code: 'application_adoption_required' },
    ]);
    expect(scene.engine.current()?.status).toBe('waiting');
    expect(sent.filter((entry) => entry.path === '/v1.0/applications')).toEqual([]);
    expect(scene.world.graph.directory.applications.size).toBe(1);
    expect(scene.engine.snapshot(0).adoption?.candidate.objectId).toBe(app.objectId);

    // The wrong object, and then the right one.
    expect(() => scene.engine.adopt({ objectId: '11111111-1111-4111-8111-111111111111', acknowledgeForeign: false })).toThrow(/validation_failed/);
    scene.engine.adopt({ objectId: app.objectId, acknowledgeForeign: false });
    await scene.drive({ maxSeconds: 60 });
    await scene.engine.idle();
    expect(scene.world.graph.directory.applications.size).toBe(1);
    expect(scene.rows('SELECT kind, tenant_object_id, origin FROM setup_object WHERE kind = ?', 'application')).toEqual([
      { kind: 'application', tenant_object_id: app.objectId, origin: 'adopted' },
    ]);
    const audit = scene.rows<{ detail: string }>("SELECT detail FROM audit_log WHERE action = 'setup.object.change' ORDER BY seq");
    expect(JSON.parse(audit[0]?.detail ?? '{}')).toMatchObject({ kind: 'application', op: 'adopt', confirmed: true, objectId: app.objectId, appId: app.appId, name: 'M365Portal' });
    // Never a silent duplicate, and the implicit flows of the adopted application went off.
    const record = scene.world.graph.directory.applications.get(app.objectId);
    expect(record?.web.implicitGrantSettings).toEqual({ enableIdTokenIssuance: false, enableAccessTokenIssuance: false });
    expect(record?.web.redirectUris).toEqual(REGISTERED);
    expect(record?.tags).toContain(`${INSTALL_TAG_PREFIX}${scene.services.state.read(scene.db).installId}`);
  });

  it('foreign key credentials make the prompt require acknowledgeForeign: true', async () => {
    const scene = await tenantScene();
    const app = foreign(scene);
    const other = scene.world.graph.directory.addUser({ userPrincipalName: 'someone@contoso-fake.example' });
    const record = scene.world.graph.directory.applications.get(app.objectId);
    if (record !== undefined) record.owners = [other.id];
    scene.startRun(['connect', 'configure']);
    await scene.drive({ until: () => scene.engine.adoption() !== null, maxSeconds: 60 });
    expect(scene.engine.adoption()).toMatchObject({ requiresAcknowledgement: true, candidate: { foreign: { owners: 1 } } });
    expect(() => scene.engine.adopt({ objectId: app.objectId, acknowledgeForeign: false })).toThrow(/validation_failed/);
    scene.engine.adopt({ objectId: app.objectId, acknowledgeForeign: true });
    await scene.drive({ maxSeconds: 60 });
    await scene.engine.idle();
    expect(scene.rows('SELECT origin FROM setup_object WHERE kind = ?', 'application')).toEqual([{ origin: 'adopted' }]);
  });

  it('cancelling the wait leaves the candidate alone and the run cancelled', async () => {
    const scene = await tenantScene();
    const app = foreign(scene);
    scene.startRun(['connect', 'configure']);
    await scene.drive({ until: () => scene.engine.adoption() !== null, maxSeconds: 60 });
    scene.engine.cancel();
    await scene.engine.idle();
    expect(scene.engine.current()?.status).toBe('cancelled');
    expect(scene.rows('SELECT count(*) AS n FROM setup_object')).toEqual([{ n: 0 }]);
    expect(scene.world.graph.directory.applications.get(app.objectId)?.web.redirectUris).toEqual(['https://elsewhere.example/cb']);
  });

  it('a password credential ends the step application_untrusted', async () => {
    const scene = await tenantScene();
    const app = foreign(scene);
    scene.world.graph.directory.applications.get(app.objectId)?.passwordCredentials.push({ keyId: '22222222-2222-4222-8222-222222222222', displayName: 'x', hint: 'abc', startDateTime: null, endDateTime: null });
    await scene.run(['connect', 'configure']);
    expect(scene.rows("SELECT status, error_code FROM setup_step WHERE sub_action = 'application'")).toEqual([
      { status: 'failed', error_code: 'application_untrusted' },
    ]);
  });
});

describe('a run that died between the call and its transaction', () => {
  it('finds the object by its install tag and records op adopt, creating nothing twice', async () => {
    const scene = await tenantScene();
    // The first run created the application, then the process died before the transaction.
    const app = seedApplication(scene.world.graph.world, { redirectUris: [], displayName: 'M365Portal', certificate: false, servicePrincipal: false });
    const record = scene.world.graph.directory.applications.get(app.objectId);
    if (record !== undefined) record.tags = ['m365portal', `${INSTALL_TAG_PREFIX}${scene.services.state.read(scene.db).installId}`];
    const sent = recordWrites();
    await scene.run(['connect', 'configure']);
    expect(sent.filter((entry) => entry.method === 'POST' && entry.path === '/v1.0/applications')).toEqual([]);
    expect(scene.world.graph.directory.applications.size).toBe(1);
    const audit = scene.rows<{ detail: string }>("SELECT detail FROM audit_log WHERE action = 'setup.object.change' ORDER BY seq");
    expect(JSON.parse(audit[0]?.detail ?? '{}')).toMatchObject({ kind: 'application', op: 'adopt' });
    expect(scene.rows('SELECT origin FROM setup_object WHERE kind = ?', 'application')).toEqual([{ origin: 'created' }]);
  });
});
