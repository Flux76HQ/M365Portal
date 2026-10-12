// T-B-139: the setup routes P10 to P18 over a real server (FR-B-201 to FR-B-207; contract section 5).
// The wizard's own logic has its tests; this file is about the HTTP surface: who may call what, the
// cookie, the answers and the audit entries.
import {
  SetupStateResponseSchema,
  SetupStatusResponseSchema,
  UnlockResponseSchema,
  EnvironmentResultSchema,
} from '@m365portal/shared/schemas/setup';
import { describe, expect, it } from 'vitest';
import { startWizardServer } from './support/server-scene.js';

describe('status (P10)', () => {
  it('is public, says the state and that a token is needed, and nothing else', async () => {
    const server = await startWizardServer();
    const response = await server.client().get('/api/v1/setup/status');
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(SetupStatusResponseSchema.parse(body)).toEqual({
      state: 'unconfigured',
      tokenRequired: true,
    });
    expect(Object.keys(body as object).sort()).toEqual(['state', 'tokenRequired']);
    expect(response.headers.get('cache-control')).toContain('no-store');
  });

  it('says tokenRequired false to a request that carries a live setup session', async () => {
    const server = await startWizardServer();
    const { client } = await server.unlock();
    const body = SetupStatusResponseSchema.parse(
      await (await client.get('/api/v1/setup/status')).json(),
    );
    expect(body).toEqual({ state: 'in_progress', tokenRequired: false });
  });
});

describe('unlock (P11)', () => {
  it('opens a session with the file token: 200 in_progress, a strict cookie, the state edge, one audit entry', async () => {
    const server = await startWizardServer();
    const response = await server
      .client()
      .post('/api/v1/setup/unlock', { json: { token: server.token() } });
    expect(response.status).toBe(200);
    expect(UnlockResponseSchema.parse(await response.json())).toEqual({ state: 'in_progress' });
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/m365portal_setup=[A-Za-z0-9_-]{43}/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(server.query('SELECT state FROM setup_state')).toEqual([{ state: 'in_progress' }]);
    const audit = server.auditRows().filter((row) => row.action === 'setup.unlock');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_kind: 'setup', outcome: 'success' });
    expect(JSON.stringify(audit)).not.toContain(server.token() ?? 'never');
  });

  it('refuses a wrong token with 401 setup_token_invalid, no cookie, and no audit entry for a single failure', async () => {
    const server = await startWizardServer();
    const response = await server
      .client()
      .post('/api/v1/setup/unlock', { json: { token: 'wrong' } });
    expect(response.status).toBe(401);
    expect(((await response.json()) as { code: string }).code).toBe('setup_token_invalid');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(server.query('SELECT state FROM setup_state')).toEqual([{ state: 'unconfigured' }]);
    expect(server.auditRows().filter((row) => row.action === 'setup.unlock')).toEqual([]);
  });

  it('takes the token from the body only: a query string or a header does nothing', async () => {
    const server = await startWizardServer();
    const token = server.token() ?? '';
    const client = server.client();
    expect(
      (await client.post(`/api/v1/setup/unlock?token=${token}`, { json: { token: 'wrong' } }))
        .status,
    ).toBe(401);
    expect(
      (
        await client.post('/api/v1/setup/unlock', {
          json: { token: 'wrong' },
          headers: { 'x-setup-token': token, authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(401);
  });

  it('locks after 5 failures: the 5th answers 401 and records one denied entry, then 429 with Retry-After, even for the right token', async () => {
    const server = await startWizardServer();
    const client = server.client();
    for (let n = 1; n <= 5; n += 1) {
      expect(
        (await client.post('/api/v1/setup/unlock', { json: { token: `wrong-${String(n)}` } }))
          .status,
      ).toBe(401);
    }
    const locks = server.auditRows().filter((row) => row.action === 'setup.unlock');
    expect(locks).toHaveLength(1);
    expect(locks[0]).toMatchObject({ outcome: 'denied', reason_code: 'setup_token_locked' });
    expect(JSON.parse(locks[0]?.detail ?? '{}')).toMatchObject({ lockScope: 'client' });
    const refused = await client.post('/api/v1/setup/unlock', { json: { token: server.token() } });
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(((await refused.json()) as { code: string }).code).toBe('setup_token_locked');
    expect(server.query('SELECT state FROM setup_state')).toEqual([{ state: 'unconfigured' }]);
    // 15 minutes later the lock is over.
    await server.advance(15 * 60_000 + 1_000);
    expect(
      (await client.post('/api/v1/setup/unlock', { json: { token: server.token() } })).status,
    ).toBe(200);
  });

  it('needs the Origin and the CSRF token (403) before it looks at the token', async () => {
    const server = await startWizardServer();
    const client = server.client();
    expect(
      (
        await client.post('/api/v1/setup/unlock', {
          json: { token: server.token() },
          origin: 'http://evil.example',
        })
      ).status,
    ).toBe(403);
    expect(
      (await client.post('/api/v1/setup/unlock', { json: { token: server.token() }, csrf: 'none' }))
        .status,
    ).toBe(403);
    expect(server.query('SELECT state FROM setup_state')).toEqual([{ state: 'unconfigured' }]);
  });

  it('is 409 setup_step_not_ready once the wizard is finished and waits for the first sign-in', async () => {
    const server = await startWizardServer();
    server.exec("UPDATE setup_state SET state = 'in_progress'");
    server.exec("UPDATE setup_state SET state = 'awaiting_first_signin'");
    const response = await server
      .client()
      .post('/api/v1/setup/unlock', { json: { token: server.token() } });
    expect(response.status).toBe(409);
  });
});

describe('what needs the setup session', () => {
  it.each([
    ['GET', '/api/v1/setup/state'],
    ['POST', '/api/v1/setup/environment'],
    ['GET', '/api/v1/setup/certificate.cer'],
    ['GET', '/api/v1/setup/groups?q=a'],
    ['DELETE', '/api/v1/setup/session'],
    ['GET', '/api/v1/connection'],
    ['GET', '/api/v1/connection/runs/current'],
  ] as const)('%s %s answers 401 without it', async (method, path) => {
    const server = await startWizardServer();
    const client = server.client();
    const response =
      method === 'GET'
        ? await client.get(path)
        : method === 'POST'
          ? await client.post(path, { json: {} })
          : await client.delete(path);
    expect(response.status).toBe(401);
  });
});

describe('state (P13) and the session (P12)', () => {
  it('shows the five steps, no secret, and the session deadlines', async () => {
    const server = await startWizardServer();
    const { client } = await server.unlock();
    const response = await client.get('/api/v1/setup/state');
    expect(response.status).toBe(200);
    const text = await response.text();
    const body = SetupStateResponseSchema.parse(JSON.parse(text));
    expect(body.steps.map((step) => step.step)).toEqual([
      'environment',
      'connect',
      'configure',
      'verify',
      'finish',
    ]);
    expect(body).toMatchObject({
      state: 'in_progress',
      mode: 'automatic',
      tenant: { tenantId: null },
      application: null,
      certificate: null,
      designatedOwner: null,
      publicBaseUrl: server.origin,
    });
    expect(text).not.toContain(server.token() ?? 'never');
  });

  it('DELETE session ends it at once, clears the cookie and the cookie no longer works', async () => {
    const server = await startWizardServer();
    const { client, headers } = await server.unlock();
    const ended = await client.delete('/api/v1/setup/session');
    expect(ended.status).toBe(204);
    expect(ended.headers.get('set-cookie') ?? '').toMatch(/m365portal_setup=;|Max-Age=0|Expires=/i);
    expect((await server.client(headers).get('/api/v1/setup/state')).status).toBe(401);
  });
});

describe('environment (P14)', () => {
  it('runs the six checks and audits the step', async () => {
    const server = await startWizardServer();
    const { client } = await server.unlock();
    const response = await client.post('/api/v1/setup/environment', { json: {} });
    expect(response.status).toBe(200);
    const result = EnvironmentResultSchema.parse(await response.json());
    expect(result.checks).toHaveLength(6);
    expect(
      server
        .auditRows()
        .some((row) => row.action === 'setup.step.run' && row.actor_kind === 'setup'),
    ).toBe(true);
  });

  it('rejects a body with members (strict)', async () => {
    const server = await startWizardServer();
    const { client } = await server.unlock();
    expect((await client.post('/api/v1/setup/environment', { json: { extra: 1 } })).status).toBe(
      422,
    );
  });
});

describe('the public certificate (P16)', () => {
  it('serves the DER with the attachment name and no store, and generates it on the first request', async () => {
    const server = await startWizardServer();
    const { client } = await server.unlock();
    expect(server.query('SELECT 1 FROM certificate')).toEqual([]);
    const response = await client.get('/api/v1/setup/certificate.cer');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/x-x509-ca-cert');
    expect(response.headers.get('content-disposition')).toMatch(
      /^attachment; filename="m365portal-[0-9a-f]{8}\.cer"$/,
    );
    expect(response.headers.get('cache-control')).toContain('no-store');
    const der = Buffer.from(await response.arrayBuffer());
    expect(der[0]).toBe(0x30);
    expect(server.query('SELECT state FROM certificate')).toEqual([{ state: 'pending' }]);
    // The same bytes the second time: one certificate.
    const again = Buffer.from(
      await (await client.get('/api/v1/setup/certificate.cer')).arrayBuffer(),
    );
    expect(again.equals(der)).toBe(true);
  });
});

describe('finish (P18) before verification', () => {
  it('is 409 setup_step_not_ready', async () => {
    const server = await startWizardServer();
    const { client } = await server.unlock();
    const response = await client.post('/api/v1/setup/finish', {
      json: { confirmOwnerOid: server.world.admin.id },
    });
    expect(response.status).toBe(409);
  });
});
