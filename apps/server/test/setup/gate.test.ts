// T-B-139 / T-B-126: the setup gate over a real server (FR-B-201, FR-B-206, FR-B-207, EB-33). A closed
// gate means the route does not exist: the answer is the same standard 404 as for an unknown path.
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { describe, expect, it } from 'vitest';
import { startWizardServer } from './support/server-scene.js';

const SETUP_ROUTES = [
  ['GET', '/api/v1/setup/status'],
  ['POST', '/api/v1/setup/unlock'],
  ['DELETE', '/api/v1/setup/session'],
  ['GET', '/api/v1/setup/state'],
  ['POST', '/api/v1/setup/environment'],
  ['PUT', '/api/v1/setup/manual'],
  ['GET', '/api/v1/setup/certificate.cer'],
  ['GET', '/api/v1/setup/groups?q=a'],
  ['POST', '/api/v1/setup/finish'],
] as const;

async function call(client: ReturnType<Awaited<ReturnType<typeof startWizardServer>>['client']>, method: string, path: string): Promise<Response> {
  switch (method) {
    case 'GET':
      return client.get(path);
    case 'DELETE':
      return client.delete(path);
    case 'PUT':
      return client.put(path, { json: {} });
    default:
      return client.post(path, { json: {} });
  }
}

describe('once the state is completed', () => {
  it.each(SETUP_ROUTES)('%s %s answers the standard 404, the same as an unknown path', async (method, path) => {
    const server = await startWizardServer();
    const { client } = await server.unlock();
    server.exec("UPDATE setup_state SET state = 'awaiting_first_signin'");
    server.exec("UPDATE setup_state SET state = 'completed', completed_at = '2026-10-12T00:00:00.000Z'");
    const unknown = await server.client().get('/api/v1/setup/nothing-here');
    const response = await call(client, method, path);
    expect(response.status).toBe(404);
    const body = (await response.json()) as { code: string; type: string };
    const reference = (await unknown.json()) as { code: string; type: string };
    expect({ code: body.code, type: body.type }).toEqual({ code: reference.code, type: reference.type });
  });

  it('the live setup session is gone with the state: its cookie opens nothing', async () => {
    const server = await startWizardServer();
    const { headers } = await server.unlock();
    server.exec("UPDATE setup_state SET state = 'awaiting_first_signin'");
    server.exec("UPDATE setup_state SET state = 'completed', completed_at = '2026-10-12T00:00:00.000Z'");
    expect((await server.client(headers).get('/api/v1/connection')).status).toBe(401);
  });
});

describe('over a plain-http base URL (FR-B-206)', () => {
  it('the setup routes do not exist for a Host that is not loopback', async () => {
    const server = await startWizardServer();
    // fetch does not let a caller choose the Host header; a raw request does.
    const status = await new Promise<number>((resolve, reject) => {
      const outgoing = request(
        { host: '127.0.0.1', port: new URL(server.socket).port, path: '/api/v1/setup/status', headers: { host: 'panel.example.test' } },
        (incoming) => {
          incoming.resume();
          resolve(incoming.statusCode ?? 0);
        },
      );
      outgoing.on('error', reject);
      outgoing.end();
    });
    expect(status).toBe(404);
  });

  it.each([
    ['a Forwarded header', { forwarded: 'for=203.0.113.9' }],
    ['X-Forwarded-For', { 'x-forwarded-for': '203.0.113.9' }],
    ['X-Real-IP', { 'x-real-ip': '203.0.113.9' }],
  ] as const)('the setup routes do not exist for %s', async (_name, headers) => {
    const server = await startWizardServer();
    const response = await server.client().get('/api/v1/setup/status', { headers });
    expect(response.status).toBe(404);
  });

  it('exist for a loopback request without those headers (+ negative control)', async () => {
    const server = await startWizardServer();
    expect((await server.client().get('/api/v1/setup/status')).status).toBe(200);
  });
});

describe('without storage (EB-33)', () => {
  it('the setup routes answer 503 storage_unavailable and no token file is created', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'm365portal-degraded-'));
    const blocker = join(dir, 'a-file');
    writeFileSync(blocker, 'not a directory');
    const server = await startWizardServer({ dataDir: join(blocker, 'data') });
    for (const path of ['/api/v1/setup/status']) {
      const response = await server.client().get(path);
      expect(response.status).toBe(503);
      expect(((await response.json()) as { code: string }).code).toBe('storage_unavailable');
    }
    const unlock = await server.client().post('/api/v1/setup/unlock', { json: { token: 'anything' } });
    expect(unlock.status).toBe(503);
    expect(existsSync(join(blocker, 'data', 'setup-token'))).toBe(false);
  });
});
