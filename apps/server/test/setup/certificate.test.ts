// T-B-134: the sub-action `certificate`, the secret handling (FR-B-107 request half). A canary: the
// private key of the generated certificate appears in no outbound request body, no log line, no audit
// entry, no table (it is only in the sealed row, encrypted) and no snapshot.
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lazyCertificateFactory } from '../../src/secrets/certificate-factory.js';
import { tenantScene, useWizardTimers } from './support/tenant-scene.js';

beforeEach(() => {
  useWizardTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the private key', () => {
  it('is generated in memory, sealed in the database, and never leaves in a body, log, audit entry or snapshot', async () => {
    const keys: Buffer[] = [];
    const generate = lazyCertificateFactory.generate.bind(lazyCertificateFactory);
    vi.spyOn(lazyCertificateFactory, 'generate').mockImplementation(async (options) => {
      const generated = await generate(options);
      // The service wipes its copy after sealing: keep our own to search for.
      keys.push(Buffer.from(generated.pkcs8Der));
      return generated;
    });
    const bodies: string[] = [];
    const original = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (request.method !== 'GET') bodies.push(await request.clone().text());
      return original(input, init);
    });

    const scene = await tenantScene();
    await scene.run(['connect', 'configure']);
    expect(keys).toHaveLength(1);
    const key = keys[0] ?? Buffer.alloc(0);
    expect(key.length).toBeGreaterThan(1000);

    // Fragments of the key in every encoding that could carry it.
    const middle = key.subarray(200, 248);
    const needles = [
      middle.toString('base64'),
      middle.toString('hex'),
      middle.toString('base64url'),
      key.toString('base64').slice(0, 64),
    ];
    const tables = scene
      .rows<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .map(({ name }) => ({
        name,
        text: JSON.stringify(scene.rows(`SELECT * FROM "${name}"`), (_k, v: unknown) =>
          v !== null && typeof v === 'object' && (v as { type?: string }).type === 'Buffer'
            ? Buffer.from((v as { data: number[] }).data).toString('latin1')
            : v,
        ),
      }));
    const text = [
      ...bodies,
      scene.logs.text(),
      JSON.stringify(scene.engine.snapshot(0)),
      ...tables.map((table) => table.text),
    ].join('\n');
    for (const needle of needles) expect(text).not.toContain(needle);
    // The raw bytes are in no table either (the sealed blob is ciphertext).
    for (const table of tables) {
      expect(table.text.includes(key.subarray(200, 232).toString('latin1'))).toBe(false);
    }

    // The sealed row exists and is not the plaintext key.
    const sealed = scene.rows<{ purpose: string; blob: Buffer }>(
      "SELECT purpose, blob FROM secret WHERE purpose = 'certificate_key'",
    );
    expect(sealed).toHaveLength(1);
    expect(Buffer.from(sealed[0]?.blob ?? []).includes(middle)).toBe(false);
  });

  it('only the public certificate is in the request: its SHA-1 is the one Entra computed', async () => {
    const bodies: string[] = [];
    const original = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (request.method === 'PATCH') bodies.push(await request.clone().text());
      return original(input, init);
    });
    const scene = await tenantScene();
    await scene.run(['connect', 'configure']);
    const [row] = scene.rows<{ thumbprint_sha1: string; public_der: Buffer }>(
      'SELECT thumbprint_sha1, public_der FROM certificate',
    );
    const sent = JSON.parse(bodies.find((body) => body.includes('keyCredentials')) ?? '{}') as {
      keyCredentials: { key: string }[];
    };
    const der = Buffer.from(sent.keyCredentials[0]?.key ?? '', 'base64');
    expect(der.equals(Buffer.from(row?.public_der ?? []))).toBe(true);
    expect(createHash('sha1').update(der).digest('hex')).toBe(row?.thumbprint_sha1);
  });
});
