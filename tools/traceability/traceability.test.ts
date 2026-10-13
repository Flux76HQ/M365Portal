// TRACEABILITY AND THE NO-PHASE-B GUARD (T-A-333, baseline section 7, SC-A-015, FR-A-188 support).
//
// Two guards, each with a negative fixture that must fail on purpose (baseline section 2):
//   1. Traceability: every requirement row of the spec has a control, the control exists on disk
//      (test path through the prefix table of spec section 2, CI job, CI step, ESLint rule), and every
//      FR-A-nnn is in at least one task. The two review-only controls are allow-listed with a reason.
//   2. No Phase B artefact: while `CURRENT_PHASE` (phase-guard.ts) is 'A' nothing of Phase B exists in
//      `apps/`, in any manifest or in the workspace catalogue. The switch is that one constant; flip it
//      in the commit that lands the first Phase B file.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { expectGuardFails } from '../../packages/shared/src/testing/index.js';
import {
  CURRENT_PHASE,
  PHASE_B_DEPENDENCIES,
  REVIEW_ONLY,
  REVIEW_ONLY_B,
  phaseCGuardIsActive,
  phaseGuardIsActive,
} from './phase-guard.js';
import {
  candidatePaths,
  checkPhaseBReport,
  checkTraceability,
  expandBraces,
  findPhaseBArtefacts,
  findPhaseCArtefacts,
  indexWorkflows,
  parseControls,
  parsePrefixTable,
  parseRequirements,
} from './trace.js';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));

const temporaryRoots: string[] = [];
afterAll(() => {
  for (const directory of temporaryRoots) rmSync(directory, { recursive: true, force: true });
});

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

/** A small consistent repository around a fixture spec and a fixture tasks file. */
function createRepository(spec: string, tasks = 'tasks-ok.md'): string {
  const root = mkdtempSync(join(tmpdir(), 'm365portal-traceability-'));
  temporaryRoots.push(root);
  cpSync(join(fixtures, spec), join(root, 'specs/001-m365portal/spec.md'));
  cpSync(join(fixtures, tasks), join(root, 'specs/001-m365portal/tasks.md'));
  write(root, 'apps/server/test/first.test.ts', '// control\n');
  write(root, 'e2e/tests/second.spec.ts', '// control\n');
  write(
    root,
    '.github/workflows/ci.yml',
    [
      'name: CI',
      'on: [push]',
      'jobs:',
      '  quality:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - name: Checkout',
      '        uses: actions/checkout@v4',
      '      - name: Lint',
      '        run: pnpm lint',
      '',
    ].join('\n'),
  );
  write(root, 'package.json', JSON.stringify({ name: 'fixture-root' }));
  return root;
}

const reviewOnly = { 'FR-A-004': 'a person decides' };

describe('traceability: parsing', () => {
  const spec = readFileSync(join(fixtures, 'spec-ok.md'), 'utf8');

  it('reads the prefix table of the spec', () => {
    expect([...parsePrefixTable(spec)]).toEqual([
      ['server', 'apps/server/test/'],
      ['e2e', 'e2e/tests/'],
    ]);
  });

  it('reads every row, keeps the last cell as "Enforced by" and finds its controls', () => {
    const rows = parseRequirements(spec);
    expect(rows.map((row) => [row.id, row.level])).toEqual([
      ['FR-A-001', 'MUST'],
      ['FR-A-002', 'MUST'],
      ['FR-A-003', 'SHOULD'],
      ['FR-A-004', 'MUST'],
    ]);
    expect(rows[0]?.controls).toEqual([
      { kind: 'step', job: 'quality', name: 'Lint' },
      {
        kind: 'test',
        ref: 'server/first.test.ts',
        candidates: ['apps/server/test/first.test.ts'],
      },
      { kind: 'job', name: 'quality' },
    ]);
    // a pipe inside code in the requirement cell does not move the last cell
    expect(rows[1]?.enforcedBy).toBe('`e2e/second.spec.ts` (+ negative)');
    expect(rows[3]?.controls).toEqual([]);
  });

  it('expands braces and the two homes of the e2e prefix', () => {
    expect(expandBraces('shared/{a,b}.test.ts')).toEqual(['shared/a.test.ts', 'shared/b.test.ts']);
    expect(expandBraces('x/{a,b/{c,d}}.ts')).toEqual(['x/a.ts', 'x/b/c.ts', 'x/b/d.ts']);
    const prefixes = new Map([['e2e', 'e2e/tests/']]);
    expect(candidatePaths('e2e/fixtures.ts', prefixes)).toEqual([
      'e2e/tests/fixtures.ts',
      'e2e/fixtures.ts',
    ]);
    expect(candidatePaths('nowhere/x.ts', prefixes)).toEqual([]);
  });

  it('reads jobs, steps with several names, lint rules and commands', () => {
    const prefixes = new Map([['server', 'apps/server/test/']]);
    expect(
      parseControls(
        '`quality` steps "A b" and "C d"; `local/no-raw-colour`; `pnpm lint`; `image`',
        prefixes,
      ),
    ).toEqual([
      { kind: 'step', job: 'quality', name: 'A b' },
      { kind: 'step', job: 'quality', name: 'C d' },
      { kind: 'job', name: 'quality' },
      { kind: 'lint-rule', rule: 'no-raw-colour' },
      { kind: 'command', command: 'pnpm lint' },
      { kind: 'job', name: 'image' },
    ]);
  });
});

describe('traceability: a consistent repository passes', () => {
  it('has no problem', () => {
    const root = createRepository('spec-ok.md');
    expect(checkTraceability(root, { reviewOnly }).problems).toEqual([]);
  });
});

describe('traceability: negative fixtures fail on purpose', () => {
  const guard = (spec: string, tasks?: string): void => {
    const { problems } = checkTraceability(createRepository(spec, tasks), { reviewOnly });
    if (problems.length > 0) throw new Error(problems.join('\n'));
  };

  it('a MUST row with an empty "Enforced by"', () => {
    expectGuardFails(
      () => {
        guard('spec-must-without-control.md');
      },
      undefined,
      {
        name: 'traceability',
        reason: 'FR-A-001: a MUST row with an empty "Enforced by"',
      },
    );
  });

  it('a requirement row that names a test that does not exist', () => {
    expectGuardFails(
      () => {
        guard('spec-missing-test.md');
      },
      undefined,
      {
        name: 'traceability',
        reason: 'FR-A-001: server/does-not-exist.test.ts does not exist',
      },
    );
  });

  it('a step that the workflow does not have', () => {
    expectGuardFails(
      () => {
        guard('spec-missing-step.md');
      },
      undefined,
      {
        name: 'traceability',
        reason: 'FR-A-001: CI job "quality" has no step named "A step nobody wrote"',
      },
    );
  });

  it('a CI job that does not exist', () => {
    expectGuardFails(
      () => {
        guard('spec-missing-job.md');
      },
      undefined,
      {
        name: 'traceability',
        reason: 'FR-A-001: CI job "publish" does not exist in .github/workflows',
      },
    );
  });

  it('a requirement that no task mentions', () => {
    expectGuardFails(
      () => {
        guard('spec-ok.md', 'tasks-missing-fr.md');
      },
      undefined,
      {
        name: 'traceability',
        reason: 'FR-A-003: appears in no task of tasks.md',
      },
    );
  });

  it('a MUST whose only control is review and that is not on the allow-list', () => {
    const root = createRepository('spec-ok.md');
    expectGuardFails(
      () => {
        const { problems } = checkTraceability(root, { reviewOnly: {} });
        if (problems.length > 0) throw new Error(problems.join('\n'));
      },
      undefined,
      { name: 'traceability', reason: 'FR-A-004: a MUST row whose "Enforced by" names no control' },
    );
  });

  it('an allow-list entry for a requirement that does not exist', () => {
    const root = createRepository('spec-ok.md');
    expect(
      checkTraceability(root, { reviewOnly: { ...reviewOnly, 'FR-A-999': 'gone' } }).problems,
    ).toEqual(['FR-A-999: on the review-only list but not a requirement of the spec']);
  });

  it('indexes the steps of a workflow job (the guard reads real files)', () => {
    const root = createRepository('spec-ok.md');
    expect(indexWorkflows(root).jobs.get('quality')).toEqual(['Checkout', 'Lint']);
  });
});

describe('traceability: the real repository', () => {
  const result = checkTraceability(repositoryRoot);

  it('reads the spec (the parse cannot silently shrink)', () => {
    expect(result.requirements.length).toBeGreaterThanOrEqual(140);
    expect(result.requirements.filter((row) => row.level === 'MUST').length).toBeGreaterThanOrEqual(
      127,
    );
  });

  it('gives every MUST an enforcing control that exists, and every FR-A a task', () => {
    expect(result.problems).toEqual([]);
  });

  it('allows review as the only control for exactly the two documented requirements', () => {
    expect(Object.keys(REVIEW_ONLY).sort()).toEqual(['FR-A-103', 'FR-A-188']);
    for (const [id, reason] of Object.entries(REVIEW_ONLY)) {
      expect(reason.length, `${id} needs a reason`).toBeGreaterThan(40);
    }
    // FR-A-188 is review only; FR-A-103 has an automated part as well.
    const byId = new Map(result.requirements.map((row) => [row.id, row]));
    expect(byId.get('FR-A-188')?.controls).toEqual([]);
    expect(byId.get('FR-A-103')?.controls.length).toBeGreaterThan(0);
  });

  it('no MUST row other than the allow-listed one is review only', () => {
    const reviewOnlyMusts = result.requirements
      .filter((row) => row.level === 'MUST' && row.controls.length === 0)
      .map((row) => row.id);
    expect(reviewOnlyMusts).toEqual(['FR-A-188']);
  });
});

describe('no Phase B artefact (CURRENT_PHASE in phase-guard.ts)', () => {
  /** A small tree with the shape of the repository and no Phase B in it. */
  function createTree(): string {
    const root = mkdtempSync(join(tmpdir(), 'm365portal-phase-guard-'));
    temporaryRoots.push(root);
    write(
      root,
      'package.json',
      JSON.stringify({ name: 'fixture-root', devDependencies: { vitest: '1' } }),
    );
    write(root, 'pnpm-workspace.yaml', 'packages:\n  - apps/*\ncatalog:\n  hono: 4.0.0\n');
    write(
      root,
      'apps/server/package.json',
      JSON.stringify({ name: 's', dependencies: { hono: '4' } }),
    );
    write(
      root,
      'apps/server/src/app.ts',
      "// the /setup wizard and /api/v1/session are Phase B (a comment is not code)\nexport const ok = 'ready';\n",
    );
    write(root, 'apps/web/package.json', JSON.stringify({ name: 'w', dependencies: {} }));
    write(root, 'apps/web/src/routes/index.tsx', 'export const route = 1;\n');
    return root;
  }

  const phaseBCases: readonly (readonly [string, (root: string) => void, RegExp])[] = [
    [
      'a banned dependency in a manifest',
      (root) => {
        write(
          root,
          'apps/server/package.json',
          JSON.stringify({ name: 's', dependencies: { jose: '6' } }),
        );
      },
      /apps\/server\/package\.json declares the Phase B dependency jose/,
    ],
    [
      'a banned scope in a dev dependency',
      (root) => {
        write(
          root,
          'apps/web/package.json',
          JSON.stringify({ name: 'w', devDependencies: { '@opentelemetry/api': '1' } }),
        );
      },
      /declares the Phase B dependency @opentelemetry\/api/,
    ],
    [
      'a banned dependency pinned in the workspace catalogue',
      (root) => {
        write(root, 'pnpm-workspace.yaml', 'catalog:\n  msw: 2.0.0\n');
      },
      /pnpm-workspace\.yaml pins the Phase B dependency msw/,
    ],
    [
      'an auth directory in the server',
      (root) => {
        write(root, 'apps/server/src/auth/index.ts', 'export {};\n');
      },
      /apps\/server\/src\/auth exists/,
    ],
    [
      'a session directory in the server',
      (root) => {
        write(root, 'apps/server/src/session/store.ts', 'export {};\n');
      },
      /apps\/server\/src\/session exists/,
    ],
    [
      'a route that registers /api/v1/session',
      (root) => {
        write(
          root,
          'apps/server/src/routes/x.ts',
          "export const path = '/api/v1/session/refresh';\n",
        );
      },
      /mentions the Phase B path "\/api\/v1\/session\/refresh"/,
    ],
    [
      'a wizard route file in the web app',
      (root) => {
        write(root, 'apps/web/src/routes/setup.tsx', 'export const route = 2;\n');
      },
      /apps\/web\/src\/routes\/setup\.tsx is a route file of Phase B/,
    ],
    [
      'a Graph client',
      (root) => {
        write(root, 'apps/server/src/graph-client.ts', 'export class GraphClient {}\n');
      },
      /declares GraphClient/,
    ],
    [
      'an Exchange client declared under another file name',
      (root) => {
        write(
          root,
          'apps/server/src/mail.ts',
          'export interface ExchangeClient { send(): void }\n',
        );
      },
      /apps\/server\/src\/mail\.ts declares ExchangeClient/,
    ],
  ];

  it('is clean on a tree without Phase B, comments that mention it included', () => {
    expect(findPhaseBArtefacts(createTree())).toEqual([]);
  });

  for (const [title, plant, pattern] of phaseBCases) {
    it(`NEGATIVE: finds ${title}`, () => {
      const root = createTree();
      plant(root);
      expectGuardFails(
        () => {
          const found = findPhaseBArtefacts(root);
          if (found.length > 0) throw new Error(found.join('\n'));
        },
        undefined,
        { name: 'no Phase B artefact', reason: pattern },
      );
    });
  }

  it('lists every dependency the task bans', () => {
    expect([...PHASE_B_DEPENDENCIES].sort()).toEqual(
      [
        '@azure/msal-node',
        '@microsoft/microsoft-graph-client',
        '@opentelemetry/*',
        'jose',
        'libsodium-wrappers',
        'msw',
      ].sort(),
    );
  });

  it('the switch: the ban applies in phase A and is lifted by the one constant', () => {
    expect(phaseGuardIsActive('A')).toBe(true);
    expect(phaseGuardIsActive('B')).toBe(false);
  });

  // The title says which state the repository is in; when CURRENT_PHASE becomes 'B' this test is
  // skipped on purpose and the Phase A checks above keep running.
  const phaseA = phaseGuardIsActive(CURRENT_PHASE);
  it.skipIf(!phaseA)(
    `the real repository has no Phase B scope (CURRENT_PHASE is '${CURRENT_PHASE}': ${phaseA ? 'the ban applies' : 'the ban is lifted, Phase B code may exist'})`,
    () => {
      expect(findPhaseBArtefacts(repositoryRoot)).toEqual([]);
    },
  );
});

// =============================================================================================
// Phase B (T-B-394, XB34, baseline section 7, SC-B-017, FR-B-712)
// =============================================================================================
//
// The same traceability over `specs/002-phase-b/spec.md`: every MUST row has a non-empty "Enforced by"
// that names a control, every test path named there (through the prefix line of spec section 2) exists,
// every CI job and step cited exists, and every FR-B-nnn is in the TITLE of at least one task. Then the
// guard of Phase C: nothing of Phase C exists while the phase is B, and the report of Phase B, once it
// exists, ends with an approval line that nobody filled.

const SPEC_B = 'specs/002-phase-b/spec.md';
const TASKS_B = 'specs/002-phase-b/tasks.md';

function createPhaseBRepository(spec: string, tasks = 'tasks-b-ok.md'): string {
  const root = mkdtempSync(join(tmpdir(), 'm365portal-traceability-b-'));
  temporaryRoots.push(root);
  cpSync(join(fixtures, spec), join(root, SPEC_B));
  cpSync(join(fixtures, tasks), join(root, TASKS_B));
  write(root, 'apps/server/test/first.test.ts', '// control\n');
  write(root, 'tools/traceability/traceability.test.ts', '// control\n');
  write(
    root,
    '.github/workflows/ci.yml',
    [
      'name: CI',
      'jobs:',
      '  quality:',
      '    steps:',
      '      - name: Lint',
      '        run: pnpm lint',
      '',
    ].join('\n'),
  );
  return root;
}

describe('Phase B traceability: parsing', () => {
  const spec = readFileSync(join(fixtures, 'spec-b-ok.md'), 'utf8');

  it('reads the prefixes from the prose line of spec section 2', () => {
    expect([...parsePrefixTable(spec)]).toEqual([
      ['server', 'apps/server/test/'],
      ['e2e', 'e2e/tests/'],
      ['py', 'scripts/'],
    ]);
  });

  it('reads FR-B rows and a control that lives under tools/', () => {
    const rows = parseRequirements(spec);
    expect(rows.map((row) => [row.id, row.level])).toEqual([
      ['FR-B-001', 'MUST'],
      ['FR-B-002', 'MUST'],
      ['FR-B-003', 'SHOULD'],
    ]);
    expect(rows[1]?.controls).toEqual([
      {
        kind: 'test',
        ref: 'tools/traceability/traceability.test.ts',
        candidates: ['tools/traceability/traceability.test.ts'],
      },
    ]);
  });
});

describe('Phase B traceability: negative fixtures fail on purpose', () => {
  const guard = (spec: string, tasks?: string): void => {
    const { problems } = checkTraceability(createPhaseBRepository(spec, tasks), {
      spec: SPEC_B,
      tasks: TASKS_B,
      reviewOnly: REVIEW_ONLY_B,
      titlesOnly: true,
    });
    if (problems.length > 0) throw new Error(problems.join('\n'));
  };

  it('a consistent Phase B repository has no problem', () => {
    expect(() => {
      guard('spec-b-ok.md');
    }).not.toThrow();
  });

  it('a requirement named only in the prose below a task is not in a task title', () => {
    expectGuardFails(
      () => {
        guard('spec-b-ok.md', 'tasks-b-prose-only.md');
      },
      undefined,
      { name: 'traceability B', reason: 'FR-B-003: appears in no task of tasks.md' },
    );
  });

  it('a requirement row that names a test that does not exist', () => {
    expectGuardFails(
      () => {
        guard('spec-b-missing-tool.md');
      },
      undefined,
      {
        name: 'traceability B',
        reason: 'FR-B-001: tools/traceability/nowhere.test.ts does not exist',
      },
    );
  });

  it('the prose line of the prefixes is needed: without it a server/ path has no prefix', () => {
    const root = createPhaseBRepository('spec-b-ok.md');
    write(
      root,
      SPEC_B,
      readFileSync(join(fixtures, 'spec-b-ok.md'), 'utf8').replace(
        'Test path prefixes',
        'Other words',
      ),
    );
    const { problems } = checkTraceability(root, {
      spec: SPEC_B,
      tasks: TASKS_B,
      reviewOnly: REVIEW_ONLY_B,
      titlesOnly: true,
    });
    expect(problems.some((problem) => problem.includes('prefix table of section 2'))).toBe(true);
  });
});

describe('Phase B traceability: the real repository', () => {
  const result = checkTraceability(repositoryRoot, {
    spec: SPEC_B,
    tasks: TASKS_B,
    reviewOnly: REVIEW_ONLY_B,
    titlesOnly: true,
  });

  it('reads the spec (the parse cannot silently shrink)', () => {
    expect(result.requirements.length).toBeGreaterThanOrEqual(110);
    expect(result.requirements.filter((row) => row.level === 'MUST').length).toBeGreaterThanOrEqual(
      105,
    );
    expect(new Set(result.requirements.map((row) => row.id)).size).toBe(result.requirements.length);
  });

  it('allows no requirement to rest on review alone: FR-B-712 has its automated part', () => {
    expect(Object.keys(REVIEW_ONLY_B)).toEqual([]);
    const byId = new Map(result.requirements.map((row) => [row.id, row]));
    expect(byId.get('FR-B-712')?.controls.length).toBeGreaterThan(0);
    const reviewOnlyMusts = result.requirements
      .filter((row) => row.level === 'MUST' && row.controls.length === 0)
      .map((row) => row.id);
    expect(reviewOnlyMusts).toEqual([]);
  });

  it('gives every MUST an enforcing control that exists, and every FR-B a task title', () => {
    expect(result.problems).toEqual([]);
  });
});

describe('no Phase C artefact (CURRENT_PHASE is B; FR-B-712)', () => {
  /** A small tree with the shape of the repository after Phase B and nothing of Phase C. */
  function createTree(): string {
    const root = mkdtempSync(join(tmpdir(), 'm365portal-phase-c-guard-'));
    temporaryRoots.push(root);
    write(root, 'apps/server/src/rbac/module.ts', 'export {};\n');
    write(
      root,
      'apps/server/src/ports/graph.ts',
      'export interface GraphClient {\n  getUser(id: string): Promise<null>;\n  checkMemberGroups(): Promise<void>;\n  searchGroups(prefix: string): Promise<void>;\n}\n',
    );
    write(
      root,
      'apps/server/src/ports/exchange.ts',
      'export interface ExchangeClient {\n  capabilities(): { write: readonly [] };\n  probe(): Promise<void>;\n  listDistributionGroupMembers(identity: string): AsyncIterable<string>;\n}\n',
    );
    write(
      root,
      'apps/server/src/integrations/exchange/client.ts',
      "export class C { capabilities() { return { read: ['organizationConfig'], write: [] }; } }\n",
    );
    write(
      root,
      'apps/server/src/routes/x.ts',
      "// /api/v1/users is Phase C (a comment is not code)\nexport const path = '/api/v1/me';\n",
    );
    return root;
  }

  const report = (approval: string, extra = ''): string =>
    [
      '# Phase B',
      ...Array.from(
        { length: 18 },
        (_unused, index) => `ODB-${String(index + 1).padStart(2, '0')}`,
      ),
      ...Array.from({ length: 23 }, (_unused, index) => `OV-${String(index + 1).padStart(2, '0')}`),
      '',
      'Akkoord om door te gaan met fase C?',
      '',
      approval,
      extra,
      '',
    ].join('\n');

  const cases: readonly (readonly [string, (root: string) => void, RegExp])[] = [
    [
      'a users module in the server',
      (root) => {
        write(root, 'apps/server/src/users/index.ts', 'export {};\n');
      },
      /apps\/server\/src\/users exists \(Phase C\)/,
    ],
    [
      'a groups module in the server',
      (root) => {
        write(root, 'apps/server/src/groups/index.ts', 'export {};\n');
      },
      /apps\/server\/src\/groups exists/,
    ],
    [
      'distribution, contacts and exchange-write modules',
      (root) => {
        for (const name of ['distribution', 'contacts', 'exchange-write']) {
          write(root, `apps/server/src/${name}/index.ts`, 'export {};\n');
        }
      },
      /distribution exists[\s\S]*contacts exists[\s\S]*exchange-write exists|contacts exists[\s\S]*distribution exists/,
    ],
    [
      'a /api/v1/users route in code',
      (root) => {
        write(
          root,
          'apps/server/src/routes/users.ts',
          "export const path = '/api/v1/users/{id}';\n",
        );
      },
      /mentions the Phase C path "\/api\/v1\/users\/\{id\}"/,
    ],
    [
      'a /api/v1/groups route registered with a template',
      (root) => {
        write(
          root,
          'apps/server/src/routes/groups.ts',
          'export const r = { path: `/api/v1/groups` };\n',
        );
      },
      /registers a route below \/api\/v1\/users or \/api\/v1\/groups/,
    ],
    [
      'a list method on GraphClient',
      (root) => {
        write(
          root,
          'apps/server/src/ports/graph.ts',
          'export interface GraphClient {\n  getUser(): void;\n  listUsers(): void;\n}\n',
        );
      },
      /GraphClient has the method listUsers/,
    ],
    [
      'a write method on GraphClient',
      (root) => {
        write(
          root,
          'apps/server/src/ports/graph.ts',
          'export interface GraphClient {\n  updateUser(): void;\n}\n',
        );
      },
      /GraphClient has the method updateUser/,
    ],
    [
      'a write method on ExchangeClient',
      (root) => {
        write(
          root,
          'apps/server/src/ports/exchange.ts',
          'export interface ExchangeClient {\n  createContact(): void;\n}\n',
        );
      },
      /ExchangeClient has the method createContact/,
    ],
    [
      'a capability that writes',
      (root) => {
        write(
          root,
          'apps/server/src/integrations/exchange/client.ts',
          "export const c = () => ({ read: [], write: ['newMailContact'] });\n",
        );
      },
      /capabilities\(\)\.write is not empty \(newMailContact\)/,
    ],
    [
      'a Phase C report',
      (root) => {
        write(root, 'docs/phase-reports/phase-C.md', '# Phase C\n');
      },
      /docs\/phase-reports\/phase-C\.md exists/,
    ],
    [
      'the undecided Exchange write path in the server',
      (root) => {
        write(
          root,
          'apps/server/src/integrations/exchange/ps.ts',
          `export const p = '${['Invoke', 'Command'].join('')}';\n`,
        );
      },
      /names the undecided Exchange write path/,
    ],
  ];

  it('is clean on a tree without Phase C, comments that mention it included', () => {
    expect(findPhaseCArtefacts(createTree())).toEqual([]);
    expect(checkPhaseBReport(createTree())).toEqual([]);
  });

  for (const [title, plant, pattern] of cases) {
    it(`NEGATIVE: finds ${title}`, () => {
      const root = createTree();
      plant(root);
      expectGuardFails(
        () => {
          const found = findPhaseCArtefacts(root);
          if (found.length > 0) throw new Error(found.join('\n'));
        },
        undefined,
        { name: 'no Phase C artefact', reason: pattern },
      );
    });
  }

  it('the report of Phase B: an empty approval line passes, a filled one and a missing decision fail', () => {
    const empty = createTree();
    write(empty, 'docs/phase-reports/phase-B.md', report('Goedkeuring (naam en datum):'));
    expect(checkPhaseBReport(empty)).toEqual([]);
    write(empty, 'docs/phase-reports/phase-B.md', report('Goedkeuring (naam en datum): ______'));
    expect(checkPhaseBReport(empty)).toEqual([]);

    const filled = createTree();
    write(
      filled,
      'docs/phase-reports/phase-B.md',
      report('Goedkeuring (naam en datum): Jan, 2026-10-20'),
    );
    expectGuardFails(
      () => {
        const found = checkPhaseBReport(filled);
        if (found.length > 0) throw new Error(found.join('\n'));
      },
      undefined,
      { name: 'approval line', reason: /approval line with nothing filled in/ },
    );

    const text = report('Goedkeuring (naam en datum):')
      .replace('ODB-07', 'xxx-07')
      .replace('OV-12', 'xx-12');
    const missing = createTree();
    write(missing, 'docs/phase-reports/phase-B.md', text);
    expect(checkPhaseBReport(missing)).toEqual([
      'docs/phase-reports/phase-B.md: ODB-07 is missing',
      'docs/phase-reports/phase-B.md: OV-12 is missing',
    ]);

    const trailing = createTree();
    write(
      trailing,
      'docs/phase-reports/phase-B.md',
      report('Goedkeuring (naam en datum):', 'Approved.'),
    );
    expect(checkPhaseBReport(trailing).join('\n')).toMatch(/nothing may follow the approval line/);
  });

  it('the switch: the ban applies in phase B only', () => {
    expect(phaseCGuardIsActive('A')).toBe(false);
    expect(phaseCGuardIsActive('B')).toBe(true);
    expect(phaseCGuardIsActive('C')).toBe(false);
    expect(phaseCGuardIsActive('D')).toBe(false);
  });

  it("Phase D: the repository is in phase 'D' (T-D-105) and no earlier guard is active", () => {
    expect(CURRENT_PHASE).toBe('D');
    expect(phaseGuardIsActive('D')).toBe(false);
    expect(phaseCGuardIsActive(CURRENT_PHASE)).toBe(false);
  });

  const active = phaseCGuardIsActive(CURRENT_PHASE);
  it.skipIf(!active)(
    `the real repository has no Phase C scope (CURRENT_PHASE is '${CURRENT_PHASE}')`,
    () => {
      expect(findPhaseCArtefacts(repositoryRoot)).toEqual([]);
    },
  );

  it('the real report, once it exists, ends with an empty approval line and holds every decision and item', () => {
    expect(checkPhaseBReport(repositoryRoot)).toEqual([]);
  });
});
