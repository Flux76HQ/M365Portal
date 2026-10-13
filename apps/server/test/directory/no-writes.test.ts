// T-C-025, FR-C-402, SC-C2: the Phase C routes write nothing. The module has no access to the database
// (a source scan), the Graph client is only asked to read (the call record), and a mix of requests
// leaves every table of the database as it was, but the session's own `last seen` stamp, which the
// pipeline slides on any authenticated request and which no route decides.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it } from 'vitest';
import type { AppDatabase } from '../../src/db/index.js';
import { ALL_GROUPS, FULL_USERS, BASIC_USERS, createDirectoryFixture, getJson } from './support.js';

const SRC = fileURLToPath(new URL('../../src/directory', import.meta.url));

function files(): Record<string, string> {
  return Object.fromEntries(
    readdirSync(SRC, { recursive: true, encoding: 'utf8' })
      .filter((name) => name.endsWith('.ts'))
      .map((name) => [name.replaceAll('\\', '/'), readFileSync(join(SRC, name), 'utf8')]),
  );
}

/** The guard: nothing in the module reaches the database or writes to anything. */
const WRITES =
  /\.sqlite\b|\.prepare\(|\bINSERT\b|\bUPDATE\b|\bDELETE\b|requireDatabase|\bdatabase\s*\(|withTransaction|writeFile|appendFile|fs\.(?:write|append|unlink|rm)|\bwriteFileSync\b/;

function checkNoWrites(source: Readonly<Record<string, string>>): void {
  const bad = Object.entries(source)
    .filter(([, text]) => WRITES.test(text))
    .map(([name]) => name);
  if (bad.length > 0) throw new Error(`reaches storage: ${bad.join(', ')}`);
}

describe('the module has no way to write (FR-C-402)', () => {
  it('imports no database, no file system and no SQL', () => {
    const source = files();
    expect(Object.keys(source).length).toBeGreaterThan(10);
    expect(() => {
      checkNoWrites(source);
    }).not.toThrow();
    for (const [name, text] of Object.entries(source)) {
      expect(text, name).not.toMatch(/from '\.\.\/(db|audit)\//);
      expect(text, name).not.toMatch(/from 'node:fs/);
    }
  });

  it('negative: a service that prepares SQL, writes a file or asks for the database fails the guard', () => {
    expectGuardFails(
      checkNoWrites,
      { 'users-service.ts': "db.sqlite.prepare('INSERT INTO t VALUES (1)')" },
      { reason: 'reaches storage' },
    );
    expectGuardFails(
      checkNoWrites,
      { 'groups-service.ts': 'const db = deps.requireDatabase();' },
      { reason: 'reaches storage' },
    );
    expectGuardFails(
      checkNoWrites,
      { 'x.ts': "fs.writeFileSync('a', 'b')" },
      { reason: 'reaches storage' },
    );
    expect(() => {
      checkNoWrites({ 'x.ts': 'const rows = [];' });
    }).not.toThrow();
  });
});

/** Every table of the database as text, in a fixed order. */
function dump(db: AppDatabase, skip: ReadonlySet<string> = new Set()): Record<string, string> {
  const tables = (
    db.sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((row) => row.name);
  return Object.fromEntries(
    tables
      .filter((name) => !skip.has(name))
      .map((name) => [
        name,
        JSON.stringify(db.sqlite.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()),
      ]),
  );
}

describe('a mix of requests changes nothing in the database (FR-C-402, SC-C2)', () => {
  it('leaves every table as it was, and asks Graph only to read', async () => {
    const f = await createDirectoryFixture();
    const full = f.actor(FULL_USERS, ALL_GROUPS);
    const basic = f.actor(BASIC_USERS);
    const ids = f.seeded.ids;
    await f.settle();
    const before = dump(f.db);
    f.fake.calls.length = 0;

    const paths = [
      '/api/v1/users',
      '/api/v1/users?enabled=false&type=guest&order=desc',
      `/api/v1/users/${ids.userWithManager}`,
      `/api/v1/users/${ids.userWithManager}/groups`,
      '/api/v1/groups?kind=distribution',
      `/api/v1/groups/${ids.bigGroup}`,
      `/api/v1/groups/${ids.bigGroup}/owners`,
      `/api/v1/groups/${ids.bigGroup}/members?limit=100`,
      `/api/v1/groups/${ids.hiddenGroup}/members`,
      '/api/v1/users/not-a-guid',
      '/api/v1/users?cursor=AAAAAAAAAAAAAAAAAAAAAAAA',
    ];
    for (const path of paths) await getJson(full.client, path);
    for (const path of paths.slice(0, 3)) await getJson(basic.client, path);
    // Writes are not routes: they are refused before any handler.
    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      await full.client[method]('/api/v1/users', { json: {} });
      await full.client[method](`/api/v1/groups/${ids.bigGroup}/members`, { json: {} });
    }

    const readsOnly = new Set([
      'listUsers',
      'getUser',
      'getUserManager',
      'listUserGroups',
      'listGroups',
      'getGroup',
      'listGroupMembers',
      'listGroupOwners',
    ]);
    expect(f.fake.calls.length).toBeGreaterThan(10);
    for (const call of f.fake.calls) expect(readsOnly.has(call.method), call.method).toBe(true);

    // Only the pipeline's own bookkeeping may move: the sliding stamp of the sessions that asked.
    const after = dump(f.db);
    const changed = Object.keys(after).filter((table) => after[table] !== before[table]);
    expect(
      changed.every((table) => table.includes('session')),
      changed.join(', '),
    ).toBe(true);
    // The audit log gained nothing: no success is audited, and the refused writes were 405s.
    expect(after.audit_log).toBe(before.audit_log);
  });
});
