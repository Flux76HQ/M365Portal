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
  phaseGuardIsActive,
} from './phase-guard.js';
import {
  candidatePaths,
  checkTraceability,
  expandBraces,
  findPhaseBArtefacts,
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
