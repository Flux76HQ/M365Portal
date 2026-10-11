// T-A-230 and T-A-232: the deployment files (FR-A-011, FR-A-016, FR-A-164, FR-A-166; TA-06).
//
//   part 1  `.env.example` and `.dockerignore` (T-A-230)
//   part 2  `docker-compose.yml` (T-A-232), appended below
//
// What is asserted, and how it is proven to bite (tasks.md section 0.3): every rule below is a
// guard, a function that THROWS when its input breaks the rule. The real file must pass it, and a
// deliberately wrong fixture must fail it with the reason that belongs to the rule
// (`expectGuardFails`). A parity check nobody has seen fail is an assumption.
//
// The parity source is the variable list exported by the configuration (`ENV_VARIABLES`), the one
// list the schema is built from. Nothing here re-types a variable name that the schema owns, except
// `HOST_PORT`, which is deliberately not in the schema: it is read by Compose only (FR-A-016).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT, LIMITS } from '@m365portal/shared/limits';
import { expectGuardFails } from '@m365portal/shared/testing';
import { afterAll, describe, expect, it } from 'vitest';
import { ENV_VARIABLES } from '../src/config/index.js';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));

function readRepositoryFile(path: string): string {
  return readFileSync(join(repositoryRoot, path), 'utf8');
}

/** Text of `source` with `search` replaced by `replacement`; throws when the fixture misses. */
function replaceOnce(source: string, search: string | RegExp, replacement: string): string {
  const result = source.replace(search, replacement);
  if (result === source) throw new Error(`fixture error: ${String(search)} does not occur`);
  return result;
}

/** Text of `source` without the lines for which `drop` answers true. */
function dropLines(source: string, drop: (line: string) => boolean): string {
  const lines = source.split('\n');
  const kept = lines.filter((line) => !drop(line));
  if (kept.length === lines.length) throw new Error('fixture error: no line was dropped');
  return kept.join('\n');
}

const scratch: string[] = [];
afterAll(() => {
  for (const path of scratch) rmSync(path, { recursive: true, force: true });
});

function scratchDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(path);
  return path;
}

// ---------------------------------------------------------------------------------------------
// Part 1a: `.env.example` (FR-A-011, FR-A-016, TA-06)
// ---------------------------------------------------------------------------------------------
//
// The format of the file, which this parser is the definition of:
//   NAME=value        an active assignment, no quotes, no spaces, no inline comment
//   #NAME=value       a variable that is deliberately left unset (no space after the hash)
//   # prose           a comment; it must not look like an assignment (`# NAME=value` is refused,
//                     because neither a reader nor a parser could tell which one it is)
//   (empty line)

/** The Compose-only variable: the port published on the Docker host (FR-A-016). */
const COMPOSE_ONLY = 'HOST_PORT';
/** The one variable that is shown unset on purpose; see `assertEnvExampleParity`. */
const DERIVED_VARIABLE = 'PUBLIC_BASE_URL';

interface SchemaVariable {
  readonly name: string;
  readonly defaultText: string;
}

interface EnvEntry {
  readonly name: string;
  readonly value: string;
  readonly active: boolean;
  readonly line: number;
  /** The prose lines directly above the entry (no blank line in between). */
  readonly comment: readonly string[];
}

interface ParsedEnvExample {
  readonly entries: readonly EnvEntry[];
  /** The first paragraph: the prose lines at the top of the file, up to the first blank line. */
  readonly header: readonly string[];
}

const ACTIVE_ASSIGNMENT = /^([A-Z][A-Z0-9_]*)=(.*)$/;
const UNSET_ASSIGNMENT = /^#([A-Z][A-Z0-9_]*)=(.*)$/;
const AMBIGUOUS_COMMENT = /^#\s+[A-Z][A-Z0-9_]*=/;

function parseEnvExample(text: string): ParsedEnvExample {
  const entries: EnvEntry[] = [];
  const header: string[] = [];
  let comment: string[] = [];
  let inHeader = true;

  text.split('\n').forEach((raw, index) => {
    const line = index + 1;
    if (raw.trim() === '') {
      comment = [];
      inHeader = false;
      return;
    }
    const active = ACTIVE_ASSIGNMENT.exec(raw);
    const unset = UNSET_ASSIGNMENT.exec(raw);
    const assignment = active ?? unset;
    if (assignment !== null) {
      const [, name = '', value = ''] = assignment;
      entries.push({ name, value, active: active !== null, line, comment });
      comment = [];
      inHeader = false;
      return;
    }
    if (!raw.startsWith('#')) {
      throw new Error(`.env.example line ${String(line)} is neither a variable nor a comment`);
    }
    if (AMBIGUOUS_COMMENT.test(raw)) {
      throw new Error(
        `.env.example line ${String(line)} looks like a commented-out variable with a space after "#": write #NAME=value, or reword the comment`,
      );
    }
    comment.push(raw);
    if (inHeader) header.push(raw);
  });

  return { entries, header };
}

/** A value that could be a credential, whatever the variable is called. */
function looksLikeSecretValue(value: string): boolean {
  return (
    /-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)/.test(value) ||
    /^eyJ[\w-]+\.[\w-]+\.[\w-]*$/.test(value) ||
    /^(?:ghp|gho|ghs|ghu|github_pat)_[\w]+$/.test(value) ||
    /^(?:sk|pk|xox[a-z])-[\w-]{10,}$/.test(value) ||
    /^AKIA[0-9A-Z]{12,}$/.test(value) ||
    /^[A-Za-z0-9+=_-]{32,}$/.test(value)
  );
}

const SECRET_NAME = /SECRET|PASSWORD|PASSPHRASE|TOKEN|PRIVATE|CERT|CREDENTIAL|API_?KEY|APP_?KEY/;

/** A placeholder is empty or written in angle brackets, never a value that could be real. */
function isPlaceholder(value: string): boolean {
  return value === '' || /^<[^<>\s]+>$/.test(value);
}

interface EnvExampleInput {
  readonly text: string;
  readonly schema: readonly SchemaVariable[];
}

/**
 * The rules of FR-A-011, FR-A-016 and TA-06 for `.env.example`. Throws on the first violation.
 *
 * - Exactly the variables of the schema plus `HOST_PORT`, each once.
 * - `HOST_PORT` is named as Compose-only in the header and again above the variable, and the text
 *   says that the application does not read it.
 * - Every value is the schema default or a placeholder. A name that sounds like a secret may only
 *   hold a placeholder, and no value anywhere may look like a credential.
 * - `PUBLIC_BASE_URL` is the one variable left unset, because the Compose file derives it from
 *   `HOST_PORT`: an active line here would silently break a change of `HOST_PORT` alone (every
 *   write would be refused by the origin check, A-31). All others are active, so a parser that
 *   reads active lines only still sees them.
 */
function assertEnvExampleParity({ text, schema }: EnvExampleInput): void {
  const { entries, header } = parseEnvExample(text);

  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.name)) {
      throw new Error(`.env.example lists ${entry.name} twice (line ${String(entry.line)})`);
    }
    seen.add(entry.name);
  }

  const expected = [...schema.map((variable) => variable.name), COMPOSE_ONLY];
  const missing = expected.filter((name) => !seen.has(name));
  const unknown = [...seen].filter((name) => !expected.includes(name));
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(
      `.env.example differs from the configuration schema plus ${COMPOSE_ONLY}: missing [${missing.join(', ')}], unknown [${unknown.join(', ')}]`,
    );
  }

  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const valueOf = (name: string): string => byName.get(name)?.value ?? '';

  // HOST_PORT: marked as Compose-only, in the header and at the variable.
  const hostPort = byName.get(COMPOSE_ONLY);
  const headerText = header.join('\n');
  if (!headerText.includes(COMPOSE_ONLY) || !headerText.includes('Compose')) {
    throw new Error(`the header of .env.example does not say that ${COMPOSE_ONLY} is Compose-only`);
  }
  const hostPortComment = (hostPort?.comment ?? []).join('\n');
  if (
    !hostPortComment.includes('Compose') ||
    !/not read by the application/i.test(hostPortComment)
  ) {
    throw new Error(
      `${COMPOSE_ONLY} is not marked "not read by the application" (Compose only) in the comment above it`,
    );
  }
  if (valueOf(COMPOSE_ONLY) !== String(DEFAULT_PORT)) {
    throw new Error(`${COMPOSE_ONLY} must show the default port ${String(DEFAULT_PORT)}`);
  }

  // Values: the schema default or a placeholder.
  for (const variable of schema) {
    const entry = byName.get(variable.name);
    if (entry === undefined) continue;
    const { name, value, active } = entry;
    if (/[\s"'#]/.test(value)) {
      throw new Error(
        `${name}: the value must not contain spaces, quotes or "#" (line ${String(entry.line)})`,
      );
    }
    const expectedValue =
      name === DERIVED_VARIABLE
        ? variable.defaultText.replace('<PORT>', valueOf('PORT'))
        : variable.defaultText;
    if (!isPlaceholder(value) && value !== expectedValue) {
      throw new Error(
        `${name}: the value is neither a placeholder nor the schema default "${expectedValue}"`,
      );
    }
    if (SECRET_NAME.test(name) && !isPlaceholder(value)) {
      throw new Error(`${name}: a variable that sounds like a secret may only hold a placeholder`);
    }
    if (name === DERIVED_VARIABLE && active) {
      throw new Error(
        `${DERIVED_VARIABLE} must stay commented out: its default follows ${COMPOSE_ONLY} in Compose (FR-A-016)`,
      );
    }
    if (name !== DERIVED_VARIABLE && !active) {
      throw new Error(`${name} must be an active line; only ${DERIVED_VARIABLE} is left unset`);
    }
  }

  for (const entry of entries) {
    if (looksLikeSecretValue(entry.value)) {
      throw new Error(`${entry.name}: the value looks like a credential`);
    }
  }
  if (text.includes('-----BEGIN ')) throw new Error('.env.example contains key material');
}

const envExample = readRepositoryFile('.env.example');
const schemaVariables: readonly SchemaVariable[] = ENV_VARIABLES;

describe('.env.example (FR-A-011, FR-A-016, TA-06)', () => {
  it('lists exactly the variables of the configuration schema plus the Compose-only HOST_PORT', () => {
    expect(() => {
      assertEnvExampleParity({ text: envExample, schema: schemaVariables });
    }).not.toThrow();
    const names = parseEnvExample(envExample).entries.map((entry) => entry.name);
    expect(names.toSorted()).toEqual(
      [...ENV_VARIABLES.map((variable) => variable.name), COMPOSE_ONLY].toSorted(),
    );
  });

  it('marks HOST_PORT as Compose-only and not read by the application, in the header', () => {
    const { header, entries } = parseEnvExample(envExample);
    expect(header.join('\n')).toMatch(/HOST_PORT[\s\S]*Compose|Compose[\s\S]*HOST_PORT/);
    const hostPort = entries.find((entry) => entry.name === COMPOSE_ONLY);
    expect(hostPort?.comment.join(' ')).toMatch(/not read by the application/i);
    expect(hostPort?.value).toBe(String(DEFAULT_PORT));
  });

  it('shows every value as the schema default (so a change of the default is a change here)', () => {
    const { entries } = parseEnvExample(envExample);
    const port = entries.find((entry) => entry.name === 'PORT')?.value;
    for (const variable of ENV_VARIABLES) {
      const entry = entries.find((candidate) => candidate.name === variable.name);
      expect(entry?.value, variable.name).toBe(
        variable.name === DERIVED_VARIABLE
          ? variable.defaultText.replace('<PORT>', port ?? '')
          : variable.defaultText,
      );
    }
  });

  it('leaves PUBLIC_BASE_URL unset on purpose, so the Compose default follows HOST_PORT', () => {
    const entry = parseEnvExample(envExample).entries.find(
      (candidate) => candidate.name === DERIVED_VARIABLE,
    );
    expect(entry?.active).toBe(false);
    expect(entry?.comment.join(' ')).toContain(COMPOSE_ONLY);
  });

  it('holds no secret: placeholders and defaults only', () => {
    for (const entry of parseEnvExample(envExample).entries) {
      expect(looksLikeSecretValue(entry.value), entry.name).toBe(false);
    }
    expect(envExample).not.toMatch(/-----BEGIN /);
  });

  // The negative fixtures: each one is the real file with one defect, or the real file against a
  // schema that grew by one variable (T-A-230). They are built when their test runs, so a change
  // to the real file breaks the tests it concerns and not the whole file.
  const withSchema =
    (
      change: (text: string) => string,
      schema: readonly SchemaVariable[] = schemaVariables,
    ): (() => EnvExampleInput) =>
    () => ({ text: change(envExample), schema });

  const NEGATIVES: readonly (readonly [string, () => EnvExampleInput, RegExp])[] = [
    [
      'a schema with one more variable',
      withSchema((text) => text, [...schemaVariables, { name: 'NEW_VARIABLE', defaultText: 'x' }]),
      /missing \[NEW_VARIABLE\]/,
    ],
    [
      'a schema with one variable fewer',
      withSchema((text) => text, schemaVariables.slice(1)),
      /unknown \[PORT\]/,
    ],
    [
      'a variable missing from the file',
      withSchema((text) => dropLines(text, (line) => line.startsWith('TRUST_PROXY='))),
      /missing \[TRUST_PROXY\]/,
    ],
    [
      'an unknown variable',
      withSchema((text) => `${text}\nEXTRA_SETTING=1\n`),
      /unknown \[EXTRA_SETTING\]/,
    ],
    [
      'HOST_PORT missing',
      withSchema((text) => dropLines(text, (line) => line.startsWith('HOST_PORT='))),
      /missing \[HOST_PORT\]/,
    ],
    [
      'a variable listed twice',
      withSchema((text) => `${text}\nLOG_LEVEL=info\n`),
      /lists LOG_LEVEL twice/,
    ],
    [
      'HOST_PORT without the Compose-only mark',
      withSchema((text) => replaceOnce(text, /not read by the application/gi, 'used by the panel')),
      /not marked "not read by the application"/,
    ],
    [
      'a header that does not name HOST_PORT',
      withSchema((text) => `# Settings.\n\n${text.slice(text.indexOf('\n\n') + 2)}`),
      /header of \.env\.example does not say/,
    ],
    [
      'a value that is not the default',
      withSchema((text) => replaceOnce(text, /^LOG_LEVEL=info$/m, 'LOG_LEVEL=debug')),
      /LOG_LEVEL: the value is neither a placeholder nor the schema default/,
    ],
    [
      'PUBLIC_BASE_URL switched on',
      withSchema((text) => replaceOnce(text, /^#PUBLIC_BASE_URL=/m, 'PUBLIC_BASE_URL=')),
      /PUBLIC_BASE_URL must stay commented out/,
    ],
    [
      'another variable switched off',
      withSchema((text) => replaceOnce(text, /^TRUST_PROXY=/m, '#TRUST_PROXY=')),
      /TRUST_PROXY must be an active line/,
    ],
    [
      'a quoted value',
      withSchema((text) => replaceOnce(text, /^LOG_LEVEL=info$/m, 'LOG_LEVEL="info"')),
      /must not contain spaces, quotes/,
    ],
    [
      'a prose line that looks like an assignment',
      withSchema((text) => `${text}\n# PORT=9090 is an example\n`),
      /looks like a commented-out variable/,
    ],
    [
      'a line that is neither a variable nor a comment',
      withSchema((text) => `${text}\nexport PORT=1\n`),
      /neither a variable nor a comment/,
    ],
    [
      // A schema whose default for LOG_LEVEL is the generated value, so only the credential rule fires.
      'a credential-looking value on a harmless name',
      withSchema(
        (text) => replaceOnce(text, /^LOG_LEVEL=info$/m, `LOG_LEVEL=${'Ab1'.repeat(14)}`),
        schemaVariables.map((variable) =>
          variable.name === 'LOG_LEVEL' ? { ...variable, defaultText: 'Ab1'.repeat(14) } : variable,
        ),
      ),
      /looks like a credential/,
    ],
    [
      'a real-looking value on a variable that sounds like a secret',
      withSchema(
        (text) => `${text}\nAPP_KEY=changeme\n`,
        [...schemaVariables, { name: 'APP_KEY', defaultText: 'changeme' }],
      ),
      /sounds like a secret/,
    ],
  ];

  it.each(NEGATIVES)('refuses %s', (_label, input, reason) => {
    expectGuardFails(assertEnvExampleParity, input(), { reason });
  });

  it('accepts a placeholder for a variable that sounds like a secret', () => {
    expect(() => {
      assertEnvExampleParity({
        text: `${envExample}\nAPP_KEY=<generate-with-openssl>\n`,
        schema: [...schemaVariables, { name: 'APP_KEY', defaultText: '' }],
      });
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------
// Part 1b: `.env` is ignored by git and `.env.example` is not (AGENTS.md section 4)
// ---------------------------------------------------------------------------------------------

/**
 * Ask git itself, in a throwaway repository that holds only the given `.gitignore`, so the answer
 * does not depend on the clone the test runs in (a CI checkout, or a tarball without `.git`) and
 * not on the global ignore file of the machine.
 */
function ignoredByGit(gitignore: string, paths: readonly string[]): Map<string, boolean> {
  const directory = scratchDirectory('m365portal-gitignore-');
  writeFileSync(join(directory, '.gitignore'), gitignore);
  const environment = {
    PATH: process.env.PATH ?? '',
    HOME: directory,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  };
  const init = spawnSync('git', ['init', '-q'], { cwd: directory, env: environment });
  if (init.status !== 0) throw new Error(`git init failed: ${init.stderr.toString()}`);
  const result = new Map<string, boolean>();
  for (const path of paths) {
    const check = spawnSync('git', ['check-ignore', '-q', path], {
      cwd: directory,
      env: environment,
    });
    if (check.status !== 0 && check.status !== 1) {
      throw new Error(`git check-ignore failed: ${check.stderr.toString()}`);
    }
    result.set(path, check.status === 0);
  }
  return result;
}

const MUST_BE_IGNORED = ['.env', '.env.local', '.env.production', 'apps/server/.env'];

function assertEnvFilesIgnored(gitignore: string): void {
  const verdict = ignoredByGit(gitignore, [...MUST_BE_IGNORED, '.env.example']);
  for (const path of MUST_BE_IGNORED) {
    if (verdict.get(path) !== true) throw new Error(`${path} is not git-ignored`);
  }
  if (verdict.get('.env.example') === true) throw new Error('.env.example is git-ignored');
}

describe('.env and .env.example in .gitignore (AGENTS.md section 4)', () => {
  const gitignore = readRepositoryFile('.gitignore');

  it('ignores .env and its variants and keeps .env.example tracked', () => {
    expect(() => {
      assertEnvFilesIgnored(gitignore);
    }).not.toThrow();
  });

  it('refuses a .gitignore that does not ignore .env', () => {
    expectGuardFails(assertEnvFilesIgnored, 'node_modules/\ndist/\n', {
      reason: '.env is not git-ignored',
    });
  });

  it('refuses a .gitignore that ignores .env.example too', () => {
    expectGuardFails(assertEnvFilesIgnored, '.env*\n', { reason: '.env.example is git-ignored' });
  });
});

// ---------------------------------------------------------------------------------------------
// Part 1c: `.dockerignore` (FR-A-164)
// ---------------------------------------------------------------------------------------------
//
// The semantics are Docker's: a pattern is matched against the path from the context root, a
// pattern that matches a directory takes everything below it, `*` stops at "/", `**/` matches any
// number of directories (also none), and the LAST pattern that matches decides, so `!path`
// re-includes. (`moby/patternmatcher`, the matcher behind `docker build` and BuildKit.)

interface IgnoreRule {
  readonly exclusion: boolean;
  readonly expression: RegExp;
  readonly source: string;
}

function patternToExpression(pattern: string): RegExp {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern.charAt(index);
    if (character === '*') {
      if (pattern.charAt(index + 1) === '*') {
        index += 1;
        if (pattern.charAt(index + 1) === '/') index += 1;
        source += index + 1 >= pattern.length ? '.*' : '(?:.*/)?';
      } else {
        source += '[^/]*';
      }
    } else if (character === '?') {
      source += '[^/]';
    } else if (character === '\\') {
      index += 1;
      source += pattern.charAt(index).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    } else {
      source += character.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    }
  }
  return new RegExp(`${source}$`);
}

function parseDockerignore(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const exclusion = !line.startsWith('!');
    // Docker cleans the pattern: no leading "/" and no trailing "/".
    const pattern = (exclusion ? line : line.slice(1).trim())
      .replace(/^\/+/, '')
      .replace(/\/+$/, '');
    rules.push({ exclusion, expression: patternToExpression(pattern), source: line });
  }
  return rules;
}

/** Would `docker build` leave this path out of the build context? */
function isExcludedFromContext(rules: readonly IgnoreRule[], path: string): boolean {
  const segments = path.split('/');
  const prefixes = segments.map((_segment, index) => segments.slice(0, index + 1).join('/'));
  let excluded = false;
  for (const rule of rules) {
    if (prefixes.some((prefix) => rule.expression.test(prefix))) excluded = rule.exclusion;
  }
  return excluded;
}

/** Paths that must never reach the build context: secrets, VCS data, test output, other packages' trash. */
const MUST_BE_EXCLUDED: readonly string[] = [
  '.git/HEAD',
  'node_modules/hono/package.json',
  'apps/server/node_modules/hono/package.json',
  'apps/web/node_modules/.bin/vite',
  'packages/shared/node_modules/zod/package.json',
  'e2e/node_modules/@playwright/test/package.json',
  'apps/server/dist/index.js',
  'apps/web/dist/index.html',
  'packages/shared/tsconfig.tsbuildinfo',
  'e2e/tests/smoke.spec.ts',
  'e2e/playwright.config.ts',
  'docs/operations.md',
  'specs/001-m365portal/spec.md',
  'playwright-report/index.html',
  'e2e/playwright-report/index.html',
  'e2e/test-results/.last-run.json',
  'apps/web/test-results/trace.zip',
  'coverage/lcov.info',
  'apps/server/coverage/lcov.info',
  '.env',
  '.env.local',
  '.env.production',
  '.env.example',
  'apps/server/.env',
  'deploy/.env',
  'certs/server.pem',
  'apps/server/signing.key',
  'certs/client.pfx',
  'certs/client.p12',
  '.mcp.json',
  '.claude/settings.local.json',
  '.github/workflows/ci.yml',
  'data/m365portal.sqlite',
];

/** Paths the build needs; excluding any of them breaks the build or the version check. */
const MUST_BE_KEPT: readonly string[] = [
  'VERSION',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.npmrc',
  '.nvmrc',
  'tsconfig.base.json',
  'apps/server/package.json',
  'apps/server/build.mjs',
  'apps/server/tsconfig.json',
  'apps/server/src/index.ts',
  'apps/server/drizzle/0000_init.sql',
  'apps/server/drizzle/meta/_journal.json',
  'apps/web/package.json',
  'apps/web/index.html',
  'apps/web/vite.config.ts',
  'apps/web/src/main.tsx',
  'packages/shared/package.json',
  'packages/shared/src/index.ts',
  // The workspace lists e2e, so the frozen lockfile needs its manifest (plan 12.1).
  'e2e/package.json',
];

function assertDockerignore(text: string): void {
  const rules = parseDockerignore(text);
  for (const path of MUST_BE_EXCLUDED) {
    if (!isExcludedFromContext(rules, path)) {
      throw new Error(`.dockerignore does not exclude ${path}`);
    }
  }
  for (const path of MUST_BE_KEPT) {
    if (isExcludedFromContext(rules, path)) {
      throw new Error(`.dockerignore excludes ${path}, which the build needs`);
    }
  }
}

/** The sources of the `COPY` and `ADD` lines of a Dockerfile that come from the build context. */
function contextSources(dockerfile: string): string[] {
  const sources: string[] = [];
  const joined = dockerfile.replace(/\\\r?\n/g, ' ');
  for (const raw of joined.split('\n')) {
    const match = /^\s*(?:COPY|ADD)\s+(.*)$/i.exec(raw);
    if (match === null) continue;
    const words = (match[1] ?? '').split(/\s+/).filter((word) => word !== '');
    if (words.some((word) => /^--from=/i.test(word))) continue;
    const positional = words.filter((word) => !word.startsWith('--'));
    sources.push(...positional.slice(0, -1));
  }
  return sources;
}

/** A `COPY` from the context must not name a path `.dockerignore` removes from the context. */
function assertCopiedSourcesReachTheBuild(dockerfile: string, dockerignore: string): void {
  const rules = parseDockerignore(dockerignore);
  for (const source of contextSources(dockerfile)) {
    if (/[*?[]/.test(source) || source === '.' || source === './') continue;
    const path = source.replace(/^\.\//, '').replace(/\/+$/, '');
    if (isExcludedFromContext(rules, path)) {
      throw new Error(
        `the Dockerfile copies ${path}, which .dockerignore removes from the context`,
      );
    }
  }
}

describe('.dockerignore (FR-A-164)', () => {
  const dockerignore = readRepositoryFile('.dockerignore');

  it('excludes VCS data, dependencies, build and test output, docs, specs, e2e, secrets and agent state', () => {
    const rules = parseDockerignore(dockerignore);
    const leaked = MUST_BE_EXCLUDED.filter((path) => !isExcludedFromContext(rules, path));
    expect(leaked).toEqual([]);
  });

  it('keeps VERSION and everything the build reads', () => {
    const rules = parseDockerignore(dockerignore);
    const lost = MUST_BE_KEPT.filter((path) => isExcludedFromContext(rules, path));
    expect(lost).toEqual([]);
    expect(rules.some((rule) => /^\^?VERSION/.test(rule.source))).toBe(false);
  });

  it('passes the guard as a whole', () => {
    expect(() => {
      assertDockerignore(dockerignore);
    }).not.toThrow();
  });

  it('excludes e2e except its package.json, which the frozen lockfile install needs', () => {
    const rules = parseDockerignore(dockerignore);
    expect(isExcludedFromContext(rules, 'e2e/tests/smoke.spec.ts')).toBe(true);
    expect(isExcludedFromContext(rules, 'e2e/package.json')).toBe(false);
  });

  // The matcher itself, against cases whose answers Docker documents.
  it.each([
    ['node_modules', 'node_modules/a/b.js', true],
    ['node_modules', 'apps/server/node_modules/a.js', false],
    ['**/node_modules', 'apps/server/node_modules/a.js', true],
    ['**/node_modules', 'node_modules/a.js', true],
    ['*.md', 'README.md', true],
    ['*.md', 'docs/README.md', false],
    ['**/*.md', 'docs/README.md', true],
    ['.env*', '.env.local', true],
    ['.env*', 'apps/.env', false],
    ['**/.env*', 'apps/.env', true],
    ['/data', 'data/x', true],
    ['data/', 'data/x', true],
    ['temp?', 'temp1', true],
    ['temp?', 'temp12', false],
    ['a/**', 'a/b/c', true],
  ] as const)('matcher: pattern %s on %s is %s', (pattern, path, expected) => {
    expect(isExcludedFromContext(parseDockerignore(pattern), path)).toBe(expected);
  });

  it('matcher: the last matching pattern decides, so "!" re-includes', () => {
    const rules = parseDockerignore('docs\n!docs/keep.md\n');
    expect(isExcludedFromContext(rules, 'docs/other.md')).toBe(true);
    expect(isExcludedFromContext(rules, 'docs/keep.md')).toBe(false);
    expect(isExcludedFromContext(parseDockerignore('!docs/keep.md\ndocs\n'), 'docs/keep.md')).toBe(
      true,
    );
  });

  const NEGATIVES: readonly (readonly [string, () => string, RegExp])[] = [
    [
      'a file that does not exclude .env',
      () => dropLines(dockerignore, (line) => line.includes('.env')),
      /does not exclude \.env/,
    ],
    [
      'a file that excludes nested node_modules only at the root',
      () => replaceOnce(dockerignore, /^\*\*\/node_modules$/m, 'node_modules'),
      /does not exclude apps\/server\/node_modules/,
    ],
    [
      'a file that does not exclude .git',
      () => dropLines(dockerignore, (line) => line.trim() === '.git'),
      /does not exclude \.git\/HEAD/,
    ],
    [
      'a file that does not exclude the specs',
      () => dropLines(dockerignore, (line) => line.trim() === 'specs'),
      /does not exclude specs/,
    ],
    [
      'a file that does not exclude private keys',
      () => dropLines(dockerignore, (line) => line.includes('*.pem')),
      /does not exclude certs\/server\.pem/,
    ],
    ['a file that excludes VERSION', () => `${dockerignore}\nVERSION\n`, /excludes VERSION/],
    [
      'a file that excludes everything',
      () => `${dockerignore}\n**\n`,
      /excludes (?:VERSION|package\.json)/,
    ],
    [
      'a file that drops the e2e manifest exception',
      () => dropLines(dockerignore, (line) => line.trim() === '!e2e/package.json'),
      /excludes e2e\/package\.json/,
    ],
  ];

  it.each(NEGATIVES)('refuses %s', (_label, text, reason) => {
    expectGuardFails(assertDockerignore, text(), { reason });
  });

  it('refuses a Dockerfile that copies a path .dockerignore removes from the context', () => {
    const dockerfile = 'FROM scratch\nCOPY VERSION VERSION\nCOPY docs/operations.md /app/\n';
    expectGuardFails(
      (text: string) => {
        assertCopiedSourcesReachTheBuild(text, dockerignore);
      },
      dockerfile,
      { reason: 'copies docs/operations.md', name: 'assertCopiedSourcesReachTheBuild' },
    );
  });

  it('accepts a Dockerfile whose context copies all survive, and skips --from copies', () => {
    const dockerfile = [
      'FROM scratch AS build',
      'COPY VERSION package.json pnpm-lock.yaml pnpm-workspace.yaml ./',
      'COPY e2e/package.json e2e/package.json',
      'COPY apps/server/package.json apps/server/package.json',
      'COPY . .',
      'FROM scratch',
      'COPY --from=build --chown=65532:65532 /app /app',
    ].join('\n');
    expect(() => {
      assertCopiedSourcesReachTheBuild(dockerfile, dockerignore);
    }).not.toThrow();
  });

  // Goes live when the Dockerfile of T-A-231 lands: its copies must survive this .dockerignore.
  it.runIf(existsSync(join(repositoryRoot, 'Dockerfile')))(
    'lets every COPY of the real Dockerfile through',
    () => {
      expect(() => {
        assertCopiedSourcesReachTheBuild(readRepositoryFile('Dockerfile'), dockerignore);
      }).not.toThrow();
    },
  );
});

// ---------------------------------------------------------------------------------------------
// Part 2: docker-compose.yml (T-A-232; FR-A-166, FR-A-016; A-63; PA-16)
// ---------------------------------------------------------------------------------------------

// A reader for the YAML this repository's Compose file uses, and nothing else: block mappings and
// block sequences, plain, single-quoted and double-quoted scalars, `[a, b]` flow sequences of
// scalars, comments, and a key with no value (which Compose reads as "take it from the
// environment"). Anything it does not know (anchors, tags, block scalars, flow mappings, tabs,
// duplicate keys) is an error, so the file can never be misread silently. No YAML package is a
// dependency of the server, and this keeps it that way.

type YamlValue = string | boolean | null | YamlValue[] | { [key: string]: YamlValue };
type YamlMap = Record<string, YamlValue>;

interface YamlLine {
  readonly indent: number;
  readonly text: string;
  readonly number: number;
}

function stripYamlComment(line: string): string {
  let quote: string | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const character = line.charAt(index);
    if (quote !== undefined) {
      if (character === '\\' && quote === '"') index += 1;
      else if (character === quote) quote = undefined;
    } else if (character === '"' || character === "'") {
      // A quote opens a quoted scalar only where a scalar starts.
      const before = line.slice(0, index).trimEnd().slice(-1);
      if (before === '' || ':-[,'.includes(before)) quote = character;
    } else if (character === '#' && (index === 0 || /\s/.test(line.charAt(index - 1)))) {
      return line.slice(0, index);
    }
  }
  return line;
}

function splitFlowItems(inner: string, lineNumber: number): string[] {
  const items: string[] = [];
  let current = '';
  let quote: string | undefined;
  for (const character of inner) {
    if (quote !== undefined) {
      current += character;
      if (character === quote) quote = undefined;
    } else if (character === '"' || character === "'") {
      quote = character;
      current += character;
    } else if (character === ',') {
      items.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  if (quote !== undefined) throw new Error(`YAML line ${String(lineNumber)}: unterminated quote`);
  if (current.trim() !== '' || items.length > 0) items.push(current);
  return items;
}

function parseYamlScalar(raw: string, lineNumber: number): YamlValue {
  const text = raw.trim();
  const where = `YAML line ${String(lineNumber)}`;
  if (text === '' || text === '~' || text === 'null') return null;
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text.startsWith('"')) {
    if (text.length < 2 || !text.endsWith('"'))
      throw new Error(`${where}: bad double-quoted scalar`);
    return JSON.parse(text) as string;
  }
  if (text.startsWith("'")) {
    if (text.length < 2 || !text.endsWith("'"))
      throw new Error(`${where}: bad single-quoted scalar`);
    return text.slice(1, -1).replaceAll("''", "'");
  }
  if (text.startsWith('[')) {
    if (!text.endsWith(']')) throw new Error(`${where}: unterminated flow sequence`);
    return splitFlowItems(text.slice(1, -1), lineNumber).map((item) =>
      parseYamlScalar(item, lineNumber),
    );
  }
  if (/^[&*!|>{%@`]/.test(text)) throw new Error(`${where}: unsupported YAML construct`);
  return text;
}

function parseYaml(text: string): YamlValue {
  const lines: YamlLine[] = [];
  text.split('\n').forEach((raw, index) => {
    const stripped = stripYamlComment(raw).trimEnd();
    if (stripped.trim() === '') return;
    if (stripped.includes('\t')) throw new Error(`YAML line ${String(index + 1)}: tab`);
    lines.push({
      indent: stripped.length - stripped.trimStart().length,
      text: stripped.trim(),
      number: index + 1,
    });
  });
  const first = lines[0];
  if (first === undefined) return null;

  let position = 0;
  const isItem = (line: YamlLine): boolean => line.text === '-' || line.text.startsWith('- ');

  function parseBlock(indent: number): YamlValue {
    const line = lines[position];
    if (line === undefined) return null;
    return isItem(line) ? parseSequence(indent) : parseMapping(indent);
  }

  function parseSequence(indent: number): YamlValue[] {
    const items: YamlValue[] = [];
    for (
      let line = lines[position];
      line?.indent === indent && isItem(line);
      line = lines[position]
    ) {
      const rest = line.text.slice(1).trim();
      position += 1;
      if (rest === '') {
        const next = lines[position];
        items.push(next !== undefined && next.indent > indent ? parseBlock(next.indent) : null);
      } else if (/^[A-Za-z0-9_.-]+:(?:\s|$)/.test(rest)) {
        throw new Error(
          `YAML line ${String(line.number)}: a mapping inside a list is not supported`,
        );
      } else {
        items.push(parseYamlScalar(rest, line.number));
      }
    }
    return items;
  }

  function parseMapping(indent: number): YamlMap {
    const map: YamlMap = {};
    for (let line = lines[position]; line?.indent === indent; line = lines[position]) {
      const match = /^([A-Za-z0-9_.-]+):(?:\s+(.*))?$/.exec(line.text);
      if (match === null || isItem(line)) {
        throw new Error(`YAML line ${String(line.number)}: expected "key: value"`);
      }
      const [, key = '', rest = ''] = match;
      if (Object.hasOwn(map, key)) {
        throw new Error(`YAML line ${String(line.number)}: duplicate key ${key}`);
      }
      position += 1;
      if (rest.trim() !== '') {
        map[key] = parseYamlScalar(rest, line.number);
        continue;
      }
      const next = lines[position];
      if (next !== undefined && next.indent > indent) map[key] = parseBlock(next.indent);
      else if (next?.indent === indent && isItem(next)) map[key] = parseSequence(indent);
      else map[key] = null;
    }
    return map;
  }

  const result = parseBlock(first.indent);
  const rest = lines[position];
  if (rest !== undefined)
    throw new Error(`YAML line ${String(rest.number)}: unexpected indentation`);
  return result;
}

function isYamlMap(value: YamlValue | undefined): value is YamlMap {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The value at `path` (map keys), or `undefined` when any step is missing. */
function yamlAt(root: YamlValue, ...path: string[]): YamlValue | undefined {
  let current: YamlValue | undefined = root;
  for (const key of path) {
    if (!isYamlMap(current) || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

describe('the YAML reader of this test (it only has to be exact for the Compose file)', () => {
  it('reads mappings, lists, quoted scalars, flow lists, comments and empty values', () => {
    const parsed = parseYaml(
      [
        '# comment',
        'name: demo   # trailing comment',
        'services:',
        '  app:',
        '    ports:',
        '      - "${A:-1}:${B:-2}"  # why',
        "      - 'it''s'",
        '    list: [a, "b, c", \'d\']',
        '    empty:',
        '    flag: true',
        '    off: false',
        '    url: ${U:-http://localhost:${P:-1}}',
        '    seq:',
        '    - x',
        '    - y',
        'volumes:',
        '  data:',
      ].join('\n'),
    );
    expect(parsed).toEqual({
      name: 'demo',
      services: {
        app: {
          ports: ['${A:-1}:${B:-2}', "it's"],
          list: ['a', 'b, c', 'd'],
          empty: null,
          flag: true,
          off: false,
          url: '${U:-http://localhost:${P:-1}}',
          seq: ['x', 'y'],
        },
      },
      volumes: { data: null },
    });
  });

  it.each([
    ['a tab', 'a:\n\tb: 1\n'],
    ['an anchor', 'a: &x 1\n'],
    ['a block scalar', 'a: |\n  text\n'],
    ['a flow mapping', 'a: {b: 1}\n'],
    ['a duplicate key', 'a: 1\na: 2\n'],
    ['a mapping inside a list', 'a:\n  - b: 1\n'],
    ['a bad indentation', 'a:\n    b: 1\n  c: 2\n'],
    ['an unterminated quote', 'a: "x\n'],
  ])('refuses %s', (_label, text) => {
    expect(() => parseYaml(text)).toThrow(/YAML line/);
  });
});

/** The active mapping line, in either quote style (Prettier writes single quotes). */
const MAPPING_LINE = /- (["'])\$\{HOST_PORT:-9300\}:\$\{PORT:-9300\}\1/;

/** Variables the image fixes and the Compose file therefore does not pass on (see the file). */
const IMAGE_LEVEL = ['HOST', 'DATA_DIR'] as const;
const SERVICE = 'm365portal';
const VOLUME = 'data';

function stringList(value: YamlValue | undefined): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value
    : undefined;
}

/** `15s` and `1m30s` style durations of a Compose file, in milliseconds. */
function durationMs(value: YamlValue | undefined): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^(?:(\d+)m)?(?:(\d+)s)?$/.exec(value);
  if (match === null || value === '') return undefined;
  return (Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0)) * 1000;
}

/** The comment lines directly above the first line that starts with `needle`. */
function commentAbove(text: string, needle: string): string {
  const lines = text.split('\n');
  const index = lines.findIndex((line) => line.trim().startsWith(needle));
  if (index < 0) throw new Error(`docker-compose.yml has no "${needle}" line`);
  const comment: string[] = [];
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const line = (lines[cursor] ?? '').trim();
    if (!line.startsWith('#')) break;
    comment.unshift(line);
  }
  return comment.join('\n');
}

interface ComposeInput {
  readonly compose: string;
  readonly envExample: string;
  readonly schema: readonly SchemaVariable[];
}

/**
 * The rules of FR-A-166 and FR-A-016 for `docker-compose.yml`. Throws on the first violation.
 * Every key of the hardening list is asserted by value, because a file that merely mentions
 * `read_only` in a comment would otherwise pass.
 */
function assertComposeFile({ compose, envExample, schema }: ComposeInput): void {
  const port = String(DEFAULT_PORT);
  const document = parseYaml(compose);
  const services = yamlAt(document, 'services');
  if (!isYamlMap(services) || Object.keys(services).join() !== SERVICE) {
    throw new Error(`the file must define exactly one service, "${SERVICE}"`);
  }
  const service = (key: string): YamlValue | undefined =>
    yamlAt(document, 'services', SERVICE, key);
  const mustBe = (key: string, expected: YamlValue): void => {
    const actual = service(key);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(
        `${key} must be ${JSON.stringify(expected)}, found ${actual === undefined ? 'nothing' : JSON.stringify(actual)}`,
      );
    }
  };
  const mustBeAbsent = (key: string): void => {
    if (service(key) !== undefined) throw new Error(`${key} must not be set`);
  };

  // The image: the registry image, not a build, and a comment that says to pin it.
  mustBe('image', 'ghcr.io/flux76hq/m365portal:latest');
  mustBeAbsent('build');
  const imageComment = commentAbove(compose, 'image:');
  if (
    !/\bpin\b/i.test(imageComment) ||
    !/version tag/i.test(imageComment) ||
    !/digest/i.test(imageComment)
  ) {
    throw new Error('a comment above image must say to pin a version tag or digest in production');
  }

  // Ports (FR-A-016): the mapping, unchanged, and the preview-mode comment next to it.
  mustBe('ports', [`\${HOST_PORT:-${port}}:\${PORT:-${port}}`]);
  const portsComment = commentAbove(compose, 'ports:');
  if (
    !portsComment.includes('PREVIEW_MODE=true') ||
    !portsComment.includes(`127.0.0.1:\${HOST_PORT:-${port}}:\${PORT:-${port}}`)
  ) {
    throw new Error(
      'a comment above ports must say that PREVIEW_MODE=true publishes on 127.0.0.1 only, with the mapping',
    );
  }

  // Environment: PORT, the derived PUBLIC_BASE_URL, and the pass-through of the rest.
  const environment = service('environment');
  if (!isYamlMap(environment)) throw new Error('environment must be a mapping');
  const passedOn = schema
    .map((variable) => variable.name)
    .filter((name) => !(IMAGE_LEVEL as readonly string[]).includes(name));
  if (JSON.stringify(Object.keys(environment).toSorted()) !== JSON.stringify(passedOn.toSorted())) {
    const missing = passedOn.filter((name) => !Object.hasOwn(environment, name));
    const extra = Object.keys(environment).filter((name) => !passedOn.includes(name));
    throw new Error(
      `environment differs from the schema without ${IMAGE_LEVEL.join(' and ')}: missing [${missing.join(', ')}], unexpected [${extra.join(', ')}]`,
    );
  }
  if (environment.PORT !== `\${PORT:-${port}}`) throw new Error(`PORT must be \${PORT:-${port}}`);
  if (
    environment.PUBLIC_BASE_URL !== `\${PUBLIC_BASE_URL:-http://localhost:\${HOST_PORT:-${port}}}`
  ) {
    throw new Error(
      `PUBLIC_BASE_URL must default to http://localhost:\${HOST_PORT:-${port}}: the browser reaches the panel on the host port (A-63)`,
    );
  }
  for (const name of passedOn) {
    if (name !== 'PORT' && name !== 'PUBLIC_BASE_URL' && environment[name] !== null) {
      throw new Error(
        `${name} must be passed through without a value, so the application default stays the only default`,
      );
    }
  }
  // The variables the image fixes are listed in .env.example, with the statement that Compose
  // does not pass them on: no setting is ever silently ignored.
  const entries = parseEnvExample(envExample).entries;
  for (const name of IMAGE_LEVEL) {
    const comment = entries.find((entry) => entry.name === name)?.comment.join(' ') ?? '';
    if (!comment.includes('does not pass')) {
      throw new Error(`.env.example must say that docker-compose.yml does not pass ${name} on`);
    }
  }

  // Storage and hardening (FR-A-161, FR-A-166).
  mustBe('volumes', [`${VOLUME}:/data`]);
  const declaredVolumes = yamlAt(document, 'volumes');
  if (!isYamlMap(declaredVolumes) || !Object.hasOwn(declaredVolumes, VOLUME)) {
    throw new Error(`the named volume "${VOLUME}" must be declared at the top level`);
  }
  mustBe('read_only', true);
  mustBe('tmpfs', ['/tmp']);
  mustBe('cap_drop', ['ALL']);
  mustBeAbsent('cap_add');
  mustBe('security_opt', ['no-new-privileges:true']);
  mustBe('mem_limit', '512m');
  mustBe('cpus', '1.0');
  mustBe('pids_limit', '128');
  mustBe('restart', 'unless-stopped');
  mustBeAbsent('privileged');
  mustBeAbsent('network_mode');
  mustBeAbsent('pid');
  mustBeAbsent('ipc');
  mustBeAbsent('env_file');
  mustBeAbsent('user');

  // Shutdown: Docker's default of 10 seconds equals the drain budget, so Compose asks for more.
  mustBe('stop_grace_period', '15s');
  const grace = durationMs(service('stop_grace_period'));
  if (grace === undefined || grace <= LIMITS.shutdownDrainMs) {
    throw new Error(`stop_grace_period must exceed the ${String(LIMITS.shutdownDrainMs)} ms drain`);
  }

  // Health: the Node script of the image, which reads PORT (FR-A-162).
  const test = stringList(yamlAt(document, 'services', SERVICE, 'healthcheck', 'test'));
  if (test?.join(' ') !== 'CMD /nodejs/bin/node dist/healthcheck.js') {
    throw new Error(
      'healthcheck.test must run the Node script: CMD /nodejs/bin/node dist/healthcheck.js',
    );
  }
  for (const key of ['interval', 'timeout', 'start_period', 'retries']) {
    if (yamlAt(document, 'services', SERVICE, 'healthcheck', key) === undefined) {
      throw new Error(`healthcheck.${key} must be set`);
    }
  }
}

const composeFile = readRepositoryFile('docker-compose.yml');
const composeInput: ComposeInput = {
  compose: composeFile,
  envExample,
  schema: schemaVariables,
};

describe('docker-compose.yml (FR-A-166, FR-A-016)', () => {
  it('passes every rule of the hardened example', () => {
    expect(() => {
      assertComposeFile(composeInput);
    }).not.toThrow();
  });

  it('has the mapping "${HOST_PORT:-9300}:${PORT:-9300}" as an active line, unchanged', () => {
    const port = String(DEFAULT_PORT);
    const active = composeFile
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => !line.startsWith('#') && line.includes('HOST_PORT'))
      .map((line) => line.replace(/^- (["'])(.*)\1$/, '- $2'));
    expect(active).toContain(`- \${HOST_PORT:-${port}}:\${PORT:-${port}}`);
    expect(MAPPING_LINE.test(composeFile)).toBe(true);
  });

  it('is one service from the registry image with the Docker volume at /data', () => {
    const document = parseYaml(composeFile);
    expect(Object.keys(yamlAt(document, 'services') as YamlMap)).toEqual([SERVICE]);
    expect(yamlAt(document, 'services', SERVICE, 'image')).toBe(
      'ghcr.io/flux76hq/m365portal:latest',
    );
    expect(yamlAt(document, 'services', SERVICE, 'volumes')).toEqual([`${VOLUME}:/data`]);
  });

  it('tells the operator, next to the mapping, how to publish in preview mode', () => {
    const comment = commentAbove(composeFile, 'ports:');
    expect(comment).toContain('PREVIEW_MODE=true');
    expect(comment).toContain('127.0.0.1:${HOST_PORT:-9300}:${PORT:-9300}');
  });

  it('passes on every variable of .env.example that the application reads, except the two the image fixes', () => {
    const environment = yamlAt(
      parseYaml(composeFile),
      'services',
      SERVICE,
      'environment',
    ) as YamlMap;
    const listed = parseEnvExample(envExample)
      .entries.map((entry) => entry.name)
      .filter((name) => name !== COMPOSE_ONLY);
    const ignored = listed.filter((name) => !Object.hasOwn(environment, name));
    expect(ignored.toSorted()).toEqual([...IMAGE_LEVEL].toSorted());
  });

  it('keeps the stop grace period above the drain budget of the application', () => {
    const grace = durationMs(
      yamlAt(parseYaml(composeFile), 'services', SERVICE, 'stop_grace_period'),
    );
    expect(grace).toBeGreaterThan(LIMITS.shutdownDrainMs);
  });

  // Negative fixtures: the real file with one defect each, built when their test runs.
  const mutated =
    (change: (text: string) => string): (() => ComposeInput) =>
    () => ({ ...composeInput, compose: change(composeFile) });
  const dropKey = (key: string) => (text: string) =>
    dropLines(text, (line) => line.trim().startsWith(`${key}:`));

  const NEGATIVES: readonly (readonly [string, () => ComposeInput, RegExp])[] = [
    ['a file without read_only', mutated(dropKey('read_only')), /read_only must be true/],
    [
      'read_only switched off',
      mutated((text) => replaceOnce(text, 'read_only: true', 'read_only: false')),
      /read_only must be true/,
    ],
    [
      'read_only only in a comment',
      mutated((text) => `${dropKey('read_only')(text)}\n# read_only: true\n`),
      /read_only must be true/,
    ],
    [
      'a file without cap_drop',
      mutated((text) => replaceOnce(text, / *cap_drop:\n\s+- ALL\n/, '')),
      /cap_drop must be/,
    ],
    [
      'a capability added back',
      mutated((text) =>
        replaceOnce(text, 'cap_drop:', 'cap_add:\n      - NET_ADMIN\n    cap_drop:'),
      ),
      /cap_add must not be set/,
    ],
    [
      'no-new-privileges missing',
      mutated((text) => replaceOnce(text, / *security_opt:\n\s+- no-new-privileges:true\n/, '')),
      /security_opt must be/,
    ],
    [
      'tmpfs missing',
      mutated((text) => replaceOnce(text, / *tmpfs:\n\s+- \/tmp\n/, '')),
      /tmpfs must be/,
    ],
    ['no memory limit', mutated(dropKey('mem_limit')), /mem_limit must be/],
    ['no cpu limit', mutated(dropKey('cpus')), /cpus must be/],
    ['no pids limit', mutated(dropKey('pids_limit')), /pids_limit must be/],
    [
      'a stop grace period equal to the drain budget',
      mutated((text) => replaceOnce(text, 'stop_grace_period: 15s', 'stop_grace_period: 10s')),
      /stop_grace_period must be/,
    ],
    [
      'a restart policy of no',
      mutated((text) => replaceOnce(text, 'restart: unless-stopped', 'restart: "no"')),
      /restart must be/,
    ],
    [
      'no healthcheck',
      mutated((text) => replaceOnce(text, /healthcheck:[\s\S]*?\n\n/, '\n')),
      /healthcheck\.test must run/,
    ],
    [
      'a healthcheck through a shell',
      mutated((text) =>
        replaceOnce(text, /test: \[.*\]/, 'test: ["CMD-SHELL", "curl -f http://localhost/readyz"]'),
      ),
      /healthcheck\.test must run/,
    ],
    [
      'a mapping that ignores PORT',
      mutated((text) => replaceOnce(text, MAPPING_LINE, '- "${HOST_PORT:-9300}:9300"')),
      /ports must be/,
    ],
    [
      'a mapping that ignores HOST_PORT',
      mutated((text) => replaceOnce(text, MAPPING_LINE, '- "${PORT:-9300}:${PORT:-9300}"')),
      /ports must be/,
    ],
    [
      'a PUBLIC_BASE_URL default that follows PORT, not the host port',
      mutated((text) =>
        replaceOnce(
          text,
          /http:\/\/localhost:\$\{HOST_PORT:-9300\}\}/,
          'http://localhost:${PORT:-9300}}',
        ),
      ),
      /PUBLIC_BASE_URL must default to/,
    ],
    ['PORT not passed to the container', mutated(dropKey('PORT')), /missing \[PORT\]/],
    [
      'a variable of the schema that is not passed on',
      mutated(dropKey('TRUST_PROXY')),
      /missing \[TRUST_PROXY\]/,
    ],
    [
      'HOST_PORT passed into the container',
      mutated((text) =>
        replaceOnce(text, '      PORT:', '      HOST_PORT: ${HOST_PORT:-9300}\n      PORT:'),
      ),
      /unexpected \[HOST_PORT\]/,
    ],
    [
      'a second default for a variable the application already defaults',
      mutated((text) => replaceOnce(text, /^(\s+)LOG_LEVEL:$/m, '$1LOG_LEVEL: ${LOG_LEVEL:-info}')),
      /LOG_LEVEL must be passed through without a value/,
    ],
    [
      'the image fixed variable HOST passed on',
      mutated((text) =>
        replaceOnce(text, '      PORT:', '      HOST: ${HOST:-0.0.0.0}\n      PORT:'),
      ),
      /unexpected \[HOST\]/,
    ],
    [
      'a host bind mount instead of the named volume',
      mutated((text) => replaceOnce(text, `- ${VOLUME}:/data`, '- ./data:/data')),
      /volumes must be/,
    ],
    [
      'a privileged container',
      mutated((text) =>
        replaceOnce(text, 'read_only: true', 'read_only: true\n    privileged: true'),
      ),
      /privileged must not be set/,
    ],
    [
      'host networking',
      mutated((text) =>
        replaceOnce(text, 'read_only: true', 'read_only: true\n    network_mode: host'),
      ),
      /network_mode must not be set/,
    ],
    [
      'a build instead of the registry image',
      mutated((text) => replaceOnce(text, 'read_only: true', 'read_only: true\n    build: .')),
      /build must not be set/,
    ],
    [
      'an image from somewhere else',
      mutated((text) =>
        replaceOnce(text, 'ghcr.io/flux76hq/m365portal:latest', 'm365portal:local'),
      ),
      /image must be/,
    ],
    [
      'no comment about pinning the image',
      mutated((text) => replaceOnce(text, /^\s*#[^\n]*\bpin\b[^\n]*\n/im, '')),
      /comment above image/,
    ],
    [
      'no comment about preview mode next to the mapping',
      mutated((text) => replaceOnce(text, /^\s*#[^\n]*PREVIEW_MODE=true[^\n]*\n/im, '')),
      /comment above ports/,
    ],
    [
      'a second service',
      mutated((text) =>
        replaceOnce(text, '\nvolumes:\n', '  extra:\n    image: example\n\nvolumes:\n'),
      ),
      /exactly one service/,
    ],
  ];

  it.each(NEGATIVES)('refuses %s', (_label, input, reason) => {
    expectGuardFails(assertComposeFile, input(), { reason });
  });

  it('refuses an .env.example that does not explain the variables Compose leaves to the image', () => {
    expectGuardFails(
      assertComposeFile,
      {
        ...composeInput,
        envExample: replaceOnce(
          envExample,
          /does not pass this variable on/g,
          'passes this variable on',
        ),
      },
      { reason: 'does not pass HOST on' },
    );
  });
});

// `docker compose config` is the authority on the nested default expansion (PA-16): the plan marks
// it UNVERIFIED until Compose itself has resolved it. It needs the plugin but no Docker daemon.
// CI sets REQUIRE_DOCKER=1, which turns a missing plugin into a failure; elsewhere the tests are
// skipped, and the reason is printed once.

function dockerCompose(
  directory: string,
  args: readonly string[],
): { status: number | null; stdout: string; stderr: string } {
  // Compose reads its settings from the environment before it reads `.env`: pass on nothing but
  // what the plugin needs to be found, so PORT, HOST_PORT or COMPOSE_FILE of this machine cannot
  // change the answer.
  const environment: Record<string, string> = {};
  for (const name of ['PATH', 'HOME', 'DOCKER_CONFIG']) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  const result = spawnSync(
    'docker',
    ['compose', '--project-directory', directory, '--project-name', 'm365portal-test', ...args],
    { cwd: directory, env: environment, encoding: 'utf8' },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const composePlugin = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' });
const composeAvailable = composePlugin.status === 0;
const dockerRequired = process.env.REQUIRE_DOCKER === '1';
if (!composeAvailable && !dockerRequired) {
  console.warn(
    'deploy-files.test.ts: the docker compose plugin is not installed, so the tests that resolve docker-compose.yml with `docker compose config` are skipped (CI sets REQUIRE_DOCKER=1 and then runs them).',
  );
}

interface ResolvedService {
  readonly environment?: Record<string, string | null>;
  readonly ports?: readonly { readonly target: number; readonly published: string | number }[];
  readonly read_only?: boolean;
  readonly cap_drop?: readonly string[];
  readonly security_opt?: readonly string[];
  readonly tmpfs?: readonly string[];
  readonly pids_limit?: number;
  readonly restart?: string;
}

function resolveCompose(dotenv: string | undefined): ResolvedService {
  const directory = scratchDirectory('m365portal-compose-');
  writeFileSync(join(directory, 'docker-compose.yml'), composeFile);
  if (dotenv !== undefined) writeFileSync(join(directory, '.env'), dotenv);
  const result = dockerCompose(directory, ['config', '--format', 'json']);
  if (result.status !== 0) throw new Error(`docker compose config failed: ${result.stderr}`);
  // A variable without a default would print a warning here.
  if (result.stderr.trim() !== '')
    throw new Error(`docker compose config warned: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout) as { services?: Record<string, ResolvedService> };
  const service = parsed.services?.[SERVICE];
  if (service === undefined) throw new Error('docker compose config printed no service');
  return service;
}

describe.skipIf(!composeAvailable && !dockerRequired)('docker compose config (PA-16)', () => {
  const port = String(DEFAULT_PORT);
  const baseOrigin = (hostPort: string): string => `http://localhost:${hostPort}`;

  it('finds the compose plugin (REQUIRE_DOCKER=1 makes a missing plugin a failure)', () => {
    expect(composeAvailable, 'the docker compose plugin must be installed').toBe(true);
  });

  it.each([
    ['no .env', undefined, port, DEFAULT_PORT, port, baseOrigin(port)],
    ['HOST_PORT=9090', 'HOST_PORT=9090\n', '9090', DEFAULT_PORT, port, baseOrigin('9090')],
    ['PORT=9090', 'PORT=9090\n', port, 9090, '9090', baseOrigin(port)],
    [
      'HOST_PORT=9090 and PORT=9191',
      'HOST_PORT=9090\nPORT=9191\n',
      '9090',
      9191,
      '9191',
      baseOrigin('9090'),
    ],
    [
      'HOST_PORT=9090 and PORT=9090',
      'HOST_PORT=9090\nPORT=9090\n',
      '9090',
      9090,
      '9090',
      baseOrigin('9090'),
    ],
  ] as const)(
    'resolves the nested defaults with %s',
    (_label, dotenv, published, target, containerPort, origin) => {
      const service = resolveCompose(dotenv);
      const mapping = service.ports?.[0];
      expect(service.ports).toHaveLength(1);
      expect(String(mapping?.published)).toBe(published);
      expect(mapping?.target).toBe(target);
      expect(service.environment?.PORT).toBe(containerPort);
      expect(service.environment?.PUBLIC_BASE_URL).toBe(origin);
    },
  );

  it('lets an explicit PUBLIC_BASE_URL and a setting from .env reach the container', () => {
    const service = resolveCompose(
      'HOST_PORT=9090\nPUBLIC_BASE_URL=https://panel.example.com\nTRUST_PROXY=1\nLOG_LEVEL=debug\n',
    );
    expect(service.environment?.PUBLIC_BASE_URL).toBe('https://panel.example.com');
    expect(service.environment?.TRUST_PROXY).toBe('1');
    expect(service.environment?.LOG_LEVEL).toBe('debug');
  });

  it('leaves a setting unset in the container when .env does not set it', () => {
    const service = resolveCompose(undefined);
    expect(service.environment?.TRUST_PROXY ?? null).toBeNull();
    expect(service.environment?.HOST_PORT).toBeUndefined();
    expect(service.environment?.HOST).toBeUndefined();
    expect(service.environment?.DATA_DIR).toBeUndefined();
  });

  it('gives the default behaviour when .env.example is copied to .env unchanged', () => {
    const service = resolveCompose(envExample);
    const mapping = service.ports?.[0];
    expect(String(mapping?.published)).toBe(port);
    expect(mapping?.target).toBe(DEFAULT_PORT);
    expect(service.environment?.PUBLIC_BASE_URL).toBe(baseOrigin(port));
    for (const variable of ENV_VARIABLES) {
      if ((IMAGE_LEVEL as readonly string[]).includes(variable.name)) continue;
      if (variable.name === 'PUBLIC_BASE_URL') continue;
      expect(service.environment?.[variable.name], variable.name).toBe(variable.defaultText);
    }
  });

  it('is valid with `docker compose config -q`, with and without a .env, and warns about nothing', () => {
    for (const dotenv of [undefined, envExample]) {
      const directory = scratchDirectory('m365portal-compose-q-');
      writeFileSync(join(directory, 'docker-compose.yml'), composeFile);
      if (dotenv !== undefined) writeFileSync(join(directory, '.env'), dotenv);
      const result = dockerCompose(directory, ['config', '-q']);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toBe('');
    }
  });

  it('resolves the hardening keys the same way the file states them', () => {
    const service = resolveCompose(undefined);
    expect(service.read_only).toBe(true);
    expect(service.cap_drop).toEqual(['ALL']);
    expect(service.security_opt).toEqual(['no-new-privileges:true']);
    expect(service.tmpfs).toEqual(['/tmp']);
    expect(service.pids_limit).toBe(128);
    expect(service.restart).toBe('unless-stopped');
  });

  it('shows that the resolver catches a mapping that ignores HOST_PORT (negative)', () => {
    const directory = scratchDirectory('m365portal-compose-negative-');
    writeFileSync(
      join(directory, 'docker-compose.yml'),
      replaceOnce(composeFile, MAPPING_LINE, '- "${PORT:-9300}:${PORT:-9300}"'),
    );
    writeFileSync(join(directory, '.env'), 'HOST_PORT=9090\n');
    const result = dockerCompose(directory, ['config', '--format', 'json']);
    const parsed = JSON.parse(result.stdout) as { services: Record<string, ResolvedService> };
    expect(String(parsed.services[SERVICE]?.ports?.[0]?.published)).not.toBe('9090');
  });
});

// ---------------------------------------------------------------------------------------------
// Part 3: the deployment notes (T-A-233; FR-A-169; the numbers of FR-A-182 and baseline section 6)
// ---------------------------------------------------------------------------------------------
//
// `server/docs-contract.test.ts` and `server/limits-doc.test.ts` (stream S8) are the permanent
// controls for these two files. This part is the control of the stream that wrote them: it proves
// that the notes state the numbers of `LIMITS` and no other number, that the links resolve, and that
// the Caddy example carries the numbers a proxy in front has to honour.

/** Every number in LIMITS, so a figure in the notes can be checked against the single source. */
function limitNumbers(value: unknown = LIMITS): number[] {
  if (typeof value === 'number') return [value];
  if (typeof value === 'object' && value !== null)
    return Object.values(value).flatMap(limitNumbers);
  return [];
}

const withThousands = (value: number): string => value.toLocaleString('en-US');
const seconds = (milliseconds: number): number => milliseconds / 1000;

/** The slug GitHub gives a heading, which is what a `#fragment` link must match. */
function headingSlug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}\s_-]/gu, '')
    .replaceAll(/\s/g, '-');
}

function headingsOf(markdown: string): string[] {
  return markdown
    .split('\n')
    .filter((line) => /^#{1,6}\s/.test(line))
    .map((line) => headingSlug(line.replace(/^#+\s+/, '')));
}

/** Relative links of a Markdown file, resolved against the file's directory. */
function assertLinksResolve(markdown: string, directory: string): void {
  for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = match[1] ?? '';
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    const [path = '', fragment] = target.split('#');
    const resolved = path === '' ? undefined : join(repositoryRoot, directory, path);
    if (resolved !== undefined && !existsSync(resolved)) {
      throw new Error(`the link ${target} does not resolve: ${path} does not exist`);
    }
    if (fragment !== undefined) {
      const text = resolved === undefined ? markdown : readFileSync(resolved, 'utf8');
      if (!headingsOf(text).includes(fragment)) {
        throw new Error(`the link ${target} does not resolve: no heading "${fragment}"`);
      }
    }
  }
}

/**
 * The numbers of the notes. Every figure written as "N bytes" is a value of LIMITS, and the figures
 * the operator must act on are all there: the largest request, the keep-alive of the application,
 * the drain the stop grace must cover, and the stop grace the Compose file asks for.
 */
function assertNotesNumbers(readme: string, composeGraceSeconds: number): void {
  const known = new Set(limitNumbers());
  for (const match of readme.matchAll(/(\d[\d,]*) bytes/g)) {
    const figure = Number((match[1] ?? '').replaceAll(',', ''));
    if (!known.has(figure)) {
      throw new Error(`"${match[0]}" is not a value of LIMITS (packages/shared/src/limits.ts)`);
    }
  }
  const required = [
    `at least ${withThousands(LIMITS.body.importRequestBytes)} bytes`,
    `${String(seconds(LIMITS.http.keepAliveTimeoutMs))} s`,
    `at least ${String(seconds(LIMITS.shutdownDrainMs))} s`,
    `${String(composeGraceSeconds)} s`,
  ];
  for (const text of required) {
    if (!readme.includes(text)) throw new Error(`the notes do not state "${text}"`);
  }
  for (const word of ['Bicep', 'seccomp', 'Phase D']) {
    if (!readme.includes(word)) throw new Error(`the notes do not mention ${word}`);
  }
  if (!/^## Nederlands$/m.test(readme)) throw new Error('the notes have no Dutch section');
  if (!readme.includes('limits-outside-the-repository')) {
    throw new Error('the notes do not link to the limits table of docs/operations.md');
  }
}

/** A number in a Caddy directive such as `max_size 9437184`, or a duration such as `keepalive 60s`. */
function caddyValue(caddyfile: string, directive: string): string | undefined {
  const active = caddyfile
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => !line.startsWith('#'));
  const line = active.find((candidate) => candidate.startsWith(`${directive} `));
  return line?.slice(directive.length).trim();
}

/** The Caddy example: the directives are the verified ones, and the numbers honour LIMITS. */
function assertCaddyExample(caddyfile: string): void {
  const active = caddyfile
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .join('\n');
  for (const directive of ['request_body', 'reverse_proxy', 'transport http']) {
    if (!active.includes(directive)) throw new Error(`the Caddy example has no ${directive}`);
  }
  const maxSize = caddyValue(caddyfile, 'max_size');
  if (maxSize === undefined || !/^\d+$/.test(maxSize)) {
    throw new Error('max_size must be a plain number of bytes');
  }
  if (Number(maxSize) !== LIMITS.body.importRequestBytes) {
    throw new Error(
      `max_size must be ${String(LIMITS.body.importRequestBytes)} bytes (the branding import), found ${maxSize}`,
    );
  }
  const keepalive = /^(\d+)s$/.exec(caddyValue(caddyfile, 'keepalive') ?? '');
  if (keepalive === null) throw new Error('keepalive must be a duration in seconds, such as 60s');
  if (Number(keepalive[1]) >= seconds(LIMITS.http.keepAliveTimeoutMs)) {
    throw new Error(
      `keepalive must stay below the ${String(seconds(LIMITS.http.keepAliveTimeoutMs))} s keep-alive of the application`,
    );
  }
  for (const word of [
    'PUBLIC_BASE_URL',
    'TRUST_PROXY',
    'Host',
    withThousands(LIMITS.body.importRequestBytes),
  ]) {
    if (!caddyfile.includes(word)) throw new Error(`the Caddy example does not mention ${word}`);
  }
  if (!caddyfile.includes('caddyserver.com/docs')) {
    throw new Error(
      'the Caddy example does not cite the Caddy documentation it was verified against',
    );
  }
}

describe('deploy/README.md (T-A-233; FR-A-169; baseline section 6)', () => {
  const readme = readRepositoryFile('deploy/README.md');
  const graceSeconds = seconds(
    durationMs(yamlAt(parseYaml(composeFile), 'services', SERVICE, 'stop_grace_period')) ?? 0,
  );

  it('states the numbers of LIMITS and no other number of bytes', () => {
    expect(() => {
      assertNotesNumbers(readme, graceSeconds);
    }).not.toThrow();
  });

  it('has links that resolve, anchors included', () => {
    expect(() => {
      assertLinksResolve(readme, 'deploy');
    }).not.toThrow();
  });

  it('links to the limits table of docs/operations.md, which AGENTS.md cites', () => {
    expect(readme).toContain('../docs/operations.md#limits-outside-the-repository');
    expect(headingsOf(readRepositoryFile('docs/operations.md'))).toContain(
      'limits-outside-the-repository',
    );
  });

  it('has the Compose stop grace as a number equal to the file', () => {
    expect(graceSeconds).toBe(15);
    expect(readme).toContain(`${String(graceSeconds)} s`);
  });

  const NEGATIVES: readonly (readonly [string, () => string, RegExp])[] = [
    [
      'a wrong number of bytes',
      () => replaceOnce(readme, '9,437,184 bytes', '9,437,148 bytes'),
      /is not a value of LIMITS/,
    ],
    [
      'a missing statement of the largest request',
      () => replaceOnce(readme, /at least 9,437,184 bytes/g, 'at least the import size'),
      /do not state "at least 9,437,184 bytes"/,
    ],
    ['a wrong keep-alive', () => replaceOnce(readme, /\b65 s\b/g, '75 s'), /do not state "65 s"/],
    [
      'a missing Phase D remark',
      () => replaceOnce(readme, /Bicep/g, 'templates'),
      /do not mention Bicep/,
    ],
    [
      'no Dutch section',
      () => replaceOnce(readme, /^## Nederlands$/m, '## Dutch'),
      /no Dutch section/,
    ],
    [
      'no link to the limits table',
      () => replaceOnce(readme, /limits-outside-the-repository/g, 'limits'),
      /(?:do not link to the limits table|does not resolve)/,
    ],
  ];

  it.each(NEGATIVES)('refuses %s', (_label, text, reason) => {
    expectGuardFails(
      (changed: string) => {
        assertNotesNumbers(changed, graceSeconds);
      },
      text(),
      { reason, name: 'assertNotesNumbers' },
    );
  });

  it.each([
    ['a link to a file that does not exist', '[x](missing.md)', /does not exist/],
    ['a link to a heading that does not exist', '[x](../docs/operations.md#no-such)', /no heading/],
    ['an anchor inside the page that does not exist', '[x](#nowhere)', /no heading/],
  ])('refuses %s', (_label, markdown, reason) => {
    expectGuardFails(
      (text: string) => {
        assertLinksResolve(text, 'deploy');
      },
      markdown,
      { reason, name: 'assertLinksResolve' },
    );
  });

  it('accepts links to files, to headings of other files and to its own headings', () => {
    expect(() => {
      assertLinksResolve(
        '# Title\n[a](../docs/operations.md) [b](../docs/operations.md#limits-outside-the-repository) [c](#title) [d](https://example.com/x#y)',
        'deploy',
      );
    }).not.toThrow();
  });
});

describe('deploy/caddy/Caddyfile.example (FR-A-169)', () => {
  const caddyfile = readRepositoryFile('deploy/caddy/Caddyfile.example');

  it('uses the verified directives and honours the numbers of LIMITS', () => {
    expect(() => {
      assertCaddyExample(caddyfile);
    }).not.toThrow();
  });

  it('keeps the Caddy idle timeout towards the panel below the keep-alive of the panel', () => {
    const idle = Number(/^(\d+)s$/.exec(caddyValue(caddyfile, 'keepalive') ?? '')?.[1]);
    expect(idle).toBeGreaterThan(0);
    expect(idle).toBeLessThan(seconds(LIMITS.http.keepAliveTimeoutMs));
  });

  const NEGATIVES: readonly (readonly [string, () => string, RegExp])[] = [
    [
      'a body limit below the largest request',
      () => replaceOnce(caddyfile, /max_size \d+/, 'max_size 1048576'),
      /max_size must be 9437184/,
    ],
    [
      'a body limit with a unit, whose bytes nobody can compare',
      () => replaceOnce(caddyfile, /max_size \d+/, 'max_size 10MB'),
      /plain number of bytes/,
    ],
    [
      'no body limit',
      () => dropLines(caddyfile, (line) => line.trim().startsWith('max_size')),
      /plain number of bytes/,
    ],
    [
      'the default keepalive of two minutes',
      () => replaceOnce(caddyfile, /keepalive \d+s/, 'keepalive 120s'),
      /keepalive must stay below/,
    ],
    [
      'no keepalive',
      () => dropLines(caddyfile, (line) => line.trim().startsWith('keepalive ')),
      /keepalive must be a duration/,
    ],
    [
      'no mention of TRUST_PROXY',
      () => replaceOnce(caddyfile, /TRUST_PROXY/g, 'TRUST'),
      /does not mention TRUST_PROXY/,
    ],
    [
      'no source for the directives',
      () => replaceOnce(caddyfile, /caddyserver\.com\/docs/g, 'example.com'),
      /does not cite the Caddy documentation/,
    ],
  ];

  it.each(NEGATIVES)('refuses %s', (_label, text, reason) => {
    expectGuardFails(assertCaddyExample, text(), { reason });
  });
});
