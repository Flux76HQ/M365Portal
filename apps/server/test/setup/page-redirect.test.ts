// T-B-126, SB-14, SB-26: what a page navigation gets while setup exists, over a real server. Pages go to
// the wizard until the setup is completed, except the sign-in and the no-access pages and a request that
// carries a user session; /setup itself is a 404 once the wizard is closed.
import { describe, expect, it } from 'vitest';
import { startWizardServer, type WizardServer } from './support/server-scene.js';

const HTML = { accept: 'text/html' };

async function navigate(server: WizardServer, path: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(new URL(path, server.socket), { headers: { ...HTML, ...headers }, redirect: 'manual' });
}

describe('while the wizard is open', () => {
  it.each(['/', '/users', '/settings/appearance'])('%s is a 303 to /setup', async (path) => {
    const server = await startWizardServer();
    const response = await navigate(server, path);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/setup');
  });

  it.each(['/setup', '/setup/finish'])('%s is the shell', async (path) => {
    const server = await startWizardServer();
    expect((await navigate(server, path)).status).toBe(200);
  });

  it.each(['/signin', '/signin/error', '/no-access'])('%s is never bounced to the token form', async (path) => {
    const server = await startWizardServer();
    expect((await navigate(server, path)).status).toBe(200);
  });

  it('a request over a proxy (the guard refuses) is not redirected, and /setup is a 404 there', async () => {
    const server = await startWizardServer();
    expect((await navigate(server, '/users', { 'x-forwarded-for': '203.0.113.9' })).status).toBe(200);
    expect((await navigate(server, '/setup', { 'x-forwarded-for': '203.0.113.9' })).status).toBe(404);
  });
});

describe('once the setup is completed', () => {
  it('/setup is a 404 with the shell and every other page is the shell', async () => {
    const server = await startWizardServer();
    server.exec("UPDATE setup_state SET state = 'in_progress'");
    server.exec("UPDATE setup_state SET state = 'awaiting_first_signin'");
    server.exec("UPDATE setup_state SET state = 'completed', completed_at = '2026-10-12T00:00:00.000Z'");
    const setup = await navigate(server, '/setup');
    expect(setup.status).toBe(404);
    expect(await setup.text()).toContain('<div id="root"');
    expect((await navigate(server, '/setup/finish')).status).toBe(404);
    expect((await navigate(server, '/users')).status).toBe(200);
  });
});
