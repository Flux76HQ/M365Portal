import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

const versionFile = readFileSync(new URL('../../../VERSION', import.meta.url), 'utf8').trim();

describe('createApp', () => {
  const app = createApp();

  it('GET /healthz reports ok and the version from the VERSION file', async () => {
    const res = await app.request('/healthz');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body: unknown = await res.json();
    expect(body).toEqual({ status: 'ok', version: versionFile });
  });

  it('answers 404 for routes that do not exist, including other methods on /healthz', async () => {
    expect((await app.request('/nope')).status).toBe(404);
    expect((await app.request('/healthz', { method: 'POST' })).status).toBe(404);
  });
});
