// T-B-139: the connection routes P19 to P26 over a real server (SB-19, FR-B-420; contract section 6),
// and the whole wizard through them: environment, a run of the three steps against the fake tenant,
// finish. The sign-in that completes the setup is the callback's (T-B-141, test/setup/complete-on-signin).
import { ConnectionResponseSchema, LogPageSchema, ProofSchema, RunSnapshotSchema, RunStatusSchema } from '@m365portal/shared/schemas/connection';
import { FinishResponseSchema } from '@m365portal/shared/schemas/setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startWizardServer } from '../setup/support/server-scene.js';
import { useWizardTimers } from '../setup/support/tenant-scene.js';

beforeEach(() => {
  useWizardTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('reading', () => {
  it('P19 shows an unconnected install: no tenant, no application, no certificate, secrets say no certificate', async () => {
    const server = await startWizardServer();
    const { client } = await server.unlock();
    const response = await client.get('/api/v1/connection');
    expect(response.status).toBe(200);
    const body = ConnectionResponseSchema.parse(await response.json());
    expect(body).toMatchObject({
      state: 'in_progress',
      mode: 'automatic',
      tenant: null,
      application: null,
      certificate: null,
      pendingCertificate: null,
      secrets: { status: 'no_certificate' },
      proof: null,
      verifiedAt: null,
      runActive: false,
    });
  });

  it('P22 with no run is 200 with run: null (not 404), and the five steps', async () => {
    const server = await startWizardServer();
    const { client } = await server.unlock();
    const response = await client.get('/api/v1/connection/runs/current');
    expect(response.status).toBe(200);
    const snapshot = RunSnapshotSchema.parse(await response.json());
    expect(snapshot.run).toBeNull();
    expect(snapshot.steps).toHaveLength(5);
    expect(snapshot.deviceCode).toBeNull();
  });

  it('P20 pages the log and refuses a bad query with 422', async () => {
    const server = await startWizardServer();
    const { client } = await server.unlock();
    const page = LogPageSchema.parse(await (await client.get('/api/v1/connection/log?after=0&limit=5')).json());
    expect(page.lines.length).toBeLessThanOrEqual(5);
    expect((await client.get('/api/v1/connection/log?limit=0')).status).toBe(422);
    expect((await client.get('/api/v1/connection/log?limit=201')).status).toBe(422);
    expect((await client.get('/api/v1/connection/log?after=-1')).status).toBe(422);
  });

  it('P23 and P24 with no run are 409 setup_step_not_ready, P25 with nothing to adopt too', async () => {
    const server = await startWizardServer();
    const { client } = await server.unlock();
    for (const path of ['/api/v1/connection/runs/current/retry-now', '/api/v1/connection/runs/current/cancel']) {
      const response = await client.post(path, { json: {} });
      expect(response.status).toBe(409);
      expect(((await response.json()) as { code: string }).code).toBe('setup_step_not_ready');
    }
    const adopt = await client.post('/api/v1/connection/adopt', { json: { kind: 'application', objectId: '5b0d7a3e-8c1f-4f6e-9a52-0d3c2b1a4e77', confirm: true } });
    expect(adopt.status).toBe(409);
  });

  it('P26 before the connection exists is 409 setup_step_not_ready', async () => {
    const server = await startWizardServer();
    const { client } = await server.unlock();
    expect((await client.post('/api/v1/connection/verify', { json: {} })).status).toBe(409);
  });
});

describe('starting a run (P21)', () => {
  it.each([
    ['steps out of order', { steps: ['verify', 'connect'], mode: 'continue' }],
    ['a repeated step', { steps: ['connect', 'connect'], mode: 'continue' }],
    ['no step', { steps: [], mode: 'continue' }],
    ['repair with mode continue', { steps: 'repair', mode: 'continue' }],
    ['an exchange role that is a GUID', { steps: ['connect'], mode: 'continue', exchangeRole: '5b0d7a3e-8c1f-4f6e-9a52-0d3c2b1a4e77' }],
    ['a tenant hint that is an authority alias', { steps: ['connect'], mode: 'continue', tenantHint: 'common' }],
    ['an unknown member', { steps: ['connect'], mode: 'continue', extra: true }],
  ])('refuses %s with 422 validation_failed', async (_name, request) => {
    const server = await startWizardServer();
    const { client } = await server.unlock();
    const response = await client.post('/api/v1/connection/runs', { json: request });
    expect(response.status).toBe(422);
  });

  it('refuses configure before connect has succeeded with 409 setup_step_not_ready', async () => {
    const server = await startWizardServer();
    const { client } = await server.unlock();
    const response = await client.post('/api/v1/connection/runs', { json: { steps: ['configure'], mode: 'continue' } });
    expect(response.status).toBe(409);
  });
});

describe('the whole wizard over HTTP', () => {
  it('runs environment, connect, configure and verify, and finishes into awaiting_first_signin', async () => {
    const server = await startWizardServer();
    const { client } = await server.unlock();

    const environment = await client.post('/api/v1/setup/environment', { json: {} });
    expect(environment.status).toBe(200);

    const started = await client.post('/api/v1/connection/runs', { json: { steps: ['connect', 'configure', 'verify'], mode: 'continue' } });
    expect(started.status).toBe(202);
    expect(started.headers.get('location')).toBe('/api/v1/connection/runs/current');
    RunStatusSchema.parse(await started.json());
    // A second run while one is active is 409 setup_step_busy.
    const second = await client.post('/api/v1/connection/runs', { json: { steps: ['connect'], mode: 'continue' } });
    expect(second.status).toBe(409);
    expect(((await second.json()) as { code: string }).code).toBe('setup_step_busy');

    await server.drive();
    const snapshot = RunSnapshotSchema.parse(await (await client.get('/api/v1/connection/runs/current')).json());
    expect(snapshot.run?.status).toBe('succeeded');
    const connection = ConnectionResponseSchema.parse(await (await client.get('/api/v1/connection')).json());
    expect(connection).toMatchObject({ state: 'in_progress', tenant: { tenantId: server.world.tenantId }, secrets: { status: 'ok' }, runActive: false });
    expect(connection.certificate?.level).toBe('ok');
    expect(connection.proof?.items.length).toBeGreaterThan(0);

    // P26: the app-only checks again, without a run.
    const verified = ProofSchema.parse(await (await client.post('/api/v1/connection/verify', { json: {} })).json());
    expect(verified.items.find((item) => item.key === 'check_v1')?.status).toBe('ok');
    expect(verified.items.find((item) => item.key === 'check_v2')?.status).toBe('ok');

    // Finish names the person: someone else is refused, the designated Owner is accepted.
    const state = (await (await client.get('/api/v1/setup/state')).json()) as { designatedOwner: { oid: string } };
    const wrong = await client.post('/api/v1/setup/finish', { json: { confirmOwnerOid: '5b0d7a3e-8c1f-4f6e-9a52-0d3c2b1a4e77' } });
    expect(wrong.status).toBe(422);
    const finished = await client.post('/api/v1/setup/finish', { json: { confirmOwnerOid: state.designatedOwner.oid, language: 'nl' } });
    expect(finished.status).toBe(200);
    expect(FinishResponseSchema.parse(await finished.json())).toMatchObject({ state: 'awaiting_first_signin', designatedOwner: { oid: server.world.admin.id } });
    expect(server.query('SELECT state FROM setup_state')).toEqual([{ state: 'awaiting_first_signin' }]);
    // The setup token file stays until the first sign-in completes the setup.
    expect(server.token()).toBeDefined();
  });
});
