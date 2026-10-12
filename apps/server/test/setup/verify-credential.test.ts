// T-B-136: the read-back before the first token (research R-08, FR-B-306, FR-B-309 V1). The certificate
// is uploaded, read back from the application, activated, and only then does the first token request
// with it leave.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fake } from '../support/msw.js';
import { tenantScene, useWizardTimers } from './support/tenant-scene.js';

beforeEach(() => {
  useWizardTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the order of the calls', () => {
  it('PATCH keyCredentials, then a read of the application, then the first token with the certificate', async () => {
    const scene = await tenantScene();
    await scene.run(['connect', 'configure', 'verify']);
    const calls = fake.calls.all();
    const patch = calls.findIndex(
      (call) =>
        call.method === 'PATCH' &&
        /\/v1\.0\/applications\/[^/]+$/.test(call.path) &&
        call.status === 204,
    );
    const keyPatch = calls.findIndex((call, index) => index >= patch && call.method === 'PATCH');
    expect(keyPatch).toBeGreaterThan(-1);
    // The tokens with the certificate are the client_credentials requests of the Entra fake.
    const credentials = scene.world.entra.control
      .tokenRequests()
      .filter((request) => request.grantType === 'client_credentials');
    expect(credentials.length).toBeGreaterThanOrEqual(4);
    const tokenCalls = calls
      .map((call, index) => ({ call, index }))
      .filter(({ call }) => call.method === 'POST' && call.path.endsWith('/oauth2/v2.0/token'));
    // The first token request after the credential PATCH comes after a read of the application.
    const firstToken = tokenCalls.find(({ index }) => index > keyPatch);
    const readBack = calls.findIndex(
      (call, index) =>
        index > keyPatch &&
        call.method === 'GET' &&
        /\/v1\.0\/applications\/[^/]+$/.test(call.path),
    );
    expect(readBack).toBeGreaterThan(keyPatch);
    expect(firstToken?.index).toBeGreaterThan(readBack);
    // No token with the certificate was asked for before the upload.
    const before = scene.world.entra.control.tokenRequests().slice(0, 1);
    expect(before.every((request) => request.grantType !== 'client_credentials')).toBe(true);
  });

  it('the certificate is active before V1 runs, not after', async () => {
    const scene = await tenantScene();
    await scene.run(['connect', 'configure']);
    expect(scene.rows('SELECT state FROM certificate')).toEqual([{ state: 'active' }]);
    expect(
      scene.world.entra.control
        .tokenRequests()
        .filter((request) => request.grantType === 'client_credentials'),
    ).toHaveLength(0);
  });
});
