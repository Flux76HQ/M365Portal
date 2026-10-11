// Traceability: which control enforces which requirement (T-A-333, baseline section 7, SC-A-015).
//
// Everything here is a plain function over a repository root, so the test can run it on the real tree
// and on small trees written to a temporary directory (the negative fixtures). Nothing is parsed with a
// clever grammar: the spec's requirement rows are Markdown table rows, and the controls they cite are
// the back-ticked tokens (a test path with the prefix of spec section 2, a CI job, a step named in
// quotes, an ESLint rule, a command). A row that cites none of them has no automated control.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import {
  PHASE_B_DECLARATIONS,
  PHASE_B_DEPENDENCIES,
  PHASE_B_ROUTE_PATHS,
  PHASE_B_SERVER_DIRECTORIES,
  REVIEW_ONLY,
} from './phase-guard.js';

export interface TestControl {
  readonly kind: 'test';
  /** As written in the spec (`server/config.test.ts`). */
  readonly ref: string;
  /** Candidate paths relative to the root, after the prefix table; one of them must exist. */
  readonly candidates: readonly string[];
}
export interface JobControl {
  readonly kind: 'job';
  readonly name: string;
}
export interface StepControl {
  readonly kind: 'step';
  readonly job: string;
  readonly name: string;
}
export interface LintRuleControl {
  readonly kind: 'lint-rule';
  readonly rule: string;
}
export interface CommandControl {
  readonly kind: 'command';
  readonly command: string;
}
export type Control = TestControl | JobControl | StepControl | LintRuleControl | CommandControl;

export interface Requirement {
  readonly id: string;
  readonly level: string;
  readonly enforcedBy: string;
  readonly controls: readonly Control[];
}

/** The CI vocabulary of spec section 2: the names AGENTS.md cites. */
export const CI_JOBS: readonly string[] = [
  'enforce-version-bump',
  'agent-instructions-lint',
  'quality',
  'e2e',
  'image',
  'publish',
  'analyze',
];

const ROW = /^\| (FR-A-\d{3}) \| (MUST|SHOULD) \|/;

/** The prefix table of spec section 2: `server/` to `apps/server/test/`, and so on. */
export function parsePrefixTable(specText: string): ReadonlyMap<string, string> {
  const table = new Map<string, string>();
  for (const line of specText.split('\n')) {
    const match = /^\s*\| `([a-z0-9]+)\/` \| `([^`]+\/)`(?: [^|]*)? \|\s*$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) table.set(match[1], match[2]);
  }
  return table;
}

/** `a/{b,c}.ts` to `a/b.ts`, `a/c.ts` (nested braces are expanded innermost first). */
export function expandBraces(text: string): string[] {
  const match = /\{([^{}]+)\}/.exec(text);
  if (match?.[1] === undefined) return [text];
  const expanded = match[1]
    .split(',')
    .flatMap((alternative) =>
      expandBraces(
        text.slice(0, match.index) + alternative + text.slice(match.index + match[0].length),
      ),
    );
  return [...new Set(expanded)];
}

/**
 * Candidate repository paths of a test reference. `e2e/` names `e2e/tests/` in the prefix table, but the
 * spec also uses it for the files at the root of the package (`e2e/fixtures.ts`, `e2e/lighthouse/...`),
 * so both places are candidates.
 */
export function candidatePaths(ref: string, prefixes: ReadonlyMap<string, string>): string[] {
  const slash = ref.indexOf('/');
  const prefix = slash < 0 ? '' : ref.slice(0, slash);
  const rest = ref.slice(slash + 1);
  const base = prefixes.get(prefix);
  if (base === undefined) return [];
  const candidates = [`${base}${rest}`];
  if (prefix === 'e2e') candidates.push(`e2e/${rest}`);
  return candidates.flatMap((candidate) => expandBraces(candidate));
}

/** A back-ticked token that looks like a test or script file of the prefix table. */
function looksLikePath(token: string, prefixes: ReadonlyMap<string, string>): boolean {
  const slash = token.indexOf('/');
  return slash > 0 && prefixes.has(token.slice(0, slash)) && /\.[a-z]+\}?$/.test(token);
}

export function parseControls(
  enforcedBy: string,
  prefixes: ReadonlyMap<string, string>,
): Control[] {
  const controls: Control[] = [];
  // `job` step "Name" and "Other"; `job` steps "A" and "B"; `job` job step "Name"
  const stepCitation = /`([a-z-]+)`(?: job)? steps? ((?:"[^"]+"(?:,? and |, )?)+)/g;
  for (const match of enforcedBy.matchAll(stepCitation)) {
    const job = match[1];
    const names = match[2];
    if (job === undefined || names === undefined) continue;
    for (const name of names.matchAll(/"([^"]+)"/g)) {
      if (name[1] !== undefined) controls.push({ kind: 'step', job, name: name[1] });
    }
  }
  for (const match of enforcedBy.matchAll(/`([^`]+)`/g)) {
    const token = match[1]?.trim();
    if (token === undefined) continue;
    if (CI_JOBS.includes(token)) {
      controls.push({ kind: 'job', name: token });
    } else if (token.startsWith('local/')) {
      controls.push({ kind: 'lint-rule', rule: token.slice('local/'.length) });
    } else if (/^(pnpm|docker|python|node|actionlint) /.test(token)) {
      controls.push({ kind: 'command', command: token });
    } else if (looksLikePath(token, prefixes)) {
      controls.push({ kind: 'test', ref: token, candidates: candidatePaths(token, prefixes) });
    }
  }
  return controls;
}

/** Every requirement row of the spec, with the controls it cites. */
export function parseRequirements(specText: string): Requirement[] {
  const prefixes = parsePrefixTable(specText);
  const requirements: Requirement[] = [];
  for (const line of specText.split('\n')) {
    const match = ROW.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) continue;
    // The last cell: after the last ` | `, before the closing pipe (which may follow an empty cell).
    const trimmed = line.trimEnd().replace(/\|$/, '');
    const enforcedBy = trimmed.slice(trimmed.lastIndexOf(' | ') + 3).trim();
    requirements.push({
      id: match[1],
      level: match[2],
      enforcedBy,
      controls: parseControls(enforcedBy, prefixes),
    });
  }
  return requirements;
}

export interface WorkflowIndex {
  /** job key to its step names, over every workflow file. */
  readonly jobs: ReadonlyMap<string, readonly string[]>;
}

/** Job keys and step names of `.github/workflows/*.yml`, read with line patterns (no YAML parser). */
export function indexWorkflows(root: string): WorkflowIndex {
  const jobs = new Map<string, string[]>();
  const directory = join(root, '.github/workflows');
  if (!existsSync(directory)) return { jobs };
  for (const file of readdirSync(directory).filter((name) => /\.ya?ml$/.test(name))) {
    let inJobs = false;
    let current: string | undefined;
    for (const line of readFileSync(join(directory, file), 'utf8').split('\n')) {
      if (/^jobs:\s*$/.test(line)) {
        inJobs = true;
        continue;
      }
      if (/^\S/.test(line)) inJobs = false;
      if (!inJobs) continue;
      const job = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
      if (job?.[1] !== undefined) {
        current = job[1];
        if (!jobs.has(current)) jobs.set(current, []);
        continue;
      }
      const step = /^ {6}- name: (.+?)\s*$/.exec(line);
      if (step?.[1] !== undefined && current !== undefined) {
        jobs.get(current)?.push(step[1].replace(/^["']|["']$/g, ''));
      }
    }
  }
  return { jobs };
}

export interface TraceabilityOptions {
  /** Spec path relative to the root. */
  readonly spec?: string;
  /** Tasks path relative to the root. */
  readonly tasks?: string;
  /** Requirement id to the reason its control is review only. */
  readonly reviewOnly?: Readonly<Record<string, string>>;
}

export interface TraceabilityResult {
  readonly requirements: readonly Requirement[];
  readonly problems: readonly string[];
}

/** The paths of "Additional controls" (spec section 2, TA-08), as brace-expanded back-ticked tokens. */
export function additionalControlPaths(
  specText: string,
  prefixes: ReadonlyMap<string, string>,
): { ref: string; candidates: string[] }[] {
  const start = specText.indexOf('Additional controls named by tasks');
  const end = specText.indexOf('**Guard tests are tested.**');
  if (start < 0 || end < start) return [];
  const found: { ref: string; candidates: string[] }[] = [];
  for (const match of specText.slice(start, end).matchAll(/`([^`]+)`/g)) {
    const token = match[1];
    if (token === undefined) continue;
    const slash = token.indexOf('/');
    const prefix = slash < 0 ? '' : token.slice(0, slash);
    if (prefixes.has(prefix) && /\.[a-z]+\}?$/.test(token)) {
      found.push({ ref: token, candidates: candidatePaths(token, prefixes) });
    } else if (/^(tools|scripts|eslint-rules)\//.test(token) && /\.[a-z]+\}?$/.test(token)) {
      found.push({ ref: token, candidates: expandBraces(token) });
    }
  }
  return found;
}

/**
 * The traceability checks (T-A-333): every MUST names a control and that control exists; every
 * requirement is in a task. Returns the problems, empty when the tree is consistent.
 */
export function checkTraceability(
  root: string,
  options: TraceabilityOptions = {},
): TraceabilityResult {
  const specText = readFileSync(join(root, options.spec ?? 'specs/001-m365portal/spec.md'), 'utf8');
  const tasksText = readFileSync(
    join(root, options.tasks ?? 'specs/001-m365portal/tasks.md'),
    'utf8',
  );
  const reviewOnly = options.reviewOnly ?? REVIEW_ONLY;
  const prefixes = parsePrefixTable(specText);
  const requirements = parseRequirements(specText);
  const workflows = indexWorkflows(root);
  const problems: string[] = [];

  if (prefixes.size === 0) problems.push('spec: the prefix table of section 2 was not found');
  if (requirements.length === 0) problems.push('spec: no requirement row was found');

  const seen = new Set<string>();
  for (const requirement of requirements) {
    const { id } = requirement;
    if (seen.has(id)) problems.push(`${id}: defined twice`);
    seen.add(id);

    if (requirement.level === 'MUST') {
      if (requirement.enforcedBy === '') {
        problems.push(`${id}: a MUST row with an empty "Enforced by"`);
      } else if (requirement.controls.length === 0 && reviewOnly[id] === undefined) {
        problems.push(
          `${id}: a MUST row whose "Enforced by" names no control (${requirement.enforcedBy}) and is not on the review-only list`,
        );
      }
    }
    for (const control of requirement.controls) {
      if (control.kind === 'test') {
        if (control.candidates.length === 0) {
          problems.push(`${id}: ${control.ref} has no prefix in the table of spec section 2`);
        } else if (!control.candidates.some((path) => existsSync(join(root, path)))) {
          problems.push(
            `${id}: ${control.ref} does not exist (looked for ${control.candidates.join(', ')})`,
          );
        }
      } else if (control.kind === 'job') {
        if (!workflows.jobs.has(control.name)) {
          problems.push(`${id}: CI job "${control.name}" does not exist in .github/workflows`);
        }
      } else if (control.kind === 'step') {
        const steps = workflows.jobs.get(control.job);
        if (steps === undefined) {
          problems.push(`${id}: CI job "${control.job}" does not exist in .github/workflows`);
        } else if (!steps.includes(control.name)) {
          problems.push(`${id}: CI job "${control.job}" has no step named "${control.name}"`);
        }
      } else if (control.kind === 'lint-rule' && !hasLintRule(root, control.rule)) {
        problems.push(`${id}: ESLint rule local/${control.rule} does not exist in eslint-rules/`);
      }
    }
    if (!new RegExp(`\\b${id}\\b`).test(tasksText) && !coveredByRange(id, tasksText)) {
      problems.push(`${id}: appears in no task of tasks.md`);
    }
  }
  for (const id of Object.keys(reviewOnly)) {
    if (!seen.has(id)) {
      problems.push(`${id}: on the review-only list but not a requirement of the spec`);
    }
  }
  for (const extra of additionalControlPaths(specText, prefixes)) {
    if (!extra.candidates.some((path) => existsSync(join(root, path)))) {
      problems.push(`additional control ${extra.ref} (spec section 2) does not exist`);
    }
  }
  return { requirements, problems };
}

function hasLintRule(root: string, rule: string): boolean {
  const directory = join(root, 'eslint-rules/rules');
  if (!existsSync(directory)) return false;
  return readdirSync(directory).some((name) => name.replace(/\.[a-z]+$/, '') === rule);
}

/** "FR-A-040 to FR-A-049" or "FR-A-040..049" in tasks.md covers the ids in between. */
function coveredByRange(id: string, tasksText: string): boolean {
  const wanted = Number(id.slice('FR-A-'.length));
  for (const match of tasksText.matchAll(/FR-A-(\d{3})(?: to |\.\.)(?:FR-A-)?(\d{3})/g)) {
    if (match[1] === undefined || match[2] === undefined) continue;
    if (wanted >= Number(match[1]) && wanted <= Number(match[2])) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// No Phase B artefact (while phase-guard.ts says the phase is A)

const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', '.git', 'test-results', 'coverage']);

function walk(directory: string, visit: (path: string) => void): void {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (SKIP_DIRECTORIES.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path, visit);
    else visit(path);
  }
}

function isBannedDependency(name: string, banned: readonly string[]): boolean {
  return banned.some((entry) =>
    entry.endsWith('/*') ? name.startsWith(entry.slice(0, -1)) : name === entry,
  );
}

const MANIFEST_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

/** Code (not comments) of a source file: its string literals and the names it declares. */
function literalsAndDeclarations(path: string): { strings: string[]; declared: string[] } {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const strings: string[] = [];
  const declared: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      strings.push(node.text);
    }
    if (
      (ts.isClassDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isFunctionDeclaration(node)) &&
      node.name !== undefined
    ) {
      declared.push(node.name.text);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) declared.push(node.name.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { strings, declared };
}

/**
 * Phase B scope present in the tree: returns what was found, empty when clean. Looks at manifests, the
 * workspace catalogue, `apps/server/src/{auth,session,rbac,setup}`, route files of the web app, string
 * literals that register a Phase B path and declarations of Phase B clients in `apps/*` source.
 */
export function findPhaseBArtefacts(root: string): string[] {
  const found: string[] = [];
  const rel = (path: string): string => relative(root, path).split(sep).join('/');

  walk(root, (path) => {
    if (!path.endsWith(`${sep}package.json`)) return;
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    } catch {
      found.push(`${rel(path)} is not valid JSON`);
      return;
    }
    for (const field of MANIFEST_FIELDS) {
      const block = manifest[field];
      if (typeof block !== 'object' || block === null) continue;
      for (const name of Object.keys(block)) {
        if (isBannedDependency(name, PHASE_B_DEPENDENCIES)) {
          found.push(`${rel(path)} declares the Phase B dependency ${name}`);
        }
      }
    }
  });

  const catalogue = join(root, 'pnpm-workspace.yaml');
  if (existsSync(catalogue)) {
    for (const line of readFileSync(catalogue, 'utf8').split('\n')) {
      const entry = /^ {2}['"]?([^\s:'"]+)['"]?:/.exec(line);
      if (entry?.[1] !== undefined && isBannedDependency(entry[1], PHASE_B_DEPENDENCIES)) {
        found.push(`pnpm-workspace.yaml pins the Phase B dependency ${entry[1]}`);
      }
    }
  }

  for (const directory of PHASE_B_SERVER_DIRECTORIES) {
    if (existsSync(join(root, 'apps/server/src', directory))) {
      found.push(`apps/server/src/${directory} exists (Phase B)`);
    }
  }

  walk(join(root, 'apps'), (path) => {
    const fromRoot = rel(path);
    if (!fromRoot.includes('/src/') || !/\.tsx?$/.test(path) || /\.(test|spec)\./.test(path))
      return;
    const name = path.slice(path.lastIndexOf(sep) + 1);
    if (
      /^(setup|signin|login|wizard|oidc|session)[.-]/i.test(name) &&
      fromRoot.includes('/routes/')
    ) {
      found.push(`${fromRoot} is a route file of Phase B`);
    }
    if (/^(graph|exchange)[-_.]?client\./i.test(name)) {
      found.push(`${fromRoot} is a Graph or Exchange client`);
    }
    const { strings, declared } = literalsAndDeclarations(path);
    for (const literal of strings) {
      if (
        PHASE_B_ROUTE_PATHS.some((banned) => literal === banned || literal.startsWith(`${banned}/`))
      ) {
        found.push(`${fromRoot} mentions the Phase B path "${literal}" in code`);
      }
    }
    for (const declaration of declared) {
      if (PHASE_B_DECLARATIONS.includes(declaration)) {
        found.push(`${fromRoot} declares ${declaration} (Phase B)`);
      }
    }
  });
  return [...new Set(found)].sort();
}
