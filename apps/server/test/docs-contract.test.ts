// T-A-270 (FR-A-006, FR-A-011 docs table, FR-A-030 docs half, FR-A-073 note, FR-A-180 to FR-A-186,
// SC-A-014, TA-02, E-24, E-25): the documentation contract (AGENTS.md section 5, baseline section 6)
// as an automated control. `pnpm docs:check` runs this file and `limits-doc.test.ts`.
//
// Every rule is a guard: a function that THROWS when the document breaks it. The real document must
// pass it, and a negative fixture (a file under `fixtures/docs/` or a document built in the test)
// must fail it with the reason that belongs to the rule (`expectGuardFails`, tasks.md section 0.3).
//
// Documents this file reads, and who writes them:
//   README.md, docs/architecture.md, docs/security.md, docs/permissions.md, docs/operations.md and
//   docs/open-points.md   S8, T-A-274 to T-A-279 (a later chunk: until then the tests that read them
//                         are red, and the failure names the missing document or section)
//   docs/adr/             S8, T-A-271 to T-A-273
//   spec.md, plan.md, tasks.md, contracts/phase-a-api.md   already there
//
// Formats the document authors must follow (the guards cannot guess them):
//   - environment table (operations.md): header starts with "Variable" and has a "Default" column;
//     one row per variable of `ENV_VARIABLES` plus `HOST_PORT`, the name in the first cell;
//   - SVG allowlist (security.md): in the section "SVG allowlist", a table `Kind | Names`; the row
//     "Elements" and one row per attribute kind of `SVG_ALLOWLIST.attributes` (row label = the key),
//     the names as backticked tokens;
//   - panel catalogue (permissions.md): a table whose header has no "Status" column and whose first
//     cell holds the permission in backticks; Graph and Exchange table: header has "Reason", "Phase"
//     and "Status"; an UNVERIFIED row names its register id (`U7`), and open-points.md has a table
//     row whose first cell is that id;
//   - dependency table (architecture.md): header has "Dependency" (the package name in the first
//     cell), "Reason" and "Mark" (reuse, adapt or replace);
//   - ADRs: `docs/adr/NNNN-slug.md`, first line `# ADR-NNNN: title`, one line
//     `Samenvatting (NL): ...`, and the headings Status, Context, Decision, Consequences, Evidence.
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PERMISSIONS } from '@m365portal/shared/permissions';
import { expectGuardFails } from '@m365portal/shared/testing';
import { afterAll, describe, expect, it } from 'vitest';
import { SVG_ALLOWLIST } from '../src/branding/pipeline/svg/allowlist.js';
import { ENV_VARIABLES, ENV_VARIABLE_NAMES } from '../src/config/index.js';
import {
  assertAdr0102,
  assertArchitecturePhaseB,
  assertNegativeControlTable,
  assertOpenPointsPhaseB,
  assertOperationsPhaseB,
  assertPermissionsPhaseB,
  assertReadmePhaseB,
  assertRoutesMatchContract,
  assertSecurityPhaseB,
  contractRouteIds,
  halves,
} from './fixtures/docs/phase-b.js';
import { startWizardServer } from './setup/support/server-scene.js';
import { readJson } from './helpers/http-client.js';
import {
  anchorsOf,
  codeTokens,
  findTable,
  headingsOf,
  linksOf,
  sectionOf,
  stripMarkup,
  tablesIn,
} from './fixtures/docs/markdown.js';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const fixtureDirectory = fileURLToPath(new URL('./fixtures/docs/', import.meta.url));
const specDirectory = join(repositoryRoot, 'specs/001-m365portal');

function readFixture(name: string): string {
  return readFileSync(join(fixtureDirectory, name), 'utf8');
}

/** A repository document; a missing one fails with the task that writes it. */
function readDocument(path: string, task: string): string {
  const full = join(repositoryRoot, path);
  if (!existsSync(full)) throw new Error(`${path} is missing (${task})`);
  return readFileSync(full, 'utf8');
}

const flat = (text: string): string => text.replace(/\s+/g, ' ');

function requireHeading(markdown: string, title: RegExp, what: string): void {
  if (!headingsOf(markdown).some((heading) => title.test(heading.text))) {
    throw new Error(`missing section: ${what}`);
  }
}

function requireText(markdown: string, pattern: RegExp | string, what: string): void {
  const found =
    typeof pattern === 'string' ? markdown.includes(pattern) : pattern.test(flat(markdown));
  if (!found) throw new Error(`missing: ${what}`);
}

const scratch: string[] = [];
afterAll(() => {
  for (const path of scratch) rmSync(path, { recursive: true, force: true });
});

// =============================================================================================
// Links, images, languages, the demo GIF (FR-A-180, SC-A-014)
// =============================================================================================

const MAX_GIF_BYTES = 2 * 1024 * 1024;

/** Every relative link and image resolves to a file or directory; a `.md` anchor to a heading. */
function assertLinksResolve(
  markdown: string,
  baseDirectory: string,
  ownAnchors?: Set<string>,
): void {
  const own = ownAnchors ?? anchorsOf(markdown);
  for (const link of linksOf(markdown)) {
    const target = link.target;
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    const [pathPart = '', anchor] = target.split('#');
    if (pathPart === '') {
      if (anchor !== undefined && anchor !== '' && !own.has(anchor)) {
        throw new Error(`broken anchor in the same document: #${anchor}`);
      }
      continue;
    }
    const resolved = resolve(baseDirectory, decodeURIComponent(pathPart));
    if (!existsSync(resolved)) {
      throw new Error(`broken ${link.image ? 'image' : 'link'}: ${target} does not exist`);
    }
    if (anchor !== undefined && anchor !== '' && resolved.endsWith('.md')) {
      if (!anchorsOf(readFileSync(resolved, 'utf8')).has(anchor)) {
        throw new Error(`broken anchor: ${target} has no such heading`);
      }
    }
  }
}

function assertBothLanguages(markdown: string): void {
  const top = headingsOf(markdown).filter((heading) => heading.level <= 2);
  if (!top.some((heading) => /^english\b/i.test(heading.text))) {
    throw new Error('README has no English section (a heading "English")');
  }
  if (!top.some((heading) => /^nederlands\b/i.test(heading.text))) {
    throw new Error('README has no Dutch section (a heading "Nederlands")');
  }
}

function assertDemoGif(markdown: string, baseDirectory: string): void {
  const gifs = linksOf(markdown).filter((link) => /\.gif$/i.test(link.target.split('#')[0] ?? ''));
  if (gifs.length === 0) throw new Error('README references no demo GIF');
  for (const gif of gifs) {
    const size = statSync(resolve(baseDirectory, gif.target)).size;
    if (size > MAX_GIF_BYTES) {
      throw new Error(
        `demo GIF ${gif.target} is ${String(size)} bytes, over ${String(MAX_GIF_BYTES)}`,
      );
    }
  }
}

describe('README, links and media (FR-A-180)', () => {
  it('the link guard fails on a missing file, a missing heading and a missing image', () => {
    const fixture = readFixture('readme-broken-links.md');
    expectGuardFails(
      (md: string) => {
        assertLinksResolve(md, fixtureDirectory);
      },
      fixture,
      {
        name: 'assertLinksResolve',
        reason: /broken link: \.\/no-such-file\.md/,
      },
    );
    expectGuardFails(
      (md: string) => {
        assertLinksResolve(md.replace(/\[the operations guide\]\([^)]*\)/, ''), fixtureDirectory);
      },
      fixture,
      {
        name: 'assertLinksResolve (anchor)',
        reason: /broken anchor: \.\/operations-limits-skeleton\.md#no-such-heading/,
      },
    );
    expectGuardFails(
      (md: string) => {
        assertLinksResolve(
          md
            .replace(/\[the operations guide\]\([^)]*\)/, '')
            .replace(/\[a heading that is not there\]\([^)]*\)/, '')
            .replace(/\[this section\]\([^)]*\)/, ''),
          fixtureDirectory,
        );
      },
      fixture,
      { name: 'assertLinksResolve (image)', reason: /broken image: \.\/media\/never-taken\.png/ },
    );
    expectGuardFails(
      (md: string) => {
        assertLinksResolve(md, fixtureDirectory);
      },
      '[x](#nowhere)\n',
      { reason: /broken anchor in the same document: #nowhere/ },
    );
  });

  it('the link guard accepts a link to an existing heading of an existing document', () => {
    expect(() => {
      assertLinksResolve(
        '[ok](./operations-limits-skeleton.md#limits-outside-the-repository) [web](https://example.org/x#y)',
        fixtureDirectory,
      );
    }).not.toThrow();
  });

  it('the language guard fails on a README with one language', () => {
    expectGuardFails(assertBothLanguages, readFixture('readme-english-only.md'), {
      reason: /no Dutch section/,
    });
    expectGuardFails(assertBothLanguages, '# R\n\n## Nederlands\n', {
      reason: /no English section/,
    });
  });

  it('the GIF guard fails on a file over 2 MiB and on a README without a GIF', () => {
    const directory = mkdtempSync(join(tmpdir(), 'docs-contract-'));
    scratch.push(directory);
    writeFileSync(join(directory, 'big.gif'), Buffer.alloc(MAX_GIF_BYTES + 1));
    writeFileSync(join(directory, 'ok.gif'), Buffer.alloc(MAX_GIF_BYTES));
    expectGuardFails(
      (md: string) => {
        assertDemoGif(md, directory);
      },
      '![demo](./big.gif)',
      {
        reason: /is 2097153 bytes/,
      },
    );
    expectGuardFails(
      (md: string) => {
        assertDemoGif(md, directory);
      },
      'no media here',
      {
        reason: /no demo GIF/,
      },
    );
    expect(() => {
      assertDemoGif('![demo](./ok.gif)', directory);
    }).not.toThrow();
  });

  it('README.md has an English and a Dutch section, resolving links and images, a demo GIF of at most 2 MiB', () => {
    const readme = readDocument('README.md', 'T-A-279');
    assertBothLanguages(readme);
    assertLinksResolve(readme, repositoryRoot);
    assertDemoGif(readme, repositoryRoot);
  });

  it('every relative link of every document under docs/ resolves', () => {
    const documents = [
      'docs/architecture.md',
      'docs/security.md',
      'docs/permissions.md',
      'docs/operations.md',
      'docs/open-points.md',
    ];
    for (const path of documents) {
      assertLinksResolve(
        readDocument(path, 'T-A-274 to T-A-278'),
        dirname(join(repositoryRoot, path)),
      );
    }
    for (const name of adrFiles()) {
      const path = join(repositoryRoot, 'docs/adr', name);
      assertLinksResolve(readFileSync(path, 'utf8'), dirname(path));
    }
  });
});

// =============================================================================================
// docs/operations.md (FR-A-181, FR-A-182, FR-A-011, FR-A-177, A-57, E-24, E-25)
// =============================================================================================

function assertOperationsDocument(markdown: string): void {
  requireHeading(markdown, /\bsetup\b|\binstall/i, 'setup');
  requireHeading(markdown, /run and stop|start and stop/i, 'run and stop');
  requireHeading(markdown, /health/i, 'health endpoints');
  requireText(markdown, '/healthz', 'the endpoint /healthz');
  requireText(markdown, '/readyz', 'the endpoint /readyz');
  requireHeading(markdown, /deploy/i, 'deploy');
  requireHeading(markdown, /update/i, 'update');
  requireHeading(markdown, /backup/i, 'backup and restore');
  requireText(markdown, '-wal', 'the -wal file in the backup instructions');
  requireText(markdown, '-shm', 'the -shm file in the backup instructions');
  requireHeading(markdown, /architecture/i, 'runtime architecture with the data locations');
  requireText(markdown, '/data', 'the data location /data');
  requireText(markdown, /single[- ]replica/i, 'the single-replica rule (A-57)');
  requireText(markdown, /local disk/i, 'the local-disk rule (A-57)');
  requireText(markdown, 'chown 65532:65532', 'chown 65532:65532 (E-25)');
  requireText(markdown, /merge queue/i, 'the merge-queue recommendation (FR-A-177)');
  requireHeading(
    markdown,
    /^limits outside the repository$/i,
    'the anchor #limits-outside-the-repository',
  );
  if (!anchorsOf(markdown).has('limits-outside-the-repository')) {
    throw new Error('the anchor #limits-outside-the-repository does not exist');
  }
  requireHeading(markdown, /^nederlands$/i, 'a Dutch section "Nederlands"');
}

function operationsSample(): string {
  return [
    '## Setup',
    '## Run and stop',
    '## Health endpoints',
    '`/healthz` `/readyz`',
    '## Deploy and update',
    '## Backup and restore',
    'copy `-wal` and `-shm`',
    '## Runtime architecture',
    'data in `/data`',
    'Single replica on a local disk.',
    '`chown 65532:65532`',
    'Use a merge queue.',
    '## Limits outside the repository',
    '## Nederlands',
  ]
    .map((line) => (line.startsWith('#') ? `${line}\n` : `${line}\n`))
    .join('\n');
}

const GOOD_ENV_ROWS = (): string[][] => [
  ...ENV_VARIABLES.map((variable) => [variable.name, variable.defaultText]),
  ['HOST_PORT', '9300'],
];

function environmentTable(rows: string[][]): string {
  return [
    '| Variable | Default | Meaning |',
    '|---|---|---|',
    ...rows.map(([name, value]) => `| \`${name ?? ''}\` | \`${value ?? ''}\` | text |`),
  ].join('\n');
}

function envExampleNames(text: string): string[] {
  return [...text.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1] ?? '');
}

/** The environment table equals `ENV_VARIABLES` plus `HOST_PORT`, with the defaults, and `.env.example`. */
function assertEnvironmentTable(markdown: string, envExample: string): void {
  const table = findTable(markdown, (header) => /^variable/i.test(header[0] ?? ''));
  if (table === undefined)
    throw new Error('operations.md has no environment table (header "Variable")');
  const defaultColumn = table.header.findIndex((cell) => /default/i.test(cell));
  if (defaultColumn === -1) throw new Error('the environment table has no "Default" column');
  const names = table.rows.map((row) => row[0] ?? '');
  const expected = [...ENV_VARIABLE_NAMES, 'HOST_PORT'];
  for (const name of expected) {
    if (!names.includes(name)) throw new Error(`the environment table has no row for ${name}`);
  }
  for (const name of names) {
    if (!expected.includes(name))
      throw new Error(`the environment table has a row for ${name}, which no configuration reads`);
  }
  if (new Set(names).size !== names.length)
    throw new Error('the environment table repeats a variable');
  for (const variable of ENV_VARIABLES) {
    if (variable.name === 'PUBLIC_BASE_URL') continue;
    const row = table.rows.find((candidate) => candidate[0] === variable.name);
    const cell = (row?.[defaultColumn] ?? '').replace(/(?<=\d),(?=\d{3})/g, '');
    if (!cell.includes(variable.defaultText)) {
      throw new Error(
        `the default of ${variable.name} is ${variable.defaultText}, the table says "${cell}"`,
      );
    }
  }
  const example = new Set(envExampleNames(envExample));
  for (const name of names) {
    if (!example.has(name))
      throw new Error(`.env.example has no ${name}, which the environment table lists`);
  }
  for (const name of example) {
    if (!names.includes(name))
      throw new Error(`the environment table has no row for ${name}, which .env.example has`);
  }
}

describe('docs/operations.md (FR-A-181, FR-A-182, FR-A-011, FR-A-177, E-25)', () => {
  it('the section guard fails on the skeleton and on each missing item', () => {
    expectGuardFails(assertOperationsDocument, readFixture('operations-limits-skeleton.md'), {
      reason: /missing section: setup/,
    });
    expect(() => {
      assertOperationsDocument(operationsSample());
    }).not.toThrow();
    const drops: [string, RegExp][] = [
      ['## Backup and restore', /backup and restore/],
      ['copy `-wal` and `-shm`', /-wal/],
      ['`chown 65532:65532`', /chown 65532:65532/],
      ['Single replica on a local disk.', /single-replica/],
      ['Use a merge queue.', /merge-queue/],
      ['## Nederlands', /Dutch section/],
      ['## Limits outside the repository', /limits-outside-the-repository/],
    ];
    for (const [text, reason] of drops) {
      expectGuardFails(assertOperationsDocument, operationsSample().replace(text, ''), { reason });
    }
  });

  it('the environment guard fails on a missing, an extra and a different variable', () => {
    const example =
      ENV_VARIABLES.map((variable) => `${variable.name}=x`).join('\n') + '\nHOST_PORT=9300\n';
    const guard = (rows: string[][]) => {
      assertEnvironmentTable(environmentTable(rows), example);
    };
    expect(() => {
      guard(GOOD_ENV_ROWS());
    }).not.toThrow();
    expectGuardFails(
      guard,
      GOOD_ENV_ROWS().filter((row) => row[0] !== 'LOG_LEVEL'),
      {
        name: 'assertEnvironmentTable',
        reason: /no row for LOG_LEVEL/,
      },
    );
    expectGuardFails(guard, [...GOOD_ENV_ROWS(), ['MADE_UP', 'x']], {
      name: 'assertEnvironmentTable',
      reason: /MADE_UP, which no configuration reads/,
    });
    expectGuardFails(
      guard,
      GOOD_ENV_ROWS().map((row) => (row[0] === 'LOG_LEVEL' ? ['LOG_LEVEL', 'debug'] : row)),
      {
        name: 'assertEnvironmentTable',
        reason: /default of LOG_LEVEL is info/,
      },
    );
    expectGuardFails(
      (text: string) => {
        assertEnvironmentTable(environmentTable(GOOD_ENV_ROWS()), text);
      },
      example.replace('SHOWCASE=x\n', ''),
      { name: 'assertEnvironmentTable (.env.example)', reason: /\.env\.example has no SHOWCASE/ },
    );
    expectGuardFails(
      (text: string) => {
        assertEnvironmentTable(environmentTable(GOOD_ENV_ROWS()), text);
      },
      `${example}EXTRA_VARIABLE=1\n`,
      { name: 'assertEnvironmentTable (.env.example extra)', reason: /no row for EXTRA_VARIABLE/ },
    );
    expectGuardFails(
      (text: string) => {
        assertEnvironmentTable('no table here\n', text);
      },
      '',
      {
        name: 'assertEnvironmentTable (no table)',
        reason: /no environment table/,
      },
    );
  });

  it('has setup, run and stop, health, deploy and update, backup and restore, the architecture, the rules and a Dutch section', () => {
    assertOperationsDocument(readDocument('docs/operations.md', 'T-A-277'));
  });

  it('has an environment table equal to the configuration plus HOST_PORT, and to .env.example', () => {
    assertEnvironmentTable(
      readDocument('docs/operations.md', 'T-A-277'),
      readDocument('.env.example', 'T-A-230'),
    );
  });
});

// =============================================================================================
// docs/security.md (FR-A-183, FR-A-073, FR-A-032)
// =============================================================================================

function assertSecurityDocument(markdown: string): void {
  requireText(markdown, /\bSTRIDE\b/, 'the STRIDE model');
  requireText(markdown, /\bCSRF\b/, 'the CSRF design');
  requireText(markdown, /\bOrigin\b/, 'the Origin design');
  requireText(
    markdown,
    /Phase B[^.]*\bbinding\b|\bbinding\b[^.]*Phase B/i,
    'the Phase B binding of the CSRF token',
  );
  requireHeading(markdown, /header/i, 'the header table');
  requireText(markdown, 'Content-Security-Policy', 'the header table (Content-Security-Policy)');
  requireHeading(markdown, /upload/i, 'the upload pipeline');
  requireHeading(markdown, /svg allowlist/i, 'the SVG allowlist');
  requireText(markdown, /audit chain/i, 'the audit chain');
  requireText(markdown, /truncat/i, 'the limits of the audit chain (tail truncation)');
  requireText(
    markdown,
    /preview[- ]mode[^.]*\brisk|\brisk[^.]*preview[- ]mode/i,
    'the preview-mode risk',
  );
  requireText(markdown, /\bASVS\b/, 'the ASVS mapping');
  requireText(
    markdown,
    /client address[^.]*personal data/i,
    'that the client address is personal data',
  );
}

function securitySample(): string {
  return [
    '## Threat model',
    'STRIDE.',
    '## Origin and CSRF',
    'CSRF and Origin; the Phase B binding is an argument.',
    '## Security headers',
    '| Header |',
    'Content-Security-Policy',
    '## Upload pipeline',
    '## SVG allowlist',
    '## Audit chain',
    'Tail truncation is not detected.',
    '## Preview mode',
    'The preview-mode risk is open administration.',
    '## Application verification',
    'ASVS level 2.',
    'The client address is personal data.',
  ].join('\n\n');
}

function allowlistSection(change: (rows: [string, string[]][]) => void = () => undefined): string {
  const rows: [string, string[]][] = [
    ['Elements', [...SVG_ALLOWLIST.elements]],
    ...Object.entries(SVG_ALLOWLIST.attributes).map(([kind, names]): [string, string[]] => [
      kind,
      [...names],
    ]),
  ];
  change(rows);
  return [
    '## SVG allowlist',
    '',
    '| Kind | Names |',
    '|---|---|',
    ...rows.map(
      ([kind, names]) => `| ${kind} | ${names.map((name) => `\`${name}\``).join(', ')} |`,
    ),
  ].join('\n');
}

/** The allowlist of security.md equals `SVG_ALLOWLIST`: same elements, same attribute kinds, same names. */
function assertSvgAllowlistDocument(markdown: string): void {
  const section = sectionOf(markdown, /svg allowlist/i);
  if (section === undefined) throw new Error('security.md has no section "SVG allowlist"');
  const table = findTable(
    section,
    (header) => header.length >= 2 && /^kind/i.test(header[0] ?? ''),
  );
  if (table === undefined) throw new Error('the SVG allowlist section has no table Kind | Names');
  const documented = new Map<string, string[]>();
  table.rawRows.forEach((row) => {
    documented.set(stripMarkup(row[0] ?? '').toLowerCase(), codeTokens(row[1] ?? ''));
  });
  const expected = new Map<string, readonly string[]>([
    ['elements', SVG_ALLOWLIST.elements],
    ...Object.entries(SVG_ALLOWLIST.attributes).map(
      ([kind, names]): [string, readonly string[]] => [kind.toLowerCase(), names],
    ),
  ]);
  for (const [kind, names] of expected) {
    const found = documented.get(kind);
    if (found === undefined) throw new Error(`the SVG allowlist table has no row "${kind}"`);
    for (const name of names) {
      if (!found.includes(name))
        throw new Error(`the SVG allowlist (${kind}) lacks \`${name}\`, which the code allows`);
    }
    for (const name of found) {
      if (!names.includes(name))
        throw new Error(
          `the SVG allowlist (${kind}) lists \`${name}\`, which the code does not allow`,
        );
    }
    if (new Set(found).size !== found.length)
      throw new Error(`the SVG allowlist (${kind}) repeats a name`);
  }
  for (const kind of documented.keys()) {
    if (!expected.has(kind))
      throw new Error(`the SVG allowlist table has a row "${kind}" that the code does not have`);
  }
}

describe('docs/security.md (FR-A-183)', () => {
  it('the section guard fails on a missing item', () => {
    expect(() => {
      assertSecurityDocument(securitySample());
    }).not.toThrow();
    const drops: [string, RegExp][] = [
      ['STRIDE.', /STRIDE/],
      ['the Phase B binding is an argument', /Phase B binding/],
      ['Content-Security-Policy', /header table \(Content-Security-Policy\)/],
      ['## Upload pipeline', /upload pipeline/],
      ['## SVG allowlist', /SVG allowlist/],
      ['Tail truncation is not detected.', /tail truncation/],
      ['The preview-mode risk is open administration.', /preview-mode risk/],
      ['ASVS level 2.', /ASVS/],
      ['The client address is personal data.', /personal data/],
    ];
    for (const [text, reason] of drops) {
      expectGuardFails(assertSecurityDocument, securitySample().replace(text, ''), { reason });
    }
  });

  it('the allowlist guard fails on a missing, an extra and a moved name and on an unknown row', () => {
    expect(() => {
      assertSvgAllowlistDocument(allowlistSection());
    }).not.toThrow();
    expectGuardFails(
      assertSvgAllowlistDocument,
      allowlistSection((rows) => {
        rows[0]?.[1].splice(rows[0][1].indexOf('mask'), 1);
      }),
      { reason: /\(elements\) lacks `mask`/ },
    );
    expectGuardFails(
      assertSvgAllowlistDocument,
      allowlistSection((rows) => {
        rows[0]?.[1].push('filter');
      }),
      { reason: /\(elements\) lists `filter`, which the code does not allow/ },
    );
    expectGuardFails(
      assertSvgAllowlistDocument,
      allowlistSection((rows) => {
        rows[1]?.[1].push('onclick');
      }),
      { reason: /lists `onclick`/ },
    );
    expectGuardFails(
      assertSvgAllowlistDocument,
      allowlistSection((rows) => {
        rows.push(['scripting', ['script']]);
      }),
      { reason: /row "scripting" that the code does not have/ },
    );
    expectGuardFails(
      assertSvgAllowlistDocument,
      allowlistSection((rows) => {
        rows.splice(2, 1);
      }),
      { reason: /has no row/ },
    );
    expectGuardFails(assertSvgAllowlistDocument, '## Other\n', {
      reason: /no section "SVG allowlist"/,
    });
  });

  it('has the STRIDE model, the CSRF and Origin design, the header table, the upload pipeline, the audit chain, the preview-mode risk and the ASVS mapping', () => {
    assertSecurityDocument(readDocument('docs/security.md', 'T-A-275'));
  });

  it('publishes an SVG allowlist equal to SVG_ALLOWLIST', () => {
    assertSvgAllowlistDocument(readDocument('docs/security.md', 'T-A-275'));
  });
});

// =============================================================================================
// docs/permissions.md (FR-A-184, TA-02)
// =============================================================================================

const STATUSES = ['verified', 'corrected', 'UNVERIFIED'];

/** Part 1 lists exactly the entries of `PERMISSIONS`, each once. */
function assertPanelCatalogue(markdown: string): void {
  const table = findTable(
    markdown,
    (header) => /permission/i.test(header[0] ?? '') && !header.some((cell) => /status/i.test(cell)),
  );
  if (table === undefined)
    throw new Error('permissions.md has no panel catalogue table (a header without "Status")');
  const listed = table.rawRows.flatMap((row) => codeTokens(row[0] ?? ''));
  for (const permission of PERMISSIONS) {
    if (!listed.includes(permission)) throw new Error(`the panel catalogue lacks ${permission}`);
  }
  for (const entry of listed) {
    if (!(PERMISSIONS as readonly string[]).includes(entry)) {
      throw new Error(`the panel catalogue lists ${entry}, which is no panel permission`);
    }
  }
  if (new Set(listed).size !== listed.length)
    throw new Error('the panel catalogue repeats a permission');
  if (listed.length !== 15)
    throw new Error(`the panel catalogue lists ${String(listed.length)} permissions, not 15`);
}

/** Part 2: reason, phase and status on every row; an UNVERIFIED row has its register row. */
function assertGraphTable(markdown: string, openPoints: string): void {
  const table = findTable(markdown, (header) =>
    ['reason', 'phase', 'status'].every((word) =>
      header.some((cell) => cell.toLowerCase() === word),
    ),
  );
  if (table === undefined)
    throw new Error('permissions.md has no Graph and Exchange table (Reason, Phase, Status)');
  if (table.rows.length === 0) throw new Error('the Graph and Exchange table has no rows');
  const column = (word: string): number =>
    table.header.findIndex((cell) => cell.toLowerCase() === word);
  const registerIds = new Set(
    tablesIn(openPoints).flatMap((candidate) => candidate.rows.map((row) => row[0] ?? '')),
  );
  for (const row of table.rows) {
    const name = row[0] ?? '';
    if ((row[column('reason')] ?? '') === '') throw new Error(`row ${name} has no reason`);
    const phase = row[column('phase')] ?? '';
    if (!/^(?:phase\s+)?[BCD](?:\s*(?:,|\/|&|\+|-|and|to)\s*[BCD])*$/i.test(phase)) {
      throw new Error(`row ${name} has phase "${phase}", expected B, C or D`);
    }
    const status = row[column('status')] ?? '';
    if (!STATUSES.includes(status)) {
      throw new Error(`row ${name} has status "${status}", expected one of ${STATUSES.join(', ')}`);
    }
    if (status === 'UNVERIFIED') {
      const id = row.map((cell) => /\bU\d+\b/.exec(cell)?.[0]).find((found) => found !== undefined);
      if (id === undefined) throw new Error(`UNVERIFIED row ${name} names no register id (U<n>)`);
      if (!registerIds.has(id))
        throw new Error(`UNVERIFIED row ${name} (${id}) has no row in open-points.md`);
    }
  }
}

function panelTable(change: (tokens: string[]) => void = () => undefined): string {
  const tokens = [...PERMISSIONS] as string[];
  change(tokens);
  return [
    '| Permission | Reason | Phase |',
    '|---|---|---|',
    ...tokens.map((token) => `| \`${token}\` | why | B |`),
  ].join('\n');
}

function graphTable(status: string, extra = ''): string {
  return [
    '| Permission or operation | Reason | Phase | Status |',
    '|---|---|---|---|',
    `| \`User.Read.All\` | Read users ${extra} | C | ${status} |`,
  ].join('\n');
}

const REGISTER = '| # | Claim |\n|---|---|\n| U7 | something |\n';

describe('docs/permissions.md (FR-A-184, TA-02)', () => {
  it('the catalogue guard fails on 14 entries, an unknown entry and a repeated entry', () => {
    expect(() => {
      assertPanelCatalogue(panelTable());
    }).not.toThrow();
    expectGuardFails(
      assertPanelCatalogue,
      panelTable((tokens) => {
        tokens.pop();
      }),
      { reason: /lacks rbac:manage/ },
    );
    expectGuardFails(
      assertPanelCatalogue,
      panelTable((tokens) => {
        tokens.push('users:write');
      }),
      { reason: /users:write, which is no panel permission/ },
    );
    expectGuardFails(
      assertPanelCatalogue,
      panelTable((tokens) => {
        tokens.push('users:read');
      }),
      { reason: /repeats a permission/ },
    );
    expectGuardFails(assertPanelCatalogue, 'no table\n', { reason: /no panel catalogue table/ });
  });

  it('the Graph table guard fails on a bad status, an empty reason, a bad phase and a missing register row', () => {
    const guard = (text: string): void => {
      assertGraphTable(text, REGISTER);
    };
    expect(() => {
      guard(graphTable('verified'));
    }).not.toThrow();
    expect(() => {
      guard(graphTable('UNVERIFIED', '(U7)'));
    }).not.toThrow();
    expectGuardFails(guard, graphTable('UNVERIFIED', '(U9)'), {
      name: 'assertGraphTable',
      reason: /\(U9\) has no row in open-points\.md/,
    });
    expectGuardFails(guard, graphTable('UNVERIFIED'), {
      name: 'assertGraphTable',
      reason: /names no register id/,
    });
    expectGuardFails(guard, readFixture('permissions-bad-status.md'), {
      name: 'assertGraphTable',
      reason: /status "probably fine"/,
    });
    expectGuardFails(guard, graphTable('verified').replace('Read users', ' '), {
      name: 'assertGraphTable',
      reason: /has no reason/,
    });
    expectGuardFails(guard, graphTable('verified').replace('| C |', '| Z |'), {
      name: 'assertGraphTable',
      reason: /phase "Z"/,
    });
    expectGuardFails(guard, 'no table\n', {
      name: 'assertGraphTable',
      reason: /no Graph and Exchange table/,
    });
  });

  it('lists exactly the 15 permissions of the catalogue', () => {
    assertPanelCatalogue(readDocument('docs/permissions.md', 'T-A-276'));
  });

  it('gives every Graph and Exchange row a reason, a phase and a status, and every UNVERIFIED row a register row', () => {
    assertGraphTable(
      readDocument('docs/permissions.md', 'T-A-276'),
      readDocument('docs/open-points.md', 'T-A-278'),
    );
  });
});

// =============================================================================================
// docs/architecture.md (FR-A-006, FR-A-103 manual part, FR-A-185)
// =============================================================================================

const MARKS = ['reuse', 'adapt', 'replace'];

/** Direct production dependencies of every workspace `package.json`, workspace links excluded. */
function productionDependencies(): string[] {
  const names = new Set<string>();
  for (const path of ['apps/server', 'apps/web', 'packages/shared', 'e2e']) {
    const manifest = JSON.parse(
      readFileSync(join(repositoryRoot, path, 'package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, string>;
    };
    for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
      if (!version.startsWith('workspace:')) names.add(name);
    }
  }
  return [...names].sort();
}

function assertArchitectureDocument(markdown: string, dependencies: readonly string[]): void {
  const table = findTable(
    markdown,
    (header) =>
      /^(dependency|package)/i.test(header[0] ?? '') &&
      header.some((cell) => /^reason/i.test(cell)) &&
      header.some((cell) => /^mark/i.test(cell)),
  );
  if (table === undefined)
    throw new Error('architecture.md has no dependency table (Dependency, Reason, Mark)');
  const reasonColumn = table.header.findIndex((cell) => /^reason/i.test(cell));
  const markColumn = table.header.findIndex((cell) => /^mark/i.test(cell));
  for (const dependency of dependencies) {
    const row = table.rows.find((candidate) => candidate[0] === dependency);
    if (row === undefined) throw new Error(`the dependency table has no row for ${dependency}`);
    if ((row[reasonColumn] ?? '') === '')
      throw new Error(`the dependency ${dependency} has no reason`);
    if (!MARKS.includes((row[markColumn] ?? '').toLowerCase())) {
      throw new Error(
        `the dependency ${dependency} has mark "${row[markColumn] ?? ''}", expected reuse, adapt or replace`,
      );
    }
  }
  const section = sectionOf(markdown, /^accessibility$/i);
  if (section === undefined) throw new Error('architecture.md has no Accessibility section');
  const text = flat(section);
  const items: [RegExp, string][] = [
    [/screen[- ]reader/i, 'the screen-reader pass'],
    [/text[- ]spacing/i, 'the text-spacing override'],
    [/colou?r[- ]only|colou?r alone|only (?:by )?colou?r/i, 'the colour-only cues'],
    [/400 ?%/, 'the zoom to 400 %'],
  ];
  for (const [pattern, what] of items) {
    if (!pattern.test(text)) throw new Error(`the Accessibility checklist lacks ${what}`);
  }
}

function dependencyTable(
  dependencies: readonly string[],
  change: (rows: string[][]) => void = () => undefined,
): string {
  const rows = dependencies.map((name) => [`\`${name}\``, 'why', 'reuse']);
  change(rows);
  return [
    '## Dependencies',
    '',
    '| Dependency | Reason | Mark |',
    '|---|---|---|',
    ...rows.map((row) => `| ${row.join(' | ')} |`),
    '',
    '## Accessibility',
    '',
    '- Screen-reader pass, before each phase gate.',
    '- Text-spacing override (WCAG 1.4.12).',
    '- Colour-only cues: none; every state has text or a shape.',
    '- Zoom to 400 % without horizontal scroll.',
  ].join('\n');
}

describe('docs/architecture.md (FR-A-006, FR-A-185)', () => {
  const sample = ['hono', 'zod', 'react'];

  it('the dependency guard fails on a missing row, an empty reason, a bad mark and a missing checklist item', () => {
    expect(() => {
      assertArchitectureDocument(dependencyTable(sample), sample);
    }).not.toThrow();
    expectGuardFails(
      (text: string) => {
        assertArchitectureDocument(text, sample);
      },
      dependencyTable(sample, (rows) => {
        rows.pop();
      }),
      { name: 'assertArchitectureDocument', reason: /no row for react/ },
    );
    expectGuardFails(
      (text: string) => {
        assertArchitectureDocument(text, sample);
      },
      dependencyTable(sample, (rows) => {
        rows[1] = ['`zod`', ' ', 'reuse'];
      }),
      { name: 'assertArchitectureDocument', reason: /zod has no reason/ },
    );
    expectGuardFails(
      (text: string) => {
        assertArchitectureDocument(text, sample);
      },
      dependencyTable(sample, (rows) => {
        rows[0] = ['`hono`', 'why', 'keep'];
      }),
      { name: 'assertArchitectureDocument', reason: /mark "keep"/ },
    );
    expectGuardFails(
      (text: string) => {
        assertArchitectureDocument(text, sample);
      },
      dependencyTable(sample).replace('Zoom to 400 %', 'Zoom'),
      { name: 'assertArchitectureDocument', reason: /zoom to 400 %/ },
    );
    expectGuardFails(
      (text: string) => {
        assertArchitectureDocument(text, sample);
      },
      dependencyTable(sample).replace('## Accessibility', '## Other'),
      { name: 'assertArchitectureDocument', reason: /no Accessibility section/ },
    );
  });

  it('reads the direct production dependencies of every package.json', () => {
    const dependencies = productionDependencies();
    expect(dependencies).toEqual(
      expect.arrayContaining(['hono', '@hono/node-server', 'sharp', 'react', 'zod']),
    );
    expect(dependencies).not.toContain('@m365portal/shared');
  });

  it('has a row for every direct production dependency, with a reason and a mark, and the Accessibility checklist', () => {
    assertArchitectureDocument(
      readDocument('docs/architecture.md', 'T-A-274'),
      productionDependencies(),
    );
  });
});

// =============================================================================================
// docs/adr (FR-A-185)
// =============================================================================================

const ADR_PHASE_A_COUNT = 56;
/** ADR-0001 to 0056 (Phase A), 0101 to 0126 (assumptions B-01 to B-26), 0151 to 0178 (PB-01 to PB-28) 0179 (Phase C, PC-02), 0180 (Phase D, ODB-01, the runtime base) and 0181 (Phase D, FR-D-102, the worker protocol and allow-list). */
const ADR_NUMBERS: readonly number[] = [
  ...Array.from({ length: ADR_PHASE_A_COUNT }, (_unused, index) => index + 1),
  ...Array.from({ length: 26 }, (_unused, index) => 101 + index),
  ...Array.from({ length: 28 }, (_unused, index) => 151 + index),
  179,
  180,
  181,
];
const ADR_COUNT = ADR_NUMBERS.length;
const ADR_FIELDS = ['Status', 'Context', 'Decision', 'Consequences', 'Evidence'];
const ADR_STATUSES = ['Accepted', 'Adjusted', 'Plan'];
const pad = (n: number, width: number): string => String(n).padStart(width, '0');

function adrFiles(): string[] {
  const directory = join(repositoryRoot, 'docs/adr');
  return existsSync(directory)
    ? readdirSync(directory)
        .filter((name) => /^\d{4}-.*\.md$/.test(name))
        .sort()
    : [];
}

/** D1 to D26 are ADR-0001 to ADR-0026; PD-01 onwards are ADR-0027 onwards (plan 6); 0055 is the TA decisions. */
function assertAdrDirectory(directory: string): void {
  if (!existsSync(directory)) throw new Error('docs/adr does not exist');
  const names = readdirSync(directory).sort();
  if (!names.includes('0000-template.md')) throw new Error('docs/adr/0000-template.md is missing');
  const numbered = names.filter((name) => /^\d{4}-.*\.md$/.test(name) && !name.startsWith('0000-'));
  if (numbered.length !== ADR_COUNT) {
    throw new Error(`docs/adr has ${String(numbered.length)} ADRs, expected ${String(ADR_COUNT)}`);
  }
  const check = (name: string, number: number): void => {
    const markdown = readFileSync(join(directory, name), 'utf8');
    const id = pad(number, 4);
    if (!new RegExp(`^# ADR-${id}: \\S`, 'm').test(markdown))
      throw new Error(`${name}: the title is not "# ADR-${id}: ..."`);
    if (number > 0 && !/^Samenvatting \(NL\): \S.*$/m.test(markdown))
      throw new Error(`${name}: no line "Samenvatting (NL): ..."`);
    for (const field of ADR_FIELDS) {
      if (!headingsOf(markdown).some((heading) => heading.level === 2 && heading.text === field)) {
        throw new Error(`${name}: no "## ${field}" section`);
      }
    }
    for (const field of ADR_FIELDS) {
      if (
        (sectionOf(markdown, new RegExp(`^${field}$`))
          ?.replace(/^.*\n/, '')
          .trim() ?? '') === ''
      ) {
        throw new Error(`${name}: the "${field}" section is empty`);
      }
    }
    if (number === 0) return;
    const status =
      (
        sectionOf(markdown, /^Status$/)
          ?.replace(/^.*\n/, '')
          .trim() ?? ''
      ).split(/[\s,.]/)[0] ?? '';
    if (!ADR_STATUSES.includes(status))
      throw new Error(`${name}: status "${status}" is not one of ${ADR_STATUSES.join(', ')}`);
    if (number <= 26 && !new RegExp(`\\bD${String(number)}\\b`).test(markdown))
      throw new Error(`${name}: does not name its decision D${String(number)}`);
    if (number >= 27 && number <= 54 && !markdown.includes(`PD-${pad(number - 26, 2)}`)) {
      throw new Error(`${name}: does not name its decision PD-${pad(number - 26, 2)}`);
    }
    if (number === 55 && !/\bTA-\d\d\b/.test(markdown))
      throw new Error(`${name}: does not name the task-level decisions (TA-nn)`);
    if (number >= 101 && number <= 126 && !markdown.includes(`B-${pad(number - 100, 2)}`))
      throw new Error(`${name}: does not name its assumption B-${pad(number - 100, 2)}`);
    if (number >= 151 && number <= 178 && !markdown.includes(`PB-${pad(number - 150, 2)}`))
      throw new Error(`${name}: does not name its decision PB-${pad(number - 150, 2)}`);
    if (number === 179 && !markdown.includes('PC-02'))
      throw new Error(`${name}: does not name its decision PC-02`);
    if (number === 180 && !markdown.includes('ODB-01'))
      throw new Error(`${name}: does not name its decision ODB-01`);
    if (number === 181 && !markdown.includes('FR-D-102'))
      throw new Error(`${name}: does not name its requirement FR-D-102`);
  };
  check('0000-template.md', 0);
  for (const number of ADR_NUMBERS) {
    const matches = numbered.filter((name) => name.startsWith(`${pad(number, 4)}-`));
    if (matches.length !== 1)
      throw new Error(
        `ADR-${pad(number, 4)}: ${String(matches.length)} files, expected exactly one`,
      );
    check(matches[0] ?? '', number);
  }
}

function adrLink(number: number): string {
  if (number >= 181) return 'FR-D-102';
  if (number >= 180) return 'ODB-01';
  if (number >= 179) return 'PC-02';
  if (number >= 151) return `PB-${pad(number - 150, 2)}`;
  if (number >= 101) return `B-${pad(number - 100, 2)}`;
  if (number >= 27) return number <= 54 ? `PD-${pad(number - 26, 2)}` : 'TA-01';
  return `D${String(number)}`;
}

function adrSample(number: number): string {
  const link = adrLink(number);
  return [
    `# ADR-${pad(number, 4)}: Title`,
    '',
    `Samenvatting (NL): een zin. ${link}`,
    '',
    '## Status',
    '',
    'Accepted',
    '',
    '## Context',
    '',
    'c',
    '',
    '## Decision',
    '',
    'd',
    '',
    '## Consequences',
    '',
    'e',
    '',
    '## Evidence',
    '',
    'v',
    '',
  ].join('\n');
}

function adrDirectory(change: (files: Map<string, string>) => void = () => undefined): string {
  const directory = mkdtempSync(join(tmpdir(), 'docs-contract-adr-'));
  scratch.push(directory);
  const files = new Map<string, string>([
    ['0000-template.md', adrSample(0).replace(/^Samenvatting.*\n/m, '')],
  ]);
  for (const number of ADR_NUMBERS) files.set(`${pad(number, 4)}-decision.md`, adrSample(number));
  change(files);
  for (const [name, text] of files) writeFileSync(join(directory, name), text);
  return directory;
}

describe('docs/adr (FR-A-185)', () => {
  it('the ADR guard fails on a missing ADR, a missing field, an empty field and a bad status', () => {
    expect(() => {
      assertAdrDirectory(adrDirectory());
    }).not.toThrow();
    expectGuardFails(
      assertAdrDirectory,
      adrDirectory((files) => {
        files.delete('0030-decision.md');
      }),
      { reason: /has 112 ADRs, expected 113/ },
    );
    expectGuardFails(
      assertAdrDirectory,
      adrDirectory((files) => {
        files.delete('0000-template.md');
      }),
      { reason: /0000-template\.md is missing/ },
    );
    expectGuardFails(
      assertAdrDirectory,
      adrDirectory((files) => {
        files.set('0007-decision.md', adrSample(7).replace('## Evidence', '## Proof'));
      }),
      { reason: /0007-decision\.md: no "## Evidence" section/ },
    );
    expectGuardFails(
      assertAdrDirectory,
      adrDirectory((files) => {
        files.set('0008-decision.md', adrSample(8).replace('\nv\n', '\n'));
      }),
      { reason: /0008-decision\.md: the "Evidence" section is empty/ },
    );
    expectGuardFails(
      assertAdrDirectory,
      adrDirectory((files) => {
        files.set('0009-decision.md', adrSample(9).replace('Accepted', 'Maybe'));
      }),
      { reason: /status "Maybe"/ },
    );
    expectGuardFails(
      assertAdrDirectory,
      adrDirectory((files) => {
        files.set('0010-decision.md', adrSample(10).replace(/^Samenvatting.*\n/m, ''));
      }),
      { reason: /no line "Samenvatting \(NL\)/ },
    );
    expectGuardFails(
      assertAdrDirectory,
      adrDirectory((files) => {
        files.set('0030-decision.md', adrSample(30).replace('PD-04', 'PD-05'));
      }),
      { reason: /does not name its decision PD-04/ },
    );
    expectGuardFails(
      assertAdrDirectory,
      adrDirectory((files) => {
        files.set('0003-decision.md', adrSample(4).replace('ADR-0004', 'ADR-0005'));
      }),
      { reason: /the title is not "# ADR-0003/ },
    );
    expectGuardFails(
      assertAdrDirectory,
      adrDirectory((files) => {
        files.delete('0004-decision.md');
        files.set('0003-other.md', adrSample(3));
      }),
      { reason: /ADR-0003: 2 files/ },
    );
  });

  it('refuses a Phase B ADR that does not name its assumption or decision (B-nn, PB-nn)', () => {
    expectGuardFails(
      assertAdrDirectory,
      adrDirectory((files) => {
        files.set('0107-decision.md', adrSample(107).replace('B-07', 'B-08'));
      }),
      { reason: /0107-decision\.md: does not name its assumption B-07/ },
    );
    expectGuardFails(
      assertAdrDirectory,
      adrDirectory((files) => {
        files.set('0155-decision.md', adrSample(155).replace('PB-05', 'PB-06'));
      }),
      { reason: /0155-decision\.md: does not name its decision PB-05/ },
    );
    expectGuardFails(
      assertAdrDirectory,
      adrDirectory((files) => {
        files.set('0179-decision.md', adrSample(179).replace('PC-02', 'PC-03'));
      }),
      { reason: /0179-decision\.md: does not name its decision PC-02/ },
    );
    expectGuardFails(
      assertAdrDirectory,
      adrDirectory((files) => {
        files.set('0180-decision.md', adrSample(180).replace('ODB-01', 'ODB-02'));
      }),
      { reason: /0180-decision\.md: does not name its decision ODB-01/ },
    );
    expectGuardFails(
      assertAdrDirectory,
      adrDirectory((files) => {
        files.set('0181-decision.md', adrSample(181).replace('FR-D-102', 'FR-D-103'));
      }),
      { reason: /0181-decision\.md: does not name its requirement FR-D-102/ },
    );
    expectGuardFails(
      assertAdrDirectory,
      adrDirectory((files) => {
        files.delete('0126-decision.md');
      }),
      { reason: /has 112 ADRs|ADR-0126: 0 files/ },
    );
  });

  it('has the template and ADR-0001 to ADR-0056, 0101 to 0126 (B-01 to B-26), 0151 to 0178 (PB-01 to PB-28) 0179 (PC-02), 0180 (ODB-01) and 0181 (FR-D-102) with their fields', () => {
    assertAdrDirectory(join(repositoryRoot, 'docs/adr'));
  });
});

// =============================================================================================
// spec, plan and tasks: Dutch summary; every MUST row enforced; route ids exist (FR-A-186)
// =============================================================================================

function assertDutchSummary(markdown: string, name: string): void {
  if (
    !headingsOf(markdown).some(
      (heading) => heading.level === 2 && heading.text === 'Samenvatting (Nederlands)',
    )
  ) {
    throw new Error(`${name} has no "## Samenvatting (Nederlands)" heading`);
  }
}

/** Every `MUST` row of a requirements table has an "Enforced by" cell that says something. */
function assertMustRowsEnforced(markdown: string): void {
  const must = (markdown.match(/^\|[^|\n]*\|\s*MUST\s*\|/gm) ?? []).length;
  let checked = 0;
  for (const table of tablesIn(markdown)) {
    const level = table.header.findIndex((cell) => cell.toLowerCase() === 'level');
    const enforced = table.header.findIndex((cell) => cell.toLowerCase() === 'enforced by');
    if (level === -1 || enforced === -1) continue;
    for (const row of table.rows) {
      if (row[level] !== 'MUST') continue;
      checked += 1;
      if (/^(|—|-|–|tbd|todo|none|n\/a)$/i.test(row[enforced] ?? '')) {
        throw new Error(`${row[0] ?? '?'} is a MUST with no enforcing control`);
      }
    }
  }
  if (checked === 0) throw new Error('no MUST row found');
  if (checked !== must)
    throw new Error(
      `${String(must - checked)} MUST row(s) sit in a table without Level and "Enforced by" columns`,
    );
}

function sourceRouteIds(): Set<string> {
  const ids = new Set<string>();
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.ts')) {
        for (const match of readFileSync(path, 'utf8').matchAll(
          /^\s*id: '([A-Za-z][A-Za-z.]*)',?\s*$/gm,
        ))
          ids.add(match[1] ?? '');
      }
    }
  };
  walk(join(repositoryRoot, 'apps/server/src'));
  return ids;
}

/** Every route id of the contract's route index is declared in the server's route table sources. */
function assertRouteIdsExist(contract: string, declared: ReadonlySet<string>): void {
  const section = sectionOf(contract, /route index/i);
  const table =
    section === undefined
      ? undefined
      : findTable(section, (header) => header.some((cell) => /route id/i.test(cell)));
  if (table === undefined) throw new Error('the contract has no route index table');
  const column = table.header.findIndex((cell) => /route id/i.test(cell));
  if (table.rawRows.length === 0) throw new Error('the route index is empty');
  for (const row of table.rawRows) {
    const id = codeTokens(row[column] ?? '')[0];
    if (id === undefined || !declared.has(id))
      throw new Error(`route id ${id ?? '?'} is not declared in the route table`);
  }
}

describe('spec, plan and tasks (FR-A-186)', () => {
  it('the Dutch-summary guard fails without the heading', () => {
    expectGuardFails(
      (text: string) => {
        assertDutchSummary(text, 'x.md');
      },
      '# X\n\n## Summary\n',
      { name: 'assertDutchSummary', reason: /no "## Samenvatting \(Nederlands\)"/ },
    );
  });

  it('the MUST guard fails on an empty cell, a placeholder and a table without the column', () => {
    const table = (cell: string, level = 'MUST'): string =>
      `| ID | Level | Requirement | Enforced by |\n|---|---|---|---|\n| FR-A-901 | ${level} | text | ${cell} |\n`;
    expect(() => {
      assertMustRowsEnforced(table('`quality`'));
    }).not.toThrow();
    expect(() => {
      assertMustRowsEnforced(table('review of the Dockerfile'));
    }).not.toThrow();
    expectGuardFails(assertMustRowsEnforced, table(' '), {
      reason: /FR-A-901 is a MUST with no enforcing control/,
    });
    expectGuardFails(assertMustRowsEnforced, table('TBD'), { reason: /no enforcing control/ });
    expectGuardFails(
      assertMustRowsEnforced,
      '| ID | Level | Requirement |\n|---|---|---|\n| FR-B-1 | MUST | text |\n',
      { reason: /without Level and "Enforced by" columns|no MUST row/ },
    );
    expectGuardFails(assertMustRowsEnforced, table('x', 'SHOULD'), { reason: /no MUST row found/ });
  });

  it('the route guard fails on an id that the route table does not declare', () => {
    const contract =
      '## 2. Route index\n\n| # | Route id | Method |\n|---|---|---|\n| R1 | `health.live` | GET |\n| R2 | `made.up` | GET |\n';
    expectGuardFails(
      (text: string) => {
        assertRouteIdsExist(text, new Set(['health.live']));
      },
      contract,
      { name: 'assertRouteIdsExist', reason: /route id made\.up is not declared/ },
    );
    expect(() => {
      assertRouteIdsExist(contract, new Set(['health.live', 'made.up']));
    }).not.toThrow();
  });

  it('spec, plan and tasks carry a Dutch summary', () => {
    for (const name of ['spec.md', 'plan.md', 'tasks.md']) {
      assertDutchSummary(readFileSync(join(specDirectory, name), 'utf8'), name);
    }
  });

  it('every MUST row of the spec names its enforcing control', () => {
    assertMustRowsEnforced(readFileSync(join(specDirectory, 'spec.md'), 'utf8'));
  });

  it('every route id of contracts/phase-a-api.md is declared in the route table', () => {
    const ids = sourceRouteIds();
    expect(ids.size).toBeGreaterThanOrEqual(20);
    assertRouteIdsExist(readFileSync(join(specDirectory, 'contracts/phase-a-api.md'), 'utf8'), ids);
  });
});

// =============================================================================================
// Phase B (T-B-420, FR-B-709, FR-B-703 doc half, FR-B-711, FR-B-713 doc, EB-30, EB-32, SC-B-017, XB35)
// =============================================================================================
//
// The guards live in fixtures/docs/phase-b.ts. Each runs on the real document and on that document
// with one required item taken out (the negatives), so the green run is evidence that the guard looks.
// The role matrix is compared with the matrix of spec 6.9.4 parsed from the spec file, not from the
// code. The documents are written by T-B-421 to T-B-428; until then the real-document tests are red
// and the failure names what is missing.

const specPhaseB = join(repositoryRoot, 'specs/002-phase-b');
const specPhaseC = join(repositoryRoot, 'specs/003-phase-c');
const specPhaseD = join(repositoryRoot, 'specs/004-phase-d');
const readPhaseB = (name: string): string => readFileSync(join(specPhaseB, name), 'utf8');

function everywhere(text: string, token: string | RegExp, replacement = ''): string {
  return typeof token === 'string'
    ? text.split(token).join(replacement)
    : text.replace(new RegExp(token.source, `${token.flags.replace('g', '')}g`), replacement);
}

/** The document without the lines that match (a table row, a sentence on its own line). */
function withoutLines(text: string, pattern: RegExp): string {
  return text
    .split('\n')
    .filter((line) => !pattern.test(line))
    .join('\n');
}

type Mutation = readonly [label: string, change: (text: string) => string, reason: RegExp];

function runNegatives(
  guard: (text: string) => void,
  real: string,
  mutations: readonly Mutation[],
): void {
  for (const [label, change, reason] of mutations) {
    const changed = change(real);
    expect(changed, `the mutation "${label}" changed nothing`).not.toBe(real);
    expectGuardFails(guard, changed, { name: label, reason });
  }
}

describe('README: the Phase B first run, in both languages (FR-B-709, US-B13)', () => {
  const real = (): string => readDocument('README.md', 'T-B-426');
  it('holds the first-run steps in order, in Dutch and in English, and no preview mode', () => {
    assertReadmePhaseB(real());
  });
  it('negatives: a missing section, command or role, a Dutch half without the steps, the old preview advice', () => {
    runNegatives(assertReadmePhaseB, real(), [
      [
        'no English first-run section',
        (t) => everywhere(t, /^#{1,4} .*first (run|start).*$/im, '### Other'),
        /first-run section/,
      ],
      ['no key command', (t) => everywhere(t, 'generate-app-key', 'gen-key'), /generate-app-key/],
      ['no docker exec', (t) => everywhere(t, 'docker exec', 'docker attach'), /docker exec/],
      [
        'no Compose secret',
        (t) => everywhere(t, 'secrets/app_key', 'secrets/key'),
        /secrets\/app_key/,
      ],
      [
        'no Privileged Role Administrator',
        (t) => everywhere(t, 'Privileged Role Administrator', 'Role Admin'),
        /Privileged Role Administrator/,
      ],
      [
        'preview mode advice back',
        (t) => `${t}\nStart with PREVIEW_MODE=true.\n`,
        /PREVIEW_MODE=true/,
      ],
      [
        'the Dutch half without the first run',
        (t) => {
          const { english, dutch } = halves(t);
          return `${english}\n${everywhere(dutch, /^#{1,4} .*(eerste (keer|start)|eerste gebruik).*$/im, '### Anders')}`;
        },
        /first-run section \(Eerste start\)/,
      ],
    ]);
  });
});

describe('docs/operations.md: Phase B content and the limits sentences (FR-B-703, FR-B-704, EB-11, EB-30, EB-32, B-26)', () => {
  const real = (): string => readDocument('docs/operations.md', 'T-B-422');
  it('holds the key, certificate, token, break-glass, proxy, compromise and outbound sections in both languages', () => {
    assertOperationsPhaseB(real());
  });
  it('negatives: each required sentence or section taken out fails', () => {
    runNegatives(assertOperationsPhaseB, real(), [
      [
        'the no-larger-request sentence',
        (t) => everywhere(t, /Phase B adds no larger/i, 'Phase B adds a larger'),
        /no larger/,
      ],
      [
        'the break-glass proxy restriction',
        (t) => everywhere(t, '/api/v1/auth/break-glass', '/api/v1/auth/x'),
        /break-glass by address/,
      ],
      [
        'sovereign clouds',
        (t) => everywhere(everywhere(t, /sovereign/gi, 'special'), /national cloud/gi, 'special'),
        /sovereign clouds/,
      ],
      ['the pre-rotate copies', (t) => everywhere(t, 'pre-rotate-', 'rotate-old-'), /pre-rotate/],
      [
        'the NODE_USE_ENV_PROXY hint',
        (t) => everywhere(t, 'NODE_USE_ENV_PROXY', 'NODE_PROXY'),
        /NODE_USE_ENV_PROXY/,
      ],
      [
        'the outbound host outlook.office365.com',
        (t) => everywhere(t, /outlook\.office365\.com/, 'example.com'),
        /outlook\.office365\.com/,
      ],
      [
        'the 14-character floor',
        (t) => everywhere(t, /14 characters/gi, '8 characters'),
        /14-character floor/,
      ],
      ['the Dutch half', (t) => everywhere(t, /certificaat/gi, 'cert'), /het certificaat/],
    ]);
  });
});

describe('docs/security.md: the Phase B tables, the attack review and the accepted risks (FR-B-709, AM-16, RB-05 to RB-09)', () => {
  const real = (): string => readDocument('docs/security.md', 'T-B-423');
  it('holds the STRIDE rows of the eight surfaces, ASVS V2 V3 V4 V6 V7 V8 V13, 25 attack-review rows and the accepted risks', () => {
    assertSecurityPhaseB(real());
  });
  it('negatives: a missing STRIDE row, ASVS row, attack-review row or topic fails', () => {
    runNegatives(assertSecurityPhaseB, real(), [
      [
        'no Break-glass STRIDE row',
        (t) => withoutLines(t, /^\|\s*Break-glass\s*\|/),
        /no row "Break-glass"/,
      ],
      ['no ASVS V13 row', (t) => withoutLines(t, /^\|\s*V13\b/), /ASVS level 2 table/],
      [
        'no row 25 of the attack review',
        (t) => withoutLines(t, /^\|\s*25\s*\|/),
        /has 24 rows, plan 16\.1 has 25/,
      ],
      ['no DNS rebinding', (t) => everywhere(t, /DNS rebinding/gi, 'rebind'), /DNS rebinding/],
      ['no accepted risk RB-17', (t) => everywhere(t, 'RB-17', 'RB-xx'), /RB-17/],
      [
        'no docker inspect',
        (t) => everywhere(t, 'docker inspect', 'docker info'),
        /docker inspect/,
      ],
      ['no ODB-17', (t) => everywhere(t, 'ODB-17', 'ODB-xx'), /ODB-17/],
      ['no Dutch Phase B', (t) => everywhere(t, /fase b/gi, 'fase x'), /Fase B/],
    ]);
  });
});

describe('docs/permissions.md: the role matrix equals spec 6.9.4 (FR-B-301, FR-B-502, B-01)', () => {
  const real = (): string => readDocument('docs/permissions.md', 'T-B-421');
  const spec = (): string => readPhaseB('spec.md');
  const guard = (text: string): void => {
    assertPermissionsPhaseB(text, spec());
  };

  it('holds the 15-permission matrix, the four Graph roles with their ids, both Exchange templates and the delegated scopes', () => {
    guard(real());
  });
  it('negatives: a flipped cell, a changed Bestuur mark, a missing id or template, a missing scope fails', () => {
    const flip = (permission: string, from: string, to: string) => (text: string) =>
      text
        .split('\n')
        .map((line) =>
          line.includes(`\`${permission}\``) && /\|\s*x\s*\|/.test(line) && line.includes(from)
            ? line.replace(/\|\s*x\s*\|/, `| ${to} |`)
            : line,
        )
        .join('\n');
    runNegatives(guard, real(), [
      ['rbac:manage not held by Eigenaar', flip('rbac:manage', '', ''), /rbac:manage for Eigenaar/],
      [
        'a template id missing',
        (t) => everywhere(t, '31392ffb-586c-42d1-9346-e59415a2cc4e', ''),
        /exchange_recipient_administrator/,
      ],
      [
        'a role id missing',
        (t) => everywhere(t, 'dbaae8cf-10b5-4b86-a4a1-f871c94c6695', ''),
        /GroupMember\.ReadWrite\.All/,
      ],
      [
        'a delegated scope missing',
        (t) => everywhere(t, 'AppRoleAssignment.ReadWrite.All', 'X'),
        /AppRoleAssignment\.ReadWrite\.All/,
      ],
      [
        'EXCHANGE_ROLES missing',
        (t) => everywhere(t, 'EXCHANGE_ROLES', 'EXCHANGE_ROLE_TABLE'),
        /EXCHANGE_ROLES/,
      ],
      [
        'a permission row missing',
        (t) => withoutLines(t, /^\|\s*`contacts:delete`/),
        /contacts:delete|has 14 rows/,
      ],
    ]);
  });
  it('the matrix totals of the spec are 15, 13, 9, 6, 4 and 5', () => {
    expect(() => {
      guard(real());
    }).not.toThrow();
  });
});

describe('docs/architecture.md: layering, modules, dependencies and the rule for Phases C and D (FR-B-709, FR-B-711, PB-01)', () => {
  const real = (): string => readDocument('docs/architecture.md', 'T-B-424');
  it('lists the six Phase B dependencies with a reason and a mark, the layering and the capability rule', () => {
    assertArchitecturePhaseB(real());
  });
  it('negatives: a missing dependency row, the fetch-only rule or the capability argument fails', () => {
    runNegatives(assertArchitecturePhaseB, real(), [
      ['no jose row', (t) => withoutLines(t, /^\|\s*`jose`/), /no row for jose/],
      ['no msw row', (t) => withoutLines(t, /^\|\s*`msw`/), /no row for msw/],
      [
        'no AuthorizedResource',
        (t) => everywhere(t, 'AuthorizedResource', 'Resource'),
        /AuthorizedResource/,
      ],
      ['no jsonwebtoken note', (t) => everywhere(t, 'jsonwebtoken', 'jwt-library'), /jsonwebtoken/],
      [
        'no integrations boundary',
        (t) => everywhere(t, 'integrations', 'clients'),
        /integrations boundary/,
      ],
    ]);
  });
});

describe('docs/adr: ADR-0102 and the blocks 0101 to 0126 and 0151 to 0178 (FR-B-709, AM-22)', () => {
  it("ADR-0102 records the interface-only decision for the Exchange write path and says it is updated with the owner's choice", () => {
    assertAdr0102(join(repositoryRoot, 'docs/adr'));
  });
  it('negative: an ADR-0102 without the owner decision fails', () => {
    const directory = adrDirectory((files) => {
      files.set('0102-decision.md', adrSample(102));
    });
    expectGuardFails(assertAdr0102, directory, { reason: /ADR-0102 must record/ });
  });
});

describe('docs/open-points.md: every open point, assumption, risk and UNVERIFIED item of Phase B (T-B-425, SC-B-017)', () => {
  const real = (): string => readDocument('docs/open-points.md', 'T-B-425');
  it('holds U34 to U50, the updates, OV-01 to OV-23, B-01 to B-26, PB-01 to PB-28, RB-01 to RB-18, PBR-01 to PBR-14, ODB-01 to ODB-18 and the decisions taken', () => {
    assertOpenPointsPhaseB(real());
  });
  it('negatives: a missing register row, ledger item or decision fails', () => {
    runNegatives(assertOpenPointsPhaseB, real(), [
      ['no U40', (t) => withoutLines(t, /^\|\s*U40\s*\|/), /the register row U40|U40/],
      ['no OV-19', (t) => withoutLines(t, /^\|\s*OV-19\s*\|/), /OV-19/],
      ['no ODB-17', (t) => withoutLines(t, /^\|\s*ODB-17\s*\|/), /ODB-17/],
      ['no RB-17', (t) => withoutLines(t, /^\|\s*RB-17\s*\|/), /RB-17/],
      ['no step-up decision', (t) => everywhere(t, 'amr_missing', 'x'), /step-up without MFA/],
    ]);
  });
  it('every UNVERIFIED row of permissions.md has a register row here', () => {
    assertGraphTable(readDocument('docs/permissions.md', 'T-B-421'), real());
  });
});

describe('the contract file, the route table and the negative controls (FR-B-709, plan 14.6)', () => {
  const contract = (): string => readPhaseB('contracts/phase-b-api.md');

  it('every route id of contracts/phase-b-api.md is declared in the route table sources', () => {
    const ids = sourceRouteIds();
    assertRouteIdsExist(contract(), ids);
  });

  it('the contract and the route table of the running application agree in both directions', async () => {
    const server = await startWizardServer({
      env: {
        BREAK_GLASS_USERNAME: 'operator',
        BREAK_GLASS_PASSWORD_HASH: `scrypt:16384:8:1:${Buffer.alloc(16, 3).toString('base64url')}:${Buffer.alloc(32, 5).toString('base64url')}`,
      },
    });
    const document = await readJson<{
      paths: Record<string, Record<string, { 'x-route-id'?: string }>>;
    }>(await server.client().get('/api/v1/openapi.json'));
    const documented = Object.values(document.paths).flatMap((methods) =>
      Object.values(methods).map((operation) => operation['x-route-id'] ?? ''),
    );
    const input = {
      documented,
      phaseA: contractRouteIds(
        readFileSync(join(specDirectory, 'contracts/phase-a-api.md'), 'utf8'),
      ),
      phaseB: contractRouteIds(contract()),
      // Phase C has no contract file: its route index is table 6.7.1 of the spec (T-C-024).
      phaseC: contractRouteIds(readFileSync(join(specPhaseC, 'spec.md'), 'utf8')),
      // Phase D step D1: table 6.11.1 of the spec, P40 to P54 without P46 (the export preview is step D2).
      phaseD1: [
        ...readFileSync(join(specPhaseD, 'spec.md'), 'utf8').matchAll(
          /^\| P(\d+) \| `([a-z][a-zA-Z0-9.]*)` \|/gm,
        ),
      ]
        .filter((m) => Number(m[1]) >= 40 && Number(m[1]) <= 54 && m[1] !== '46')
        .map((m) => m[2] ?? ''),
    };
    expect(input.phaseB).toHaveLength(32);
    expect(input.phaseC).toEqual([
      'users.list',
      'users.get',
      'users.groups',
      'groups.list',
      'groups.get',
      'groups.owners',
      'groups.members',
    ]);
    expect(input.phaseD1).toEqual([
      'distributionlists.list',
      'distributionlists.get',
      'distributionlists.members',
      'distributionlists.members.add',
      'distributionlists.members.remove',
      'distributionlists.search',
      'contacts.list',
      'contacts.get',
      'contacts.create',
      'contacts.update',
      'contacts.delete',
      'contacts.memberships',
      'groups.members.add',
      'groups.members.remove',
    ]);
    expect(() => {
      assertRoutesMatchContract(input);
    }).not.toThrow();
    expectGuardFails(
      assertRoutesMatchContract,
      { ...input, phaseD1: input.phaseD1.filter((id) => id !== 'contacts.delete') },
      { reason: /contacts\.delete, which no contract lists/ },
    );
    expectGuardFails(
      assertRoutesMatchContract,
      { ...input, phaseD1: [...input.phaseD1, 'contacts.merge'] },
      { reason: /contacts\.merge, which is not in the route table/ },
    );
    expectGuardFails(
      assertRoutesMatchContract,
      { ...input, documented: [...documented, 'made.up.route'] },
      { reason: /made\.up\.route, which no contract lists/ },
    );
    expectGuardFails(
      assertRoutesMatchContract,
      { ...input, phaseB: [...input.phaseB, 'nowhere.listed'] },
      { reason: /nowhere\.listed, which is not in the route table/ },
    );
    expectGuardFails(
      assertRoutesMatchContract,
      { ...input, phaseC: [...input.phaseC, 'users.create'] },
      { reason: /users\.create, which is not in the route table/ },
    );
    expectGuardFails(
      assertRoutesMatchContract,
      { ...input, phaseC: input.phaseC.filter((id) => id !== 'groups.members') },
      { reason: /groups\.members, which no contract lists/ },
    );
  });

  it('the negative-control table of plan 14.6 names paths that exist', () => {
    assertNegativeControlTable(readPhaseB('plan.md'), repositoryRoot);
    expectGuardFails(
      (plan: string) => {
        assertNegativeControlTable(plan, repositoryRoot);
      },
      readPhaseB('plan.md').replace('server/route-table.test.ts', 'server/no-such-test.test.ts'),
      { reason: /server\/no-such-test\.test\.ts does not exist/ },
    );
  });
});

// =============================================================================================
// Phase C documents (FR-C-603, T-C-066 to T-C-068): permissions, API reference, owner test sheet
// =============================================================================================
// The guards read the documents as written: each names the item that is missing. The owner test sheet
// must list every check of the ledger (spec 8.4) and every open claim they close, in both languages.

const PHASE_C_ROUTE_IDS = [
  'users.list',
  'users.get',
  'users.groups',
  'groups.list',
  'groups.get',
  'groups.owners',
  'groups.members',
] as const;

function assertPhaseCPermissions(markdown: string): void {
  const { english, dutch } = halves(markdown);
  for (const [label, text] of [
    ['English', english],
    ['Dutch', dutch],
  ] as const) {
    for (const id of PHASE_C_ROUTE_IDS) {
      if (!text.includes(`\`${id}\``))
        throw new Error(`permissions.md (${label}): Phase C route ${id} is not listed`);
    }
    if (
      !/GroupMember\.ReadWrite\.All[\s\S]{0,160}?(granted, unused|verleend, ongebruikt)/i.test(text)
    )
      throw new Error(
        `permissions.md (${label}): GroupMember.ReadWrite.All is not "granted, unused"`,
      );
    if (!text.includes('U17') || !/licen[cst]/i.test(text))
      throw new Error(`permissions.md (${label}): the deferred licence list (U17) is missing`);
    if (!text.includes('U66'))
      throw new Error(`permissions.md (${label}): the manager claim U66 is missing`);
  }
}

function assertApiReference(markdown: string): void {
  for (const id of PHASE_C_ROUTE_IDS) {
    if (!markdown.includes(`\`${id}\``)) throw new Error(`api.md: route ${id} is not described`);
  }
  for (const needle of [
    'cursor_invalid',
    'filter_not_allowed',
    'not_available',
    'hidden',
    'restricted',
  ]) {
    if (!markdown.includes(needle)) throw new Error(`api.md: "${needle}" is not described`);
  }
  halves(markdown);
}

function assertOwnerTestSheet(markdown: string): void {
  const { english, dutch } = halves(markdown);
  for (const [label, text] of [
    ['English', english],
    ['Dutch', dutch],
  ] as const) {
    for (let number = 1; number <= 6; number += 1) {
      if (!text.includes(`OV-C${String(number)}`))
        throw new Error(`owner-test-phase-c.md (${label}): OV-C${String(number)} is missing`);
    }
    for (let number = 66; number <= 74; number += 1) {
      if (!new RegExp(`\\bU${String(number)}\\b`).test(text))
        throw new Error(`owner-test-phase-c.md (${label}): U${String(number)} is missing`);
    }
  }
}

describe('Phase C documents (FR-C-603)', () => {
  it('docs/permissions.md lists the seven routes, GroupMember.ReadWrite.All as granted and unused, and the deferred licences, in both languages', () => {
    const real = readDocument('docs/permissions.md', 'T-C-066');
    assertPhaseCPermissions(real);
    runNegatives(assertPhaseCPermissions, real, [
      [
        'a route missing',
        (t) => everywhere(t, '`groups.owners`', '`groups.other`'),
        /Phase C route groups\.owners is not listed/,
      ],
      [
        'the write role no longer unused',
        (t) => everywhere(t, /granted, unused/i, 'used'),
        /not "granted, unused"/,
      ],
    ]);
  });

  it('docs/api.md describes the seven routes, the cursor, the basic-actor filter refusal and the states', () => {
    const real = readDocument('docs/api.md', 'T-C-067');
    assertApiReference(real);
    expectGuardFails(assertApiReference, everywhere(real, '`users.groups`'), {
      name: 'a route not described',
      reason: /route users\.groups is not described/,
    });
    expectGuardFails(assertApiReference, everywhere(real, 'filter_not_allowed'), {
      name: 'the filter refusal not described',
      reason: /"filter_not_allowed" is not described/,
    });
  });

  it('docs/owner-test-phase-c.md lists OV-C1 to OV-C6 and U66 to U74 in English and in Dutch', () => {
    const real = readDocument('docs/owner-test-phase-c.md', 'T-C-068');
    assertOwnerTestSheet(real);
    expectGuardFails(assertOwnerTestSheet, everywhere(real, 'OV-C3'), {
      name: 'a check missing',
      reason: /OV-C3 is missing/,
    });
    expectGuardFails(assertOwnerTestSheet, everywhere(real, /\bU71\b/), {
      name: 'a claim missing',
      reason: /U71 is missing/,
    });
  });

  it('the README names the new documents in both languages', () => {
    const { english, dutch } = halves(readDocument('README.md', 'T-C-067'));
    for (const text of [english, dutch]) {
      expect(text).toContain('docs/api.md');
      expect(text).toContain('docs/owner-test-phase-c.md');
    }
  });
});

// =============================================================================================
// Phase D step D1 documents (FR-D-807, T-D-190 to T-D-192)
// =============================================================================================
// The same shape as the Phase C guards: each guard names the item that is missing, and a negative
// takes that item out. What these documents may NOT do is claim more than the gate notes say, so the
// credential source (FD-01) must read "decided, in progress" and the approval line must stay empty.

const PHASE_D1_ROUTE_IDS = [
  'distributionlists.list',
  'distributionlists.get',
  'distributionlists.members',
  'distributionlists.members.add',
  'distributionlists.members.remove',
  'distributionlists.search',
  'contacts.list',
  'contacts.get',
  'contacts.create',
  'contacts.update',
  'contacts.delete',
  'contacts.memberships',
  'groups.members.add',
  'groups.members.remove',
] as const;

const PHASE_D1_CMDLETS = [
  'Get-DistributionGroup',
  'Get-DistributionGroupMember',
  'Add-DistributionGroupMember',
  'Remove-DistributionGroupMember',
  'Get-MailContact',
  'New-MailContact',
  'Set-MailContact',
  'Remove-MailContact',
  'Get-Recipient',
  'Get-OrganizationConfig',
] as const;

/** The U-numbers the owner sheet of step D1 must name in each language. */
const PHASE_D1_CLAIMS = [
  75, 76, 77, 78, 79, 80, 82, 83, 84, 85, 89, 90, 92, 93, 94, 95, 96, 97, 98, 99, 100,
] as const;

function assertPhaseD1Api(markdown: string): void {
  for (const id of PHASE_D1_ROUTE_IDS) {
    if (!markdown.includes(`\`${id}\``)) throw new Error(`api.md: route ${id} is not described`);
  }
  const { english, dutch } = halves(markdown);
  for (const [label, text] of [
    ['English', english],
    ['Dutch', dutch],
  ] as const) {
    for (const needle of [
      'narrow_search',
      'read_only_object',
      'conflict',
      'exchange_unavailable',
      'exchange_throttled',
      'exchange_permission_missing',
      'step_up_required',
      'readBackPending',
      '/$ref',
    ]) {
      if (!text.includes(needle))
        throw new Error(`api.md (${label}): "${needle}" is not described`);
    }
  }
}

function assertPhaseD1Permissions(markdown: string): void {
  const { english, dutch } = halves(markdown);
  for (const [label, text, heading, used] of [
    ['English', english, /^Part 5:/, /GroupMember\.ReadWrite\.All[^\n]{0,400}?\*\*Used\*\*/],
    ['Dutch', dutch, /^Deel 5:/, /GroupMember\.ReadWrite\.All[^\n]{0,400}?\*\*Gebruikt\*\*/],
  ] as const) {
    const part = sectionOf(text, heading);
    if (part === undefined) throw new Error(`permissions.md (${label}): Part 5 is missing`);
    if (!used.test(part))
      throw new Error(
        `permissions.md (${label}): Part 5 does not say that GroupMember.ReadWrite.All is used`,
      );
    for (const needle of ['Exchange.ManageAsApp', 'Confirm', 'U96']) {
      if (!part.includes(needle))
        throw new Error(`permissions.md (${label}): Part 5 does not name ${needle}`);
    }
    for (const cmdlet of PHASE_D1_CMDLETS) {
      if (!part.includes(cmdlet))
        throw new Error(`permissions.md (${label}): Part 5 does not list the cmdlet ${cmdlet}`);
    }
  }
}

function assertOwnerTestSheetD1(markdown: string): void {
  const { english, dutch } = halves(markdown);
  for (const [label, text, report, ceiling] of [
    ['English', english, /What to report back/, /image size ceiling/i],
    ['Dutch', dutch, /Wat je terugmeldt/, /plafond voor de grootte van de image/i],
  ] as const) {
    for (const id of ['OV-D1', 'OV-D2', 'OV-D4', 'OV-D5']) {
      if (!text.includes(id))
        throw new Error(`owner-test-phase-d1.md (${label}): ${id} is missing`);
    }
    for (const number of PHASE_D1_CLAIMS) {
      if (!new RegExp(`\\bU${String(number)}\\b`).test(text))
        throw new Error(`owner-test-phase-d1.md (${label}): U${String(number)} is missing`);
    }
    if (!report.test(text))
      throw new Error(`owner-test-phase-d1.md (${label}): the report-back section is missing`);
    if (!ceiling.test(text))
      throw new Error(`owner-test-phase-d1.md (${label}): the image size decision is missing`);
  }
  // One result field per item: a row of the English table for each of the four items and the decision.
  for (const id of ['OV-D1', 'OV-D2', 'OV-D4', 'OV-D5']) {
    if (!new RegExp(`^\\| ${id} \\([^)]*\\) \\| +\\|`, 'm').test(english))
      throw new Error(`owner-test-phase-d1.md (English): ${id} has no result row`);
  }
}

function assertOpenPointsPhaseD1(markdown: string): void {
  const row = (id: string): RegExp => new RegExp(`^\\|\\s*${id}\\s*\\|\\s*\\S`, 'm');
  for (let number = 75; number <= 100; number += 1) {
    if (!row(`U${String(number)}`).test(markdown))
      throw new Error(`open-points.md: the register row U${String(number)} is missing`);
  }
  for (let number = 1; number <= 9; number += 1) {
    if (!row(`OV-D${String(number)}`).test(markdown))
      throw new Error(`open-points.md: the ledger row OV-D${String(number)} is missing`);
  }
  for (const id of ['ODD-09', 'ODD-10', 'ODD-11', 'AD-01', 'AD-05', 'RD-01', 'RD-09']) {
    if (!row(id).test(markdown)) throw new Error(`open-points.md: the row ${id} is missing`);
  }
  for (let number = 1; number <= 22; number += 1) {
    const id = `FD-${String(number).padStart(2, '0')}`;
    if (!row(id).test(markdown)) throw new Error(`open-points.md: the finding ${id} is missing`);
  }
  const credential = /^\|\s*FD-01\s*\|.*$/m.exec(markdown)?.[0] ?? '';
  if (!/in progress/i.test(credential) || !/PEM/.test(credential))
    throw new Error(
      'open-points.md: FD-01 must say that the PEM credential source is decided and in progress',
    );
}

function assertPhaseReportD1(markdown: string): void {
  if (!/pending/i.test(markdown)) throw new Error('phase-D1.md: CI results must be marked pending');
  const lines = markdown.split('\n').filter((line) => line.trim() !== '');
  const last = lines[lines.length - 1] ?? '';
  const question = lines[lines.length - 2] ?? '';
  if (last !== 'Naam en datum / Name and date:')
    throw new Error(`phase-D1.md: the approval line must stay empty, found "${last}"`);
  if (!question.startsWith('Akkoord om door te gaan met stap D2'))
    throw new Error('phase-D1.md: the question about step D2 is missing before the approval line');
}

describe('Phase D step D1 documents (FR-D-807)', () => {
  it('docs/api.md describes the fourteen routes, the problem codes, the read-back and the /$ref guard, in both languages', () => {
    const real = readDocument('docs/api.md', 'T-D-190');
    assertPhaseD1Api(real);
    expectGuardFails(assertPhaseD1Api, everywhere(real, '`contacts.memberships`'), {
      name: 'a route not described',
      reason: /route contacts\.memberships is not described/,
    });
    expectGuardFails(assertPhaseD1Api, everywhere(real, 'readBackPending'), {
      name: 'the read-back flag not described',
      reason: /"readBackPending" is not described/,
    });
  });

  it('docs/permissions.md Part 5 and Deel 5 say that GroupMember.ReadWrite.All is used and list the ten cmdlets; the Phase C statement stays', () => {
    const real = readDocument('docs/permissions.md', 'T-D-190');
    assertPhaseD1Permissions(real);
    assertPhaseCPermissions(real);
    runNegatives(assertPhaseD1Permissions, real, [
      [
        'a cmdlet missing',
        (t) => everywhere(t, 'Remove-MailContact', 'Remove-Other'),
        /does not list the cmdlet Remove-MailContact/,
      ],
      [
        'the write role no longer used',
        (t) => everywhere(t, '**Used**', 'x'),
        /does not say that GroupMember\.ReadWrite\.All is used/,
      ],
    ]);
  });

  it('docs/owner-test-phase-d1.md has OV-D1, OV-D2, OV-D4, OV-D5, their claims, a result row each and the image size decision, in English and in Dutch', () => {
    const real = readDocument('docs/owner-test-phase-d1.md', 'T-D-192');
    assertOwnerTestSheetD1(real);
    expectGuardFails(assertOwnerTestSheetD1, everywhere(real, 'OV-D4'), {
      name: 'a check missing',
      reason: /OV-D4 is missing/,
    });
    expectGuardFails(assertOwnerTestSheetD1, everywhere(real, /\bU97\b/), {
      name: 'a claim missing',
      reason: /U97 is missing/,
    });
    expectGuardFails(assertOwnerTestSheetD1, everywhere(real, /\| OV-D5 \([^)]*\) \| /, '| x | '), {
      name: 'a result row missing',
      reason: /OV-D5 has no result row/,
    });
  });

  it('docs/open-points.md has U75 to U100, OV-D1 to OV-D9, the D1 decisions, assumptions, risks and findings, and says the credential source is decided and in progress', () => {
    const real = readDocument('docs/open-points.md', 'T-D-191');
    assertOpenPointsPhaseD1(real);
    runNegatives(assertOpenPointsPhaseD1, real, [
      ['no U97', (t) => withoutLines(t, /^\|\s*U97\s*\|/), /register row U97/],
      ['no OV-D4', (t) => withoutLines(t, /^\|\s*OV-D4\s*\|/), /ledger row OV-D4/],
      ['no ODD-10', (t) => withoutLines(t, /^\|\s*ODD-10\s*\|/), /row ODD-10/],
      ['no FD-07', (t) => withoutLines(t, /^\|\s*FD-07\s*\|/), /finding FD-07/],
      [
        'the credential source no longer in progress',
        (t) => t.replace(/^\|\s*FD-01\s*\|.*$/m, (line) => line.replace(/in progress/gi, 'done')),
        /FD-01 must say/,
      ],
    ]);
  });

  it('the phase report of step D1 marks CI as pending and keeps the approval line empty', () => {
    const real = readDocument('docs/phase-reports/phase-D1.md', 'T-D-192');
    assertPhaseReportD1(real);
    expectGuardFails(assertPhaseReportD1, `${real.trimEnd()} Helmer, 2026-10-14\n`, {
      name: 'a filled-in approval line',
      reason: /the approval line must stay empty/,
    });
    expectGuardFails(assertPhaseReportD1, everywhere(real, /pending/gi, 'done'), {
      name: 'CI no longer pending',
      reason: /CI results must be marked pending/,
    });
  });

  it('operations.md names the worker, the variable, the image size decision and the stack-manager note in both languages; the README names the new documents', () => {
    const { english, dutch } = halves(readDocument('docs/operations.md', 'T-D-190'));
    for (const text of [english, dutch]) {
      for (const needle of [
        'EXCHANGE_KEY_HANDOVER',
        'Image size budget',
        'Dockhand',
        '/run/secrets/app_key',
        'ADR-0181',
      ]) {
        expect(text).toContain(needle);
      }
    }
    for (const text of Object.values(halves(readDocument('README.md', 'T-D-190')))) {
      expect(text).toContain('docs/owner-test-phase-d1.md');
      expect(text).toContain('docs/phase-reports/phase-D1.md');
    }
  });
});
