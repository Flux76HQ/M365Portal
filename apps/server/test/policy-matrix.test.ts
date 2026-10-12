// T-B-246: the policy matrix (FR-B-505, FR-B-502, FR-B-523 column, SC-B-006, US-B6).
//
// 15 permissions x {anonymous, a user per built-in role, a user with a scoped assignment (in and out
// of scope), a user with an expired assignment, a user whose role comes through a group, the setup
// actor, break-glass} x the resource cases of each permission, answered by the REAL chain: rows in the
// session and assignment tables, the grants service, the actor resolver, `authorize`.
//
// The expectation is not a restatement of `BUILTIN_ROLES`. It is parsed here, from the markdown table of
// the built-in role matrix, by a parser that shares no code with the application:
//   - `docs/permissions.md`, once it carries the role matrix (T-B-421 writes it there), else
//   - table 6.9.4 of `specs/002-phase-b/spec.md`, which the document repeats and which is normative.
// The two fixed actors (setup, break-glass) are written out below from FR-B-202 and FR-B-521, not read from
// `policy/fixed-grants.ts`.
//
// Then the same facts through HTTP, over the real route table: a Reader gets 403 and an audit entry on every
// write route called with a valid Origin and CSRF token (US-B6 item 1), and a break-glass session is
// refused by every write route except the ones that name `rbac:manage` and accept its kind.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PERMISSIONS, PERMISSION_RESOURCE, type Permission } from '@m365portal/shared/permissions';
import type { ResourceAttrs } from '@m365portal/shared/rbac/resources';
import type { ScopeItem } from '@m365portal/shared/rbac/scope';
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it, onTestFinished } from 'vitest';
import { clearAuditHeadLog, setAuditHeadLog } from '../src/audit/index.js';
import { buildApp, type BuiltApp } from '../src/app.js';
import { loadConfigOrThrow } from '../src/config/index.js';
import { DATABASE_FILE_NAME, openDatabase, type AppDatabase } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate.js';
import { createReadiness } from '../src/lifecycle/readiness.js';
import { createStorageProbe } from '../src/lifecycle/storage-probe.js';
import { createSweeperRegistry } from '../src/lifecycle/sweepers.js';
import { createLogger } from '../src/logging/logger.js';
import { requireDatabaseOf, type ModuleDeps } from '../src/module.js';
import { appModules } from '../src/modules.js';
import { authorize, type Actor } from '../src/policy/index.js';
import { defaultPaths } from '../scripts/schema-snapshot.js';
import { createFakeClock } from './helpers/fake-clock.js';
import { requestBodyFor } from './helpers/http-app.js';
import { createHttpClient, readJson, type HttpClient } from './helpers/http-client.js';
import { createLogCapture } from './helpers/log-capture.js';
import { moduleDepsExtras } from './helpers/module-deps-extras.js';
import { createPolicyHarness, type PolicyHarness } from './helpers/policy-harness.js';
import { createTempDataDir } from './helpers/temp-data-dir.js';
import { signedInAs } from './helpers/test-app.js';

// ---------------------------------------------------------------------------------------------
// The independent source: a markdown table, parsed by hand
// ---------------------------------------------------------------------------------------------

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const DOC = join(ROOT, 'docs', 'permissions.md');
const SPEC = join(ROOT, 'specs', '002-phase-b', 'spec.md');

type Cell = 'full' | 'basic' | null;

interface MatrixRow {
  readonly permission: string;
  readonly resource: string;
  readonly cells: Readonly<Record<string, Cell>>;
}

interface Matrix {
  readonly roles: readonly string[];
  readonly rows: readonly MatrixRow[];
  readonly source: string;
}

const ROLE_HEADER = /\(`([a-z_]+)`\)/;

function cellsOf(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

/** The first table whose header names the built-in roles as "(`key`)", from `markdown`. */
function parseRoleMatrix(markdown: string, source: string): Matrix | undefined {
  const lines = markdown.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (!line.startsWith('|') || !line.includes('(`owner`)')) continue;
    const header = cellsOf(line);
    const roleColumns = header
      .map((cell, column) => ({ key: ROLE_HEADER.exec(cell)?.[1], column }))
      .filter((entry): entry is { key: string; column: number } => entry.key !== undefined);
    const rows: MatrixRow[] = [];
    for (let next = index + 2; next < lines.length; next += 1) {
      const body = lines[next] ?? '';
      if (!body.startsWith('|')) break;
      const cells = cellsOf(body);
      const permission = /^`([^`]+)`$/.exec(cells[0] ?? '')?.[1];
      if (permission === undefined) continue;
      const entries = roleColumns.map(({ key, column }): [string, Cell] => {
        const text = cells[column] ?? '';
        return [key, text === 'x' ? 'full' : text === 'basic' ? 'basic' : null];
      });
      rows.push({
        permission,
        resource: (cells[1] ?? '').replaceAll('`', ''),
        cells: Object.fromEntries(entries),
      });
    }
    return { roles: roleColumns.map((entry) => entry.key), rows, source };
  }
  return undefined;
}

function loadMatrix(): Matrix {
  for (const [path, label] of [
    [DOC, 'docs/permissions.md'],
    [SPEC, 'specs/002-phase-b/spec.md 6.9.4'],
  ] as const) {
    if (!existsSync(path)) continue;
    const parsed = parseRoleMatrix(readFileSync(path, 'utf8'), label);
    if (parsed !== undefined) return parsed;
  }
  throw new Error('no document carries the built-in role matrix');
}

const MATRIX = loadMatrix();
const ROLES = MATRIX.roles;
const holds = (role: string, permission: string): Cell =>
  MATRIX.rows.find((row) => row.permission === permission)?.cells[role] ?? null;

/** FR-B-202 and FR-B-521, written out: the permissions of the two fixed actors. */
const SETUP_HOLDS: readonly string[] = ['settings:branding', 'settings:connection'];
const BREAK_GLASS_HOLDS: readonly string[] = ['rbac:manage'];
/** FR-B-515: a role that comes through an Entra group never gives these. */
const GROUP_NEVER: readonly string[] = ['rbac:manage', 'settings:connection'];

// ---------------------------------------------------------------------------------------------
// The table itself
// ---------------------------------------------------------------------------------------------

describe(`the independent matrix, parsed from ${MATRIX.source} (FR-B-502)`, () => {
  it('has the five built-in roles in the order of the spec and the 15 permissions of the catalogue', () => {
    expect(ROLES).toEqual(['owner', 'admin', 'operator', 'helpdesk', 'reader']);
    expect(MATRIX.rows.map((row) => row.permission)).toEqual([...PERMISSIONS]);
  });

  it('counts 15, 13, 9, 6 and 4 permissions (the totals of the spec)', () => {
    const totals = ROLES.map(
      (role) => MATRIX.rows.filter((row) => row.cells[role] !== null).length,
    );
    expect(totals).toEqual([15, 13, 9, 6, 4]);
  });

  it('names the resource type of every permission as the catalogue does (or none for the global-only five)', () => {
    for (const row of MATRIX.rows) {
      const type = PERMISSION_RESOURCE[row.permission as Permission];
      expect(row.resource, row.permission).toBe(type ?? 'none (global-only)');
    }
  });

  it('negative: a changed cell, and a missing table, are found by the comparison', () => {
    const own = existsSync(DOC) && readFileSync(DOC, 'utf8').includes('(`owner`)') ? DOC : SPEC;
    const text = readFileSync(own, 'utf8');
    expect(parseRoleMatrix('no table here', 'x')).toBeUndefined();
    // Give the Beheerder `rbac:manage`: one cell of 75.
    const changed = text
      .split('\n')
      .map((line) => {
        if (!line.startsWith('| `rbac:manage`')) return line;
        const cells = line.split('|');
        cells[4] = ' x ';
        return cells.join('|');
      })
      .join('\n');
    const same = (candidate: Matrix | undefined): void => {
      if (candidate === undefined) throw new Error('no table');
      for (const row of MATRIX.rows) {
        const other = candidate.rows.find((entry) => entry.permission === row.permission);
        if (JSON.stringify(other?.cells) !== JSON.stringify(row.cells))
          throw new Error(`${row.permission} differs`);
      }
    };
    same(parseRoleMatrix(text, 'again'));
    expectGuardFails(same, parseRoleMatrix(changed, 'changed'));
    expectGuardFails(same, undefined);
  });
});

// ---------------------------------------------------------------------------------------------
// The chain, asked directly
// ---------------------------------------------------------------------------------------------

const SALES: ScopeItem = {
  target: 'group',
  match: { by: 'prefix', attr: 'displayName', value: 'sales' },
};
const GUID = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

/** A resource of the type the permission is about; `in`/`out` only differ for a group (the scope names groups). */
function resourcesOf(
  permission: Permission,
): { in: ResourceAttrs; out: ResourceAttrs } | undefined {
  const type = PERMISSION_RESOURCE[permission];
  if (type === null) return undefined;
  if (type === 'group') {
    return {
      in: { type, id: GUID(1), displayName: 'Sales Benelux' },
      out: { type, id: GUID(2), displayName: 'HR' },
    };
  }
  return {
    in: { type, id: GUID(3), displayName: 'Anything' },
    out: { type, id: GUID(4), displayName: 'Anything else' },
  };
}

interface Column {
  readonly name: string;
  /** What the matrix says the actor holds for `permission` without a resource. */
  readonly expected: (permission: Permission) => Cell;
  readonly actor: (harness: PolicyHarness) => Actor;
}

const asActor = (harness: PolicyHarness, ...sessions: Parameters<PolicyHarness['request']>) =>
  harness.resolve(harness.request(...sessions));

const COLUMNS: readonly Column[] = [
  {
    name: 'anonymous',
    expected: () => null,
    actor: (harness) => asActor(harness),
  },
  ...ROLES.map((role): Column => ({
    name: `user, role ${role}`,
    expected: (permission) => holds(role, permission),
    actor: (harness) => asActor(harness, harness.seedSession({ roles: [role] })),
  })),
  {
    name: 'user, role operator scoped to the groups of Sales',
    // The scope names groups, so it narrows the group permissions only (BCB-09); the rest stay unscoped.
    expected: (permission) => holds('operator', permission),
    actor: (harness) =>
      asActor(
        harness,
        harness.seedSession({ assignments: [{ role: 'operator', scope: [SALES] }] }),
      ),
  },
  {
    name: 'user, expired assignment of role admin',
    expected: () => null,
    actor: (harness) =>
      asActor(
        harness,
        harness.seedSession({
          assignments: [
            { role: 'admin', expiresAt: new Date(harness.clock.nowMs() - 1000).toISOString() },
          ],
        }),
      ),
  },
  {
    name: 'user, role admin through a group',
    expected: (permission) =>
      GROUP_NEVER.includes(permission) ? null : holds('admin', permission),
    actor: (harness) =>
      asActor(
        harness,
        harness.seedSession({ assignments: [{ role: 'admin', viaGroup: GUID(900) }] }),
      ),
  },
  {
    name: 'user, a role that holds nothing the matrix lists (no assignment at all)',
    expected: () => null,
    actor: (harness) => asActor(harness, harness.seedSession()),
  },
  {
    name: 'setup',
    expected: (permission) => (SETUP_HOLDS.includes(permission) ? 'full' : null),
    actor: (harness) => asActor(harness, harness.seedSetupSession()),
  },
  {
    name: 'break_glass',
    expected: (permission) => (BREAK_GLASS_HOLDS.includes(permission) ? 'full' : null),
    actor: (harness) => asActor(harness, harness.seedSession({ kind: 'break_glass' })),
  },
];

describe('15 permissions x actor kinds x resource cases (FR-B-505, SC-B-006)', () => {
  for (const column of COLUMNS) {
    describe(column.name, () => {
      it.each(PERMISSIONS.map((permission) => [permission] as const))(
        '%s: route-level answer equals the matrix',
        async (permission) => {
          const harness = await createPolicyHarness();
          const decision = authorize(column.actor(harness), permission);
          const expected = column.expected(permission);
          if (expected === null) {
            expect(decision).toEqual({ allow: false, reason: 'permission_missing' });
          } else {
            expect(decision).toEqual({ allow: true, qualifier: expected });
          }
        },
      );

      it.each(
        PERMISSIONS.filter((permission) => PERMISSION_RESOURCE[permission] !== null).map(
          (permission) => [permission] as const,
        ),
      )('%s: the answer for a resource in and out of the scope', async (permission) => {
        const harness = await createPolicyHarness();
        const actor = column.actor(harness);
        const resources = resourcesOf(permission);
        if (resources === undefined) throw new Error('a resource permission has resources');
        const expected = column.expected(permission);
        const scopedToSales =
          column.name.includes('scoped to the groups of Sales') &&
          PERMISSION_RESOURCE[permission] === 'group';
        const inside = authorize(actor, permission, resources.in);
        const outside = authorize(actor, permission, resources.out);
        if (expected === null) {
          expect(inside).toEqual({ allow: false, reason: 'permission_missing' });
          expect(outside).toEqual({ allow: false, reason: 'permission_missing' });
          return;
        }
        expect(inside).toEqual({ allow: true, qualifier: expected });
        expect(outside).toEqual(
          scopedToSales
            ? { allow: false, reason: 'scope_mismatch' }
            : { allow: true, qualifier: expected },
        );
      });

      it.each(
        PERMISSIONS.filter((permission) => PERMISSION_RESOURCE[permission] === null).map(
          (permission) => [permission] as const,
        ),
      )(
        '%s: a global-only permission takes no resource (refused when not held, a usage error when held)',
        async (permission) => {
          const harness = await createPolicyHarness();
          const actor = column.actor(harness);
          // Deny first: an actor without the permission is refused. One that holds it and asks with a
          // resource has made a programming error, and the call throws instead of answering.
          const ask = (): unknown => authorize(actor, permission, { type: 'group', id: GUID(1) });
          if (column.expected(permission) === null) {
            expect(ask()).toEqual({ allow: false, reason: 'permission_missing' });
          } else {
            expect(ask).toThrow(/global-only/);
          }
        },
      );
    });
  }
});

describe('US-B6 item 4 and the time of an assignment, through the real chain', () => {
  it('allows groups:members:write on the group Sales and answers scope_mismatch for HR', async () => {
    const harness = await createPolicyHarness();
    const actor = asActor(
      harness,
      harness.seedSession({ assignments: [{ role: 'helpdesk', scope: [SALES] }] }),
    );
    expect(
      authorize(actor, 'groups:members:write', {
        type: 'group',
        id: GUID(1),
        displayName: 'Sales Benelux',
      }),
    ).toEqual({ allow: true, qualifier: 'full' });
    expect(
      authorize(actor, 'groups:members:write', { type: 'group', id: GUID(2), displayName: 'HR' }),
    ).toEqual({ allow: false, reason: 'scope_mismatch' });
  });

  it('stops granting at the instant an assignment expires (the memo is valid until then, not beyond)', async () => {
    const harness = await createPolicyHarness();
    const expiresAt = new Date(harness.clock.nowMs() + 60_000).toISOString();
    const session = harness.seedSession({ assignments: [{ role: 'admin', expiresAt }] });
    expect(authorize(asActor(harness, session), 'audit:read')).toMatchObject({ allow: true });
    harness.clock.advance(59_999);
    expect(authorize(asActor(harness, session), 'audit:read')).toMatchObject({ allow: true });
    harness.clock.advance(1);
    expect(authorize(asActor(harness, session), 'audit:read')).toEqual({
      allow: false,
      reason: 'permission_missing',
    });
  });

  it('gives a group-derived Owner neither rbac:manage nor settings:connection (FR-B-515)', async () => {
    const harness = await createPolicyHarness();
    const session = harness.seedSession({ assignments: [{ role: 'owner', viaGroup: GUID(901) }] });
    const actor = asActor(harness, session);
    for (const permission of PERMISSIONS) {
      const expected = GROUP_NEVER.includes(permission) ? 'missing' : 'allowed';
      expect(authorize(actor, permission).allow, permission).toBe(expected === 'allowed');
    }
  });

  it('negative: a comparison that trusts a wrong matrix is found (a Reader that may write)', async () => {
    const harness = await createPolicyHarness();
    const reader = asActor(harness, harness.seedSession({ roles: ['reader'] }));
    const wrong = new Set<string>(['users:read', 'groups:read', 'groups:members:write']);
    expectGuardFails((claimed: ReadonlySet<string>) => {
      for (const permission of PERMISSIONS) {
        if (authorize(reader, permission).allow !== claimed.has(permission))
          throw new Error(`${permission} differs`);
      }
    }, wrong);
  });
});

// ---------------------------------------------------------------------------------------------
// The same through HTTP: every write route of the real table
// ---------------------------------------------------------------------------------------------

const ORIGIN = 'http://localhost:9300';
const PEER = {
  incoming: {
    socket: { remoteAddress: '127.0.0.1', remotePort: 54_321, remoteFamily: 'IPv4' },
  },
  outgoing: {},
};
const WEB = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'web-dist');

interface AuditRow {
  readonly seq: number;
  readonly actor_kind: string;
  readonly actor_id: string;
  readonly action: string;
  readonly outcome: string;
  readonly reason_code: string | null;
}

interface Real {
  readonly built: BuiltApp;
  readonly identity: PolicyHarness;
  readonly database: AppDatabase;
  clientFor(headers?: Readonly<Record<string, string>>): HttpClient;
  rows(): AuditRow[];
}

/** The real application over every module the server lists, with real identities. */
async function buildReal(): Promise<Real> {
  const dir = await createTempDataDir();
  const clock = createFakeClock();
  let monotonic = 0;
  const logs = createLogCapture();
  const log = createLogger({ level: 'debug', destination: logs, now: () => clock.nowMs() });
  const paths = defaultPaths();
  const database = openDatabase({ path: join(dir.path, DATABASE_FILE_NAME) });
  await runMigrations(database.sqlite, {
    migrationsFolder: paths.migrationsFolder,
    backupsDir: join(dir.path, 'backups'),
  });
  setAuditHeadLog(log);
  onTestFinished(() => {
    clearAuditHeadLog();
    if (database.sqlite.open) database.close();
  });
  const readiness = createReadiness({
    now: () => clock.nowMs(),
    probe: createStorageProbe(dir.path),
    database: () => database,
    startFailure: () => undefined,
    migrationsFolder: paths.migrationsFolder,
  });
  const config = loadConfigOrThrow({ PUBLIC_BASE_URL: ORIGIN, DATA_DIR: dir.path });
  const identity = await createPolicyHarness({ db: database, clock });
  const handle = (): AppDatabase | undefined => database;
  const moduleDeps: ModuleDeps = {
    config,
    log,
    now: () => clock.nowMs(),
    database: handle,
    requireDatabase: requireDatabaseOf(handle),
    storageAvailable: () => readiness.storageAvailable(),
    webRoot: WEB,
    shellTemplate: readFileSync(join(WEB, 'index.html'), 'utf8'),
    sweepers: createSweeperRegistry({ log }),
    isShuttingDown: () => false,
    ...moduleDepsExtras(handle, {
      now: () => clock.nowMs(),
      overrides: { policy: identity.ports, resolveActor: identity.resolve },
    }),
  };
  const modules = appModules.map((factory) => factory(moduleDeps));
  onTestFinished(async () => {
    for (const module of [...modules].reverse()) await module.stop?.();
  });
  const built = buildApp({
    config,
    log,
    clock: {
      now: () => clock.nowMs(),
      monotonic: () => {
        monotonic += 60_000;
        return monotonic;
      },
    },
    readiness,
    database: handle,
    modules,
    moduleDeps,
    webRoot: WEB,
    shellTemplate: moduleDeps.shellTemplate,
    shutdown: { isShuttingDown: () => false },
  });
  const clientFor = (headers?: Readonly<Record<string, string>>): HttpClient =>
    createHttpClient({
      fetch: (request) => built.fetch(request, PEER),
      baseUrl: ORIGIN,
      origin: ORIGIN,
      ...(headers === undefined ? {} : { headers }),
    });
  return {
    built,
    identity,
    database,
    clientFor,
    rows: () => database.sqlite.prepare('SELECT * FROM audit_log ORDER BY seq').all() as AuditRow[],
  };
}

interface TableWrite {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly template: string;
  readonly permission: Permission;
  readonly actorKinds: readonly string[] | undefined;
  readonly multipart: boolean;
}

/** The write routes under /api/v1 that name a permission, from the table and the document. */
function permissionWrites(real: Real): TableWrite[] {
  const operations = new Map<string, { requestBody?: { content?: Record<string, unknown> } }>();
  for (const [path, item] of Object.entries(real.built.http.document.paths ?? {})) {
    for (const [method, operation] of Object.entries(item as Record<string, unknown>)) {
      operations.set(`${method.toUpperCase()} ${path}`, operation as never);
    }
  }
  const writes: TableWrite[] = [];
  for (const route of real.built.http.table.routes) {
    const method = route.methods[0] ?? '';
    const template = route.paths[0] ?? '';
    if (!template.startsWith('/api/v1/') || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(method))
      continue;
    if (!('permission' in route.access) || route.access.permission === undefined) continue;
    const content = operations.get(`${method} ${template}`)?.requestBody?.content ?? {};
    writes.push({
      id: route.id,
      method,
      template,
      path: template.replaceAll(/\{[^}]+\}/g, 'abc'),
      permission: route.access.permission,
      actorKinds: route.access.actorKinds,
      multipart: Object.keys(content).some((type) => type.startsWith('multipart/form-data')),
    });
  }
  return writes;
}

const bodyOf = (route: TableWrite): ReturnType<typeof requestBodyFor> =>
  requestBodyFor({ ...route, permission: route.permission });

/** One write call as the signed-in client of `who`, with a valid Origin and a token bound to its cookies. */
async function callAs(
  real: Real,
  who: ReturnType<typeof signedInAs>,
  route: TableWrite,
): Promise<{ response: Response; code: string | undefined; rows: AuditRow[] }> {
  const before = real.rows().length;
  const response = await who.client.request(route.method, route.path, bodyOf(route));
  const body = await readJson<{ code?: string }>(response);
  return { response, code: body.code, rows: real.rows().slice(before) };
}

function signIn(real: Real, kind: 'user' | 'break_glass', roles: readonly string[] = []) {
  return signedInAs(
    {
      db: real.database,
      clock: real.identity.clock,
      publicOrigin: ORIGIN,
      setupSessions: real.identity.setupSessions,
      clientFor: (options) => real.clientFor(options?.headers),
    },
    { kind, roles },
  );
}

describe('every write route of the real table, called directly (US-B6 item 1, FR-B-523)', () => {
  it('lists the write routes that name a permission, and covers every permission of those routes', async () => {
    const real = await buildReal();
    const writes = permissionWrites(real);
    expect(writes.length).toBeGreaterThan(0);
    for (const route of writes) expect(PERMISSIONS, route.id).toContain(route.permission);
  });

  it('a user with only Lezer gets 403 and an audit entry on each one, with a valid Origin and CSRF token', async () => {
    const real = await buildReal();
    const reader = signIn(real, 'user', ['reader']);
    for (const route of permissionWrites(real)) {
      // A Reader holds no write permission, so no route of this list is open to the role.
      expect(holds('reader', route.permission), route.id).toBeNull();
      const { response, code, rows } = await callAs(real, reader, route);
      expect(response.status, route.id).toBe(403);
      expect(code, route.id).toBe('permission_denied');
      expect(rows, route.id).toHaveLength(1);
      expect(rows[0], route.id).toMatchObject({
        actor_kind: 'user',
        actor_id: reader.oid,
        action: route.id,
        outcome: 'denied',
        reason_code: 'permission_missing',
      });
    }
  });

  it('break-glass holds rbac:manage only, and every other write route refuses it, audited', async () => {
    const real = await buildReal();
    const glass = signIn(real, 'break_glass');
    for (const route of permissionWrites(real)) {
      const kindAllowed = route.actorKinds?.includes('break_glass') === true;
      if (route.permission === 'rbac:manage' && kindAllowed) continue; // the one door (restore-owner)
      const { response, code, rows } = await callAs(real, glass, route);
      expect(response.status, route.id).toBe(403);
      expect(code, route.id).toBe('permission_denied');
      expect(rows, route.id).toHaveLength(1);
      expect(rows[0], route.id).toMatchObject({
        actor_kind: 'break_glass',
        action: route.id,
        outcome: 'denied',
        reason_code: 'permission_missing',
      });
    }
  });

  it('no write route that names a permission other than rbac:manage lists break_glass among its kinds', async () => {
    const real = await buildReal();
    for (const route of permissionWrites(real)) {
      if (route.actorKinds?.includes('break_glass') !== true) continue;
      expect(route.permission, route.id).toBe('rbac:manage');
    }
  });

  it('negative: a table that lets break-glass reach a settings route is found by the same rule', async () => {
    const real = await buildReal();
    const writes = permissionWrites(real);
    const open: TableWrite = {
      ...writes[0]!,
      permission: 'settings:branding',
      actorKinds: ['user', 'break_glass'],
    };
    expectGuardFails(
      (candidate: readonly TableWrite[]) => {
        for (const route of candidate) {
          if (
            route.actorKinds?.includes('break_glass') === true &&
            route.permission !== 'rbac:manage'
          )
            throw new Error(`${route.id} accepts break_glass`);
        }
      },
      [open, ...writes],
    );
  });
});
