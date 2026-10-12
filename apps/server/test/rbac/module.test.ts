// T-B-253, P09 and P27 to P32, US-B6: the rbac module registers exactly the routes of table 6.9.7 of the
// spec, with its access, class and audit action, and the route ids and paths of the contract; its `start`
// runs the check of the built-in roles; nothing in it belongs to Phase C or D.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BuiltinRolesMismatchError } from '../../src/rbac/builtin-check.js';
import { RBAC_MODULE_ID } from '../../src/rbac/module.js';
import { readServerSources, stripComments } from '../helpers/source-files.js';
import { createApiFixture } from './api-fixture.js';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SPEC = readFileSync(join(ROOT, 'specs', '002-phase-b', 'spec.md'), 'utf8');
const CONTRACT = readFileSync(
  join(ROOT, 'specs', '002-phase-b', 'contracts', 'phase-b-api.md'),
  'utf8',
);

const IDS = [
  'me.access',
  'rbac.roles.list',
  'rbac.assignments.list',
  'rbac.assignments.create',
  'rbac.assignments.delete',
  'rbac.effective',
  'rbac.restore.owner',
] as const;

interface Row {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly access: string;
  readonly klass: string;
  readonly audit: string;
}

/** The rows of the route tables (spec 6.9.7 and contract section 2) for these ids. */
function rowsOf(markdown: string, klassColumn: number, auditColumn: number): Row[] {
  const rows: Row[] = [];
  for (const line of markdown.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim());
    const id = /^`([a-z.]+)`$/.exec(cells[1] ?? '')?.[1];
    if (id === undefined || !(IDS as readonly string[]).includes(id)) continue;
    const [method = '', rawPath = ''] = (cells[2] ?? '').replaceAll('`', '').split(' ');
    rows.push({
      id,
      method,
      path: rawPath.split('?')[0] ?? '',
      access: cells[3] ?? '',
      klass: cells[klassColumn] ?? '',
      audit: (cells[auditColumn] ?? '').replaceAll('`', ''),
    });
  }
  return rows;
}

const SPEC_ROWS = rowsOf(SPEC, 4, 5);
const CONTRACT_ROWS = rowsOf(CONTRACT, 4, 5);

describe('the route index of the module against table 6.9.7', () => {
  it('has a row for each of the seven routes in the spec and in the contract', () => {
    expect(SPEC_ROWS.map((row) => row.id).sort()).toEqual([...IDS].sort());
    expect(CONTRACT_ROWS.map((row) => row.id).sort()).toEqual([...IDS].sort());
  });

  it('registers exactly those routes, with method, path, rate class and audit action of the table', async () => {
    const f = await createApiFixture();
    const module = f.modules.find((candidate) => candidate.id === RBAC_MODULE_ID);
    const routes = module?.routes({} as never) ?? [];
    expect(routes.map((route) => route.id).sort()).toEqual([...IDS].sort());
    for (const row of SPEC_ROWS) {
      const route = routes.find((candidate) => candidate.id === row.id);
      expect(route, row.id).toBeDefined();
      expect(route?.method, row.id).toBe(row.method);
      expect(route?.path.replaceAll(/\{[^}]+\}/g, '{id}'), row.id).toBe(row.path);
      expect(route?.rateLimit, row.id).toBe(row.klass);
      expect(route?.audit ?? '', row.id).toBe(row.audit === 'none' ? '' : row.audit);
    }
  });

  it('declares the access of the table: permission, step-up and actor kinds', async () => {
    const f = await createApiFixture();
    const routes =
      f.modules.find((candidate) => candidate.id === RBAC_MODULE_ID)?.routes({} as never) ?? [];
    for (const row of SPEC_ROWS) {
      const access = routes.find((candidate) => candidate.id === row.id)?.access;
      expect(access, row.id).toBeDefined();
      if (row.access === 'authenticated') {
        expect(access, row.id).toEqual({ authenticated: true });
        continue;
      }
      expect(access?.permission, row.id).toBe(/`(\w+:\w+)`/.exec(row.access)?.[1]);
      expect(access?.stepUp === true, row.id).toBe(row.access.includes('stepUp'));
      const kinds = /actorKinds: \[([^\]]*)\]/.exec(row.access)?.[1];
      expect(access?.actorKinds, row.id).toEqual(
        kinds === undefined
          ? undefined
          : kinds
              .replaceAll("'", '')
              .split(',')
              .map((k) => k.trim()),
      );
      expect(access?.unscopedReason, row.id).toBeTruthy();
    }
  });

  it('the application serves them (the route table and the OpenAPI document carry the ids)', async () => {
    const f = await createApiFixture();
    const tableIds = f.built.http.table.routes.map((route) => route.id);
    for (const id of IDS) expect(tableIds, id).toContain(id);
    const operations = Object.values(f.built.http.document.paths ?? {}).flatMap((item) =>
      Object.values(item as Record<string, { 'x-route-id'?: string }>),
    );
    const documented = operations.map((operation) => operation['x-route-id']);
    for (const id of IDS) expect(documented, id).toContain(id);
  });
});

describe('start runs the check of the built-in roles (FR-B-501)', () => {
  it('resolves for the seeded database', async () => {
    const f = await createApiFixture();
    const module = f.modules.find((candidate) => candidate.id === RBAC_MODULE_ID);
    await expect(
      module?.start?.({ requireDatabase: () => f.db } as never),
    ).resolves.toBeUndefined();
  });

  it('ends with builtin_roles_mismatch when a built-in row differs, and logs the code', async () => {
    const f = await createApiFixture();
    f.db.sqlite.exec('DROP TRIGGER rbac_role_permission_builtin_no_delete');
    f.db.sqlite.exec("DELETE FROM rbac_role_permission WHERE permission = 'audit:export'");
    const module = f.modules.find((candidate) => candidate.id === RBAC_MODULE_ID);
    await expect(module?.start?.({ requireDatabase: () => f.db } as never)).rejects.toBeInstanceOf(
      BuiltinRolesMismatchError,
    );
    expect(f.logs.lines().some((line) => line.event === 'builtin_roles_mismatch')).toBe(true);
  });
});

describe('nothing in the module belongs to Phase C or D (FR-B-712)', () => {
  it('no path of the module is a user, group, list, contact or audit route', () => {
    const offenders = readServerSources()
      .filter((file) => file.path.startsWith('rbac/'))
      .filter((file) =>
        /\/api\/v1\/(users|groups|distribution|contacts|audit|lists)/.test(
          stripComments(file.text),
        ),
      );
    expect(offenders.map((file) => file.path)).toEqual([]);
  });

  it('the Graph port has no list or write method (the module could not call one)', async () => {
    const f = await createApiFixture();
    const methods = [
      'getOrganization',
      'probeUsers',
      'getUser',
      'checkMemberGroups',
      'searchGroups',
      'getGroup',
    ];
    expect(
      Object.getOwnPropertyNames(Object.getPrototypeOf(f.fake))
        .filter((name) => name !== 'constructor' && !name.startsWith('#'))
        .sort(),
    ).toEqual(expect.arrayContaining(methods.sort()));
  });
});
