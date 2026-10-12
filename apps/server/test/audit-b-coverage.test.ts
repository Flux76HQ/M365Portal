// T-B-391 (FR-B-601, FR-B-602, I-B8, SC-B-005): audit coverage over the route table and the vocabulary.
//
// The route table is read the way a client reads it, from the OpenAPI document of the running
// application (it carries `x-route-id`, `x-audit`, the method and the path of every route), and the
// contract file (P01 to P32) is read independently of the code. The checks:
//
//   - every action of `vocabulary` (`AUDIT_ACTIONS`, the 19 of spec 6.9.6) has a route that declares it
//     or a named code path with its own control, and every action a Phase B route declares exists in
//     the vocabulary (a route declaring an unknown action fails);
//   - the declaration of each Phase B route is one of the actions the contract names for it;
//   - the write routes without an audit declaration are exactly P12, P23 and P24 (control actions on
//     in-memory process state, FR-B-601); a write route outside that list without one fails;
//   - after one full run every row names an actor as kind plus id (users by `oid` only), an action of
//     the vocabulary, the target type and an outcome that action allows, and detail keys from its list;
//     the actions the run can reach all appear, each with its success entry.
//
// The success, denied and rejected cases of each action are proved by `setup/audit-setup.test.ts`,
// `rbac/audit-rbac.test.ts` and `audit-denials.test.ts` (which iterate the same table), in the same
// transaction as the change; this file makes sure no route and no action falls outside them.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expectGuardFails } from '@m365portal/shared/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUDIT_ACTIONS } from '../src/audit/actions.js';
import { readJson } from './helpers/http-client.js';
import { runFullLifecycle, type AuditRow, type FullRun } from './helpers/full-run.js';
import { startWizardServer } from './setup/support/server-scene.js';
import { useWizardTimers } from './setup/support/tenant-scene.js';

const CONTRACT = fileURLToPath(
  new URL('../../../specs/002-phase-b/contracts/phase-b-api.md', import.meta.url),
);
const TEST_ROOT = fileURLToPath(new URL('./', import.meta.url));

/** FR-B-601: control actions on in-memory process state that change no configuration or access. */
const AUDIT_EXEMPT_WRITES: readonly string[] = [
  'setup.session.end',
  'connection.runs.retry.now',
  'connection.runs.cancel',
];

/**
 * The actions that no route declares, and where each is written instead. The control is the test that
 * proves the entry; it must exist and name the action.
 */
const CODE_PATHS: Readonly<Record<string, { readonly where: string; readonly control: string }>> = {
  'setup.reopen': { where: 'the CLI command setup-reopen', control: 'setup/cli-setup.test.ts' },
  'secrets.app_key.rotate': {
    where: 'the CLI command rotate-app-key',
    control: 'secrets/rotate.test.ts',
  },
  'auth.stepup': { where: 'the callback with purpose stepup', control: 'auth/step-up.test.ts' },
  'auth.session.revoked': { where: 'revalidation', control: 'auth/revalidate.test.ts' },
  'setup.tenant.pin': { where: 'verification V2', control: 'setup/tenant-pin.test.ts' },
  'setup.complete': {
    where: 'the callback of the designated Owner',
    control: 'setup/complete-on-signin.test.ts',
  },
  'secrets.certificate.create': {
    where: 'certificate generation inside a run',
    control: 'secrets/no-plaintext.test.ts',
  },
  'connection.repair': { where: 'a repair run', control: 'connection/repair.test.ts' },
  'breakglass.signout': {
    where: 'logout by a break-glass session',
    control: 'auth/logout.test.ts',
  },
};

interface OperationEntry {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly audit: string | undefined;
}

interface ContractRow {
  readonly number: string;
  readonly id: string;
  readonly method: string;
  readonly audit: readonly string[];
}

/** The route index of the contract, read independently of the code (section 2). */
function contractRows(): ContractRow[] {
  const rows: ContractRow[] = [];
  for (const line of readFileSync(CONTRACT, 'utf8').split('\n')) {
    if (!/^\| P\d\d \|/.test(line)) continue;
    const cells = line.split(/(?<!\\)\|/).map((cell) => cell.trim());
    const id = /`([^`]+)`/.exec(cells[2] ?? '')?.[1] ?? '';
    const method = /`(GET|POST|PUT|PATCH|DELETE) /.exec(cells[3] ?? '')?.[1] ?? '';
    const audit = [...(cells[6] ?? '').matchAll(/`([a-z]+(?:\.[a-z_]+)+)`/g)].map(
      (match) => match[1] ?? '',
    );
    rows.push({ number: cells[1] ?? '', id, method, audit });
  }
  return rows;
}

interface OpenApiPaths {
  readonly paths: Record<string, Record<string, Record<string, unknown>>>;
}

function operationsOf(document: OpenApiPaths): OperationEntry[] {
  return Object.entries(document.paths).flatMap(([path, methods]) =>
    Object.entries(methods).map(([method, operation]) => ({
      id: String(operation['x-route-id']),
      method: method.toUpperCase(),
      path,
      audit: typeof operation['x-audit'] === 'string' ? operation['x-audit'] : undefined,
    })),
  );
}

interface Coverage {
  readonly operations: readonly OperationEntry[];
  readonly contract: readonly ContractRow[];
  readonly vocabulary: readonly string[];
  readonly exempt: readonly string[];
}

/** Throws with every problem found; the real application and the contract must give none. */
function assertCoverage(input: Coverage): void {
  const problems: string[] = [];
  const contractIds = new Set(input.contract.map((row) => row.id));
  const byId = new Map(input.operations.map((operation) => [operation.id, operation]));

  for (const row of input.contract) {
    const operation = byId.get(row.id);
    if (operation === undefined) {
      problems.push(`${row.number} ${row.id}: the route is not in the route table`);
      continue;
    }
    if (operation.audit !== undefined) {
      if (!input.vocabulary.includes(operation.audit)) {
        problems.push(
          `${row.id}: declares the action ${operation.audit}, which is not in the vocabulary`,
        );
      }
      if (!row.audit.includes(operation.audit)) {
        problems.push(
          `${row.id}: declares ${operation.audit}, the contract names [${row.audit.join(', ')}]`,
        );
      }
    } else if (row.method !== 'GET' && !input.exempt.includes(row.id)) {
      problems.push(`${row.id}: a write route without an audit declaration, and not exempt`);
    }
  }
  for (const id of input.exempt) {
    const operation = byId.get(id);
    if (operation === undefined) problems.push(`${id}: exempt, but not in the route table`);
    else if (operation.audit !== undefined)
      problems.push(`${id}: exempt, but declares ${operation.audit}`);
  }
  for (const row of input.contract) {
    for (const action of row.audit) {
      if (!input.vocabulary.includes(action)) {
        problems.push(
          `${row.number}: the contract names ${action}, which is not in the vocabulary`,
        );
      }
    }
  }
  // A Phase B route (one the contract lists) is the only kind that may declare a Phase B action.
  for (const operation of input.operations) {
    if (
      operation.audit !== undefined &&
      input.vocabulary.includes(operation.audit) &&
      !contractIds.has(operation.id)
    ) {
      problems.push(
        `${operation.id}: not in the contract, but declares the Phase B action ${operation.audit}`,
      );
    }
  }
  for (const action of input.vocabulary) {
    const declared = input.operations.some((operation) => operation.audit === action);
    const path = CODE_PATHS[action];
    if (!declared && path === undefined) {
      problems.push(`${action}: no route declares it and no code path is named`);
    }
    if (path !== undefined) {
      const file = `${TEST_ROOT}${path.control}`;
      if (!existsSync(file)) problems.push(`${action}: the control ${path.control} does not exist`);
      else if (!readFileSync(file, 'utf8').includes(action)) {
        problems.push(`${action}: the control ${path.control} does not mention it`);
      }
    }
  }
  if (problems.length > 0) throw new Error(problems.join('\n'));
}

/** The detail of a denial written by the route wrapper: the method, the route template, the permission. */
const DENIAL_DETAIL_KEYS = ['method', 'route', 'permission'];

const ACTOR_ID: Readonly<Record<string, RegExp>> = {
  user: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  setup: /^setup$/,
  break_glass: /^break-glass$/,
  anonymous: /^anonymous$/,
  system: /^system$/,
  cli: /^cli$/,
};

/** Throws unless every row is a well-formed entry of the vocabulary; the named actions must all be there. */
function assertRows(rows: readonly AuditRow[], required: readonly string[]): void {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const definition = (
      AUDIT_ACTIONS as Readonly<
        Record<
          string,
          | {
              targetType: string;
              outcomes: readonly string[];
              actorKinds: readonly string[];
              detailKeys: readonly string[];
            }
          | undefined
        >
      >
    )[row.action];
    if (definition === undefined) continue; // a Phase A action: judged by the Phase A tests
    seen.add(`${row.action}:${row.outcome}`);
    const label = `#${String(row.seq)} ${row.action}`;
    const pattern = ACTOR_ID[row.actor_kind];
    if (pattern === undefined)
      problems.push(`${label}: actor kind ${row.actor_kind} is not allowed`);
    else if (!pattern.test(row.actor_id)) {
      problems.push(
        `${label}: the actor id of kind ${row.actor_kind} is not its form (users by oid only)`,
      );
    }
    // A denial is written by the route wrapper under the route id, for whoever asked (FR-B-602).
    if (row.outcome !== 'denied' && !definition.actorKinds.includes(row.actor_kind)) {
      problems.push(`${label}: actor kind ${row.actor_kind} may not write this action`);
    }
    if (!definition.outcomes.includes(row.outcome)) {
      problems.push(
        `${label}: outcome ${row.outcome} is not one of [${definition.outcomes.join(', ')}]`,
      );
    }
    if (row.target_type !== null && row.target_type !== definition.targetType) {
      problems.push(`${label}: target type ${row.target_type}, expected ${definition.targetType}`);
    }
    const detail = JSON.parse(row.detail) as Record<string, unknown>;
    const allowedKeys: readonly string[] =
      row.outcome === 'denied'
        ? [...definition.detailKeys, ...DENIAL_DETAIL_KEYS]
        : definition.detailKeys;
    for (const key of Object.keys(detail)) {
      if (!allowedKeys.includes(key))
        problems.push(`${label}: the detail key ${key} is not allowed`);
    }
    if (/@|eyJ[A-Za-z0-9_-]{10,}/.test(row.detail) || /@/.test(row.actor_id)) {
      problems.push(`${label}: the entry holds a user name or a token`);
    }
  }
  for (const action of required) {
    if (!seen.has(`${action}:success`)) problems.push(`${action}: no success entry in the run`);
  }
  if (problems.length > 0) throw new Error(problems.join('\n'));
}

/** What a full run can reach through the API, a callback, the CLI and the revalidation. */
const REACHED_BY_THE_RUN = [
  'setup.unlock',
  'setup.step.run',
  'setup.object.change',
  'setup.tenant.pin',
  'setup.complete',
  'secrets.certificate.create',
  'connection.verify',
  'auth.signin',
  'auth.stepup',
  'auth.signout',
  'auth.session.revoked',
  'breakglass.signin',
  'breakglass.signout',
  'rbac.assignment.create',
  'secrets.app_key.rotate',
];

describe('the route table and the audit vocabulary (FR-B-601)', () => {
  it('the vocabulary has the 19 actions of table 6.9.6', () => {
    expect(Object.keys(AUDIT_ACTIONS)).toHaveLength(19);
  });

  it('every action has a route or a code path with a control, every declaration exists in the vocabulary, and the exempt writes are P12, P23 and P24', async () => {
    const server = await startWizardServer({
      env: {
        BREAK_GLASS_USERNAME: 'operator',
        BREAK_GLASS_PASSWORD_HASH: `scrypt:16384:8:1:${Buffer.alloc(16, 3).toString('base64url')}:${Buffer.alloc(32, 5).toString('base64url')}`,
      },
    });
    const document = await readJson<OpenApiPaths>(
      await server.client().get('/api/v1/openapi.json'),
    );
    const contract = contractRows();
    expect(contract).toHaveLength(32);
    expect(AUDIT_EXEMPT_WRITES).toEqual(
      contract.filter((row) => ['P12', 'P23', 'P24'].includes(row.number)).map((row) => row.id),
    );
    expect(() => {
      assertCoverage({
        operations: operationsOf(document),
        contract,
        vocabulary: Object.keys(AUDIT_ACTIONS),
        exempt: AUDIT_EXEMPT_WRITES,
      });
    }).not.toThrow();
  });

  describe('negative fixtures: the coverage guard fails on purpose', () => {
    const vocabulary = ['a.known', 'b.known'];
    const contract: ContractRow[] = [
      { number: 'P90', id: 'a.route', method: 'POST', audit: ['a.known'] },
      { number: 'P91', id: 'b.route', method: 'POST', audit: [] },
    ];
    const operations = (): OperationEntry[] => [
      { id: 'a.route', method: 'POST', path: '/a', audit: 'a.known' },
      { id: 'b.route', method: 'POST', path: '/b', audit: undefined },
    ];
    const base = (): Coverage => ({
      operations: operations(),
      contract,
      vocabulary: ['a.known'],
      exempt: ['b.route'],
    });
    const guard = (input: Coverage): void => {
      assertCoverage(input);
    };

    it('passes for a consistent table', () => {
      expect(() => {
        guard(base());
      }).not.toThrow();
    });

    it('a route that declares an action outside the vocabulary', () => {
      expectGuardFails(
        guard,
        {
          ...base(),
          operations: [{ ...operations()[0]!, audit: 'unknown.action' }, operations()[1]!],
        },
        { reason: /not in the vocabulary/ },
      );
    });

    it('a write route without an audit declaration that is not exempt', () => {
      expectGuardFails(
        guard,
        { ...base(), exempt: [] },
        { reason: /a write route without an audit declaration/ },
      );
    });

    it('an action in the vocabulary that no route declares and no code path names', () => {
      expectGuardFails(
        guard,
        { ...base(), vocabulary: ['a.known', 'orphan.action'] },
        { reason: /orphan.action: no route declares it/ },
      );
    });

    it('a declaration the contract does not name for the route', () => {
      expectGuardFails(
        guard,
        {
          ...base(),
          contract: [{ ...contract[0]!, audit: ['b.known'] }, contract[1]!],
          vocabulary,
        },
        { reason: /the contract names \[b.known\]/ },
      );
    });

    it('an exempt route that is not exempt after all, and a contract route missing from the table', () => {
      expectGuardFails(
        guard,
        { ...base(), exempt: ['a.route', 'b.route'] },
        { reason: /exempt, but declares/ },
      );
      expectGuardFails(
        guard,
        { ...base(), operations: operations().slice(1) },
        { reason: /not in the route table/ },
      );
    });
  });
});

describe('the entries of a full run (FR-B-601)', () => {
  beforeEach(() => {
    useWizardTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  let run: FullRun | undefined;

  it('every entry is kind plus id, an action of the vocabulary with its target, outcome and detail keys, and each reachable action has its success entry', async () => {
    run = await runFullLifecycle();
    expect(run.facts.completed).toBe(true);
    expect(() => {
      assertRows(run?.auditRows ?? [], REACHED_BY_THE_RUN);
    }).not.toThrow();
    // Denials are in the log too: the lock of the setup token and the wrong break-glass password.
    const outcomes = new Set(run.auditRows.map((row) => `${row.action}:${row.outcome}`));
    expect(outcomes.has('setup.unlock:denied')).toBe(true);
    expect(outcomes.has('breakglass.signin:denied')).toBe(true);
    expect(outcomes.has('auth.signin:denied')).toBe(true);
  }, 300_000);

  describe('negative fixtures: the row guard fails on purpose', () => {
    const row = (change: Partial<AuditRow> = {}): AuditRow => ({
      seq: 1,
      actor_kind: 'user',
      actor_id: '5b0d7a3e-8c1f-4f6e-9a52-0d3c2b1a4e77',
      action: 'auth.signin',
      target_type: 'app_user',
      outcome: 'success',
      reason_code: null,
      detail: '{"mfa":true,"purpose":"signin"}',
      ...change,
    });
    const guard = (rows: AuditRow[]): void => {
      assertRows(rows, ['auth.signin']);
    };

    it('passes for a good row', () => {
      expect(() => {
        guard([row()]);
      }).not.toThrow();
    });

    it.each([
      [
        'a user recorded by user name',
        { actor_id: 'someone@contoso.example' },
        /oid only|user name/,
      ],
      [
        'an actor kind the action does not allow',
        { actor_kind: 'cli', actor_id: 'cli' },
        /may not write/,
      ],
      ['an outcome the action does not have', { outcome: 'rejected' }, /outcome rejected/],
      ['a detail key outside the list', { detail: '{"token":"x"}' }, /detail key token/],
      [
        'a token in the detail',
        { detail: '{"mfa":"eyJhbGciOiJSUzI1NiJ9.abcdefghijklmnop"}' },
        /user name or a token|detail key|not allowed/,
      ],
      ['a wrong target type', { target_type: 'secret' }, /target type/],
    ] as const)('refuses %s', (_label, change, reason) => {
      expectGuardFails(guard, [row(change)], { reason });
    });

    it('refuses a run without the success entry of a required action', () => {
      expectGuardFails(guard, [row({ outcome: 'denied' })], { reason: /no success entry/ });
    });
  });
});
