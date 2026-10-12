// T-B-186: FR-B-418, SC-B-005. The sign-in path keeps no token: after 200 sign-ins no table, no log
// line and no byte of the process heap holds an ID token or the access token of a token response, and
// the access token was never read.
//
// How the heap is searched: the tokens the fake issued are cut to a fragment held ONLY as bytes
// (a Buffer is not part of a heap snapshot's string table), the strings are dropped, the garbage
// collector runs, and the snapshot file is searched for the fragments. A token the server still
// held in a string would be found.
import { rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import v8 from 'node:v8';
import { describe, expect, it } from 'vitest';
import { fake } from '../support/msw.js';
import { startSignInScene, type SignInScene } from './support/signin-scene.js';

const SIGN_INS = 200;
/** A fragment from the middle of the token: unique, and not a prefix every token shares. */
const FRAGMENT_CHARS = 48;

function fragmentOf(token: string): Buffer {
  const start = Math.max(0, token.length - FRAGMENT_CHARS - 5);
  return Buffer.from(token.slice(start, start + FRAGMENT_CHARS), 'latin1');
}

function databaseText(scene: SignInScene): string {
  const tables = scene.query<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  );
  return tables
    .map(({ name }) => JSON.stringify(scene.query(`SELECT * FROM "${name}"`)))
    .join('\n');
}

describe('after 200 sign-ins (FR-B-418)', () => {
  it('no table, log line or heap string holds an ID token or an access token', async () => {
    const scene = await startSignInScene({ env: { TRUST_PROXY: '1' } });

    // Watch the token responses on their way to the server: remember a fragment of each token as
    // bytes, and prove the response really carried both tokens.
    const fragments: Buffer[] = [];
    let responsesWithAccessToken = 0;
    const original = globalThis.fetch;
    globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const response = await original(input, init);
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/oauth2/v2.0/token') && response.status === 200) {
        const body = (await response.clone().json()) as Record<string, unknown>;
        if (typeof body.access_token === 'string' && typeof body.id_token === 'string') {
          responsesWithAccessToken += 1;
          fragments.push(fragmentOf(body.access_token), fragmentOf(body.id_token));
        }
      }
      return response;
    };

    try {
      for (let index = 0; index < SIGN_INS; index += 1) {
        const browser = scene.browser({
          forwardedFor: `198.51.${String(Math.floor(index / 250))}.${String((index % 250) + 1)}`,
        });
        const login = await browser.navigate('/auth/login', { stopBeforePanel: true });
        const callback = new URL(login.headers.get('location') ?? '');
        const result = await browser.request(callback, { from: 'microsoft' });
        expect(result.status).toBe(200);
      }
    } finally {
      globalThis.fetch = original;
    }
    // The code exchange carries the access token of the token response (U39 aside): the test saw
    // it, so a server that kept it would have had something to keep.
    expect(responsesWithAccessToken).toBe(SIGN_INS);
    expect(scene.sessionCount()).toBeLessThanOrEqual(10);

    // 1. The tables and the log, as bytes.
    const database = Buffer.from(databaseText(scene), 'latin1');
    const logs = Buffer.from(scene.logs.text(), 'latin1');
    for (const fragment of fragments) {
      expect(database.includes(fragment)).toBe(false);
      expect(logs.includes(fragment)).toBe(false);
    }

    // 2. The heap: drop the fake's own copies, collect, snapshot, search.
    // The fake keeps every token it issued in its ledger (the Graph and Exchange modules check them):
    // those copies are the test's, not the server's.
    fake.reset();
    scene.world.graph.world.reset();
    v8.setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    gc();
    const file = join(tmpdir(), `m365portal-heap-${String(process.pid)}.heapsnapshot`);
    try {
      v8.writeHeapSnapshot(file);
      const heap = readFileSync(file);
      // Self-check: the search can see a string that IS on the heap (a fragment-sized marker).
      // A flat string: a snapshot lists the content of a flat string, not of a concatenation.
      const markerHeld = Buffer.from(`heap-marker-${'m'.repeat(40)}`).toString('latin1');
      v8.writeHeapSnapshot(file);
      expect(readFileSync(file).includes(Buffer.from(markerHeld, 'latin1'))).toBe(true);
      const found = fragments.flatMap((fragment, index) =>
        heap.includes(fragment) ? [index % 2 === 0 ? 'access' : 'id'] : [],
      );
      expect(found).toEqual([]);
    } finally {
      rmSync(file, { force: true });
    }
  }, 180_000);
});
