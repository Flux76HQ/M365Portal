// SINGLE-IMPLEMENTATION GUARD (FR-A-008; baseline section 10, "One normaliser per displayed value";
// tasks.md T-A-005).
//
// The defect this file guards against is "a second function exists". Two implementations of how a
// value is spelled do not fail loudly: they disagree quietly, on one row, months later. So the
// assertion is on SOURCE and fails on the PRESENCE of a second definition; it never compares outputs.
//
// Every value that is shown to a person is normalised by exactly one function, and it lives in
// packages/shared/src: the organisation name and its short-name cut, the accent colour and the
// tokens derived from it, contrast arithmetic, initials, monogram glyphs, the logo plate rule, the
// locale tag, the problem-code message key and the permission catalogue. The table CONCEPTS below
// is the list. It names, per concept, the identifiers that may be defined once and the module that
// is their only home.
//
// What is scanned, and how
//   - OUTSIDE packages/shared/src: every code file (ts, tsx, mts, cts, js, jsx, mjs, cjs) that is not
//     a test and not documentation. That includes packages/shared/scripts, e2e helpers, tools, build
//     scripts and root configuration. For each file the TypeScript parser (not a text search, so
//     comments, strings and look-alike identifiers are left alone) finds
//       1. a definition by name: function, class, enum, variable with a function, class, array,
//          object or `new` initialiser (or a call that is handed one), method, or object member. An
//          alias (`const x = shared.x`), an import and a re-export are not definitions;
//       2. a tell-tale re-implementation: Intl.Segmenter, a regular expression that takes a colour
//          value apart or validates it whole (`^#rrggbb$`, `#rgb` expansion; a pattern that
//          SEARCHES text for colours, like the no-raw-colour lint rule's, is a recogniser and is
//          left alone), WCAG or OKLab constants, a navigator.language(s) read that is not handed
//          to detectLocale, a catalogue key built by hand (`problem.${code}`), a list of four or
//          more permission names.
//   - INSIDE packages/shared/src: each name is defined at most once, in its home module. Zero
//     definitions is fine (the module has not landed yet; the stubs of T-A-002 are `export {};`).
//
// A surface that genuinely needs a different answer needs a documented reason, not a local copy
// (baseline section 10). EXEMPTIONS is that record. It is empty, it only ever excuses a tell-tale
// (never a definition by name), every entry needs a reason, and an entry that is no longer needed
// fails the test so the list cannot rot. Add one by asking stream S0 or the owner, not by editing
// around the guard. The case to expect: a server step that must weigh PNG pixels with the WCAG
// constants for the stored luminance of a logo (plan section 8, step 8). Prefer a shared helper
// over an exemption.
//
// To add a concept: add a row to CONCEPTS (identifiers, home module, tell-tales) and, if FR-A-008
// grows, its words to FR_A_008_WORDS. The table tests and the data-driven tests pick it up.
//
// This is a coarse net, not a proof. It does not follow renamed imports, `export { local as name }`,
// assignments after declaration, code inside HTML files or generated strings. The unit tests of
// each module (org-name, accent, ...) are what check the behaviour; this file checks that there is
// one place for it to live.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { expectGuardFails } from '../src/testing/index.js';

type Tree = ReadonlyMap<string, string>;
type Check = (tree: Tree) => string[];

// ---------------------------------------------------------------------------------------------
// The real tree
// ---------------------------------------------------------------------------------------------

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));
const fixtureDirectory = fileURLToPath(
  new URL('./fixtures/single-implementation/', import.meta.url),
);

/** Never read: dependencies, build output, caches and version control. */
const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  '.git',
  'coverage',
  'playwright-report',
  'test-results',
  'blob-report',
  '.vite',
  '.turbo',
  '.worktrees',
]);
const CODE_FILE = /\.[cm]?[jt]sx?$/;
const MAX_FILE_BYTES = 1_000_000;

const SHARED_SRC = 'packages/shared/src/';
const DOCUMENTATION_DIRECTORIES = ['docs/', 'specs/'];

function walk(directory: string, prefix: string, found: Map<string, string>): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name))
        walk(join(directory, entry.name), `${path}/`, found);
    } else if (entry.isFile() && CODE_FILE.test(entry.name)) {
      const text = readFileSync(join(directory, entry.name), 'utf8');
      found.set(path, text.length > MAX_FILE_BYTES ? '' : text);
    }
  }
}

function loadTree(): Tree {
  const found = new Map<string, string>();
  walk(repositoryRoot, '', found);
  return found;
}

/** A fixture file is `mount: <path>` on the first line, then the content of the file to mount. */
function mountFixture(tree: Tree, fixture: string): Tree {
  const text = readFileSync(join(fixtureDirectory, fixture), 'utf8');
  const newline = text.indexOf('\n');
  const header = text.slice(0, newline);
  if (!header.startsWith('mount: '))
    throw new Error(`${fixture}: first line must be "mount: <path>"`);
  const path = header.slice('mount: '.length).trim();
  return new Map([...tree, [path, text.slice(newline + 1)]]);
}

function withFile(tree: Tree, path: string, content: string): Tree {
  return new Map([...tree, [path, content]]);
}

// ---------------------------------------------------------------------------------------------
// What is in scope
// ---------------------------------------------------------------------------------------------

/**
 * Tests, fixtures and test helpers: they name the things they test on purpose. This is the same
 * definition as in repo-conventions.test.ts, so both guards agree on what a test is.
 */
function isTestPath(path: string): boolean {
  return (
    /(^|\/)(?:test|tests|__tests__|fixtures)\//.test(path) ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path) ||
    /(^|\/)test_[^/]*\.py$/.test(path)
  );
}

/** A declaration file cannot hold an implementation. */
function isCode(path: string): boolean {
  return CODE_FILE.test(path) && !/\.d\.[cm]?ts$/.test(path);
}

function isSharedScope(path: string): boolean {
  return isCode(path) && path.startsWith(SHARED_SRC) && !isTestPath(path);
}

function isOutsideScope(path: string): boolean {
  return (
    isCode(path) &&
    !path.startsWith(SHARED_SRC) &&
    !isTestPath(path) &&
    !DOCUMENTATION_DIRECTORIES.some((directory) => path.startsWith(directory))
  );
}

// ---------------------------------------------------------------------------------------------
// The table: concepts and their only home
// ---------------------------------------------------------------------------------------------

type TellTale =
  | 'grapheme-segmentation'
  | 'hex-expansion'
  | 'oklab-matrix'
  | 'wcag-coefficients'
  | 'language-reader'
  | 'problem-key'
  | 'permission-list';

const TELL_TALES: Readonly<Record<TellTale, string>> = {
  'grapheme-segmentation':
    'Intl.Segmenter outside packages/shared: graphemes of a name are cut and counted by the shared name and initials modules only',
  'hex-expansion':
    'hex colour pattern outside packages/shared: accent hex normalisation exists once, as normalizeAccent',
  'oklab-matrix':
    'OKLab matrix constant outside packages/shared: accent tokens are derived once, by deriveAccentTokens',
  'wcag-coefficients':
    'WCAG luminance constant outside packages/shared: relative luminance and contrast exist once, in branding/contrast',
  'language-reader':
    'navigator language read that is not handed to detectLocale(...): locale tags are normalised once, by detectLocale',
  'problem-key':
    'problem catalogue key built by hand: problem codes map to messages once, through problemMessageKey',
  'permission-list':
    'list of permission names outside packages/shared: the catalogue is PERMISSIONS (a single name or a short any-of list is fine)',
};
const TELL_TALE_IDS = Object.keys(TELL_TALES) as TellTale[];

interface Concept {
  /** Short stable id, used in messages. */
  readonly id: string;
  /** The words of FR-A-008 this concept answers for (the table must cover all of them). */
  readonly fr008: readonly string[];
  /** Identifiers defined at most once in packages/shared/src, and never outside it. */
  readonly names: readonly string[];
  /** The only module that may define them. */
  readonly home: string;
  /** Re-implementations to look for outside packages/shared/src. */
  readonly tellTales: readonly TellTale[];
}

const CONCEPTS: readonly Concept[] = [
  {
    id: 'org-name',
    fr008: ['organisation-name normalisation', 'short-name cut'],
    names: ['normalizeOrgName', 'shortOrgName'],
    home: `${SHARED_SRC}branding/org-name.ts`,
    tellTales: ['grapheme-segmentation'],
  },
  {
    id: 'accent',
    fr008: ['accent hex normalisation'],
    names: ['normalizeAccent', 'deriveAccentTokens'],
    home: `${SHARED_SRC}branding/accent.ts`,
    tellTales: ['hex-expansion', 'oklab-matrix'],
  },
  {
    // The names of these helpers are not fixed by the spec (T-A-122 says "the contrast helpers"):
    // these are the ones a second WCAG implementation would plausibly carry. The constants of the
    // tell-tale catch the rest.
    id: 'contrast',
    fr008: [],
    names: [
      'relativeLuminance',
      'contrastRatio',
      'wcagContrast',
      'wcagLuminance',
      'getRelativeLuminance',
      'getContrastRatio',
    ],
    home: `${SHARED_SRC}branding/contrast.ts`,
    tellTales: ['wcag-coefficients'],
  },
  {
    id: 'initials',
    fr008: ['initials'],
    names: ['deriveInitials'],
    home: `${SHARED_SRC}branding/initials.ts`,
    tellTales: ['grapheme-segmentation'],
  },
  {
    id: 'monogram',
    fr008: ['monogram glyph mapping'],
    names: ['monogramGlyphs'],
    home: `${SHARED_SRC}branding/monogram.ts`,
    tellTales: [],
  },
  {
    id: 'logo-plate',
    fr008: [],
    names: ['logoPlateFor'],
    home: `${SHARED_SRC}branding/logo-plate.ts`,
    tellTales: [],
  },
  {
    id: 'locale',
    fr008: ['locale-tag normalisation'],
    names: ['detectLocale'],
    home: `${SHARED_SRC}i18n/detect.ts`,
    tellTales: ['language-reader'],
  },
  {
    id: 'problem',
    fr008: ['problem-code to message mapping'],
    names: ['problemMessageKey'],
    home: `${SHARED_SRC}problem.ts`,
    tellTales: ['problem-key'],
  },
  {
    id: 'permissions',
    fr008: ['permission catalogue'],
    names: ['PERMISSIONS', 'hasAnyPermission'],
    home: `${SHARED_SRC}permissions.ts`,
    tellTales: ['permission-list'],
  },
];

const CONCEPT_BY_NAME = new Map<string, Concept>(
  CONCEPTS.flatMap((concept) => concept.names.map((name) => [name, concept] as const)),
);

/** The words FR-A-008 uses, each with the pattern that proves the spec row still says it. */
const FR_A_008_WORDS: readonly (readonly [string, RegExp])[] = [
  ['organisation-name normalisation', /organisation-name normalisation/i],
  ['short-name cut', /short-name cut/i],
  ['accent hex normalisation', /accent hex normalisation/i],
  ['initials', /\binitials\b/i],
  ['monogram glyph mapping', /monogram glyph mapping/i],
  ['locale-tag normalisation', /locale-tag normalisation/i],
  ['problem-code to message mapping', /problem-code to message mapping/i],
  ['permission catalogue', /permission catalogue/i],
];

/** The identifiers T-A-005 itself lists (the contrast row stands for "relative luminance and contrast helpers"). */
const TASK_LISTED_NAMES = [
  'normalizeOrgName',
  'shortOrgName',
  'normalizeAccent',
  'deriveAccentTokens',
  'deriveInitials',
  'monogramGlyphs',
  'logoPlateFor',
  'detectLocale',
  'problemMessageKey',
  'PERMISSIONS',
  'hasAnyPermission',
];

/** `@m365portal/shared/branding/org-name` for `packages/shared/src/branding/org-name.ts`. */
function importPathOf(home: string): string {
  return `@m365portal/shared/${home.slice(SHARED_SRC.length).replace(/\.ts$/, '')}`;
}

// ---------------------------------------------------------------------------------------------
// Exemptions: a documented reason, not a local copy
// ---------------------------------------------------------------------------------------------

interface Exemption {
  /** Repository-relative path of the file that is excused. */
  readonly path: string;
  /** Which tell-tale it is excused from. A definition by name can never be excused. */
  readonly tellTale: TellTale;
  /** Why this surface needs its own arithmetic and cannot call the shared function. */
  readonly reason: string;
}

/** Empty on purpose: nothing needed an exemption when this file was written. */
const EXEMPTIONS: readonly Exemption[] = [];
const MIN_REASON_LENGTH = 40;

// ---------------------------------------------------------------------------------------------
// Reading a source file
// ---------------------------------------------------------------------------------------------

interface Hit {
  readonly line: number;
  readonly detail: string;
}

interface Definition {
  readonly name: string;
  readonly kind: string;
  readonly line: number;
}

interface Facts {
  readonly definitions: readonly Definition[];
  readonly tellTales: Readonly<Record<TellTale, readonly Hit[]>>;
}

function emptyTellTales(): Record<TellTale, Hit[]> {
  return {
    'grapheme-segmentation': [],
    'hex-expansion': [],
    'oklab-matrix': [],
    'wcag-coefficients': [],
    'language-reader': [],
    'problem-key': [],
    'permission-list': [],
  };
}

function scriptKindOf(path: string): ts.ScriptKind {
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (path.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

const factCache = new Map<string, Facts>();

/** Facts about one file. Cached by content: the same text always gives the same answer. */
function factsOf(path: string, text: string): Facts {
  const kind = scriptKindOf(path);
  const key = `${String(kind)}\u0000${text}`;
  let facts = factCache.get(key);
  if (facts === undefined) {
    facts = analyse(path, text, kind);
    factCache.set(key, facts);
  }
  return facts;
}

// --- definitions by name ---------------------------------------------------------------------

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isFunctionOrLiteral(expression: ts.Expression): boolean {
  const value = unwrap(expression);
  return (
    ts.isArrowFunction(value) ||
    ts.isFunctionExpression(value) ||
    ts.isArrayLiteralExpression(value) ||
    ts.isObjectLiteralExpression(value)
  );
}

/**
 * Does this initialiser carry an implementation or a list, as opposed to naming one that exists?
 * `const x = shared.x` and `const y = shared.y(1)` are not implementations; `const x = (a) => a`,
 * `const x = [..]`, `new Set([..])` and `memoize((a) => a)` are.
 */
function isImplementation(initializer: ts.Expression): boolean {
  const value = unwrap(initializer);
  if (isFunctionOrLiteral(value) || ts.isClassExpression(value) || ts.isNewExpression(value)) {
    return true;
  }
  return ts.isCallExpression(value) && value.arguments.some(isFunctionOrLiteral);
}

function isAmbient(declaration: ts.Declaration): boolean {
  return (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Ambient) !== 0;
}

function nameText(name: ts.Node | undefined): string | undefined {
  if (name === undefined) return undefined;
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : undefined;
}

function definitionOf(node: ts.Node, source: ts.SourceFile): Definition | undefined {
  let name: string | undefined;
  let kind: string;
  if (ts.isFunctionDeclaration(node)) {
    if (node.body === undefined || isAmbient(node)) return undefined;
    [name, kind] = [nameText(node.name), 'function'];
  } else if (ts.isClassDeclaration(node)) {
    if (isAmbient(node)) return undefined;
    [name, kind] = [nameText(node.name), 'class'];
  } else if (ts.isEnumDeclaration(node)) {
    if (isAmbient(node)) return undefined;
    [name, kind] = [nameText(node.name), 'enum'];
  } else if (ts.isVariableDeclaration(node)) {
    if (node.initializer === undefined || !isImplementation(node.initializer) || isAmbient(node)) {
      return undefined;
    }
    [name, kind] = [nameText(node.name), 'variable'];
  } else if (ts.isMethodDeclaration(node)) {
    if (node.body === undefined) return undefined;
    [name, kind] = [nameText(node.name), 'method'];
  } else if (ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node)) {
    if (node.initializer === undefined || !isImplementation(node.initializer)) return undefined;
    [name, kind] = [nameText(node.name), 'property'];
  } else {
    return undefined;
  }
  if (name === undefined || !CONCEPT_BY_NAME.has(name)) return undefined;
  return { name, kind, line: lineOf(source, node) };
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

// --- tell-tale re-implementations ------------------------------------------------------------

/** sRGB/WCAG constants: the weights of red, green and blue, and the two linearisation thresholds. */
const WCAG_CONSTANTS = new Set([0.2126, 0.7152, 0.0722, 0.03928, 0.04045]);
/** The first row of the OKLab matrices (and a few more), which nothing else in the product needs. */
const OKLAB_CONSTANTS = new Set([
  0.4122214708, 0.5363325363, 0.0514459929, 0.2104542553, 0.793617785, 0.0040720468,
]);

/** A character class that spells hexadecimal digits: `[0-9a-f]`, `[a-fA-F\d]`, `[\da-f]`, ... */
const HEX_CLASS = /\[(?=[^\]]*(?:0-9|\\d))(?=[^\]]*[aA]-[fF])[^\]]*\]/g;
/** `(.)(.)(.)`, `(\w)(\w)(\w)`, `([a-f\d])([a-f\d])([a-f\d])`: a pattern that takes #rgb apart. */
const THREE_SINGLE_GROUPS = /(?:\((?:\.|\\[wWdDsS]|\[[^\]]+\])\)){3}/;
/** The widths of a colour: 3 (rgb), 4 (rgba), 6 (rrggbb) or 8 (rrggbbaa) digits, or a range. */
const COLOUR_WIDTH = /\{(?:3|4|6|8)(?:,\d+)?\}/;

/**
 * Does the pattern take a colour VALUE apart or validate it as a whole? That is what a second accent
 * normaliser does: it expands #rgb (three single-character groups) or checks `^#rrggbb$`.
 *
 * A pattern that SEARCHES for colours inside larger text is a recogniser, not a normaliser, and is
 * left alone: the no-raw-colour lint rule finds `#rrggbb` in source code with a lookbehind and a
 * lookahead and normalises nothing. The difference is the anchor at the start of the pattern.
 */
function looksLikeHexColourPattern(pattern: string): boolean {
  if (!pattern.includes('#')) return false;
  if (THREE_SINGLE_GROUPS.test(pattern)) return true;
  if (!pattern.startsWith('^')) return false;
  const hexClasses = pattern.match(HEX_CLASS)?.length ?? 0;
  return hexClasses > 0 && (hexClasses >= 3 || COLOUR_WIDTH.test(pattern));
}

/** `/body/flags` to `body`. */
function regexBody(literal: string): string {
  return literal.slice(1, literal.lastIndexOf('/'));
}

function isIntl(expression: ts.Expression): boolean {
  return (
    (ts.isIdentifier(expression) && expression.text === 'Intl') ||
    (ts.isPropertyAccessExpression(expression) && expression.name.text === 'Intl')
  );
}

const NAVIGATOR_LANGUAGE_PROPERTIES = new Set(['languages', 'language', 'userLanguage']);

function isNavigatorLanguage(node: ts.Node): boolean {
  if (!ts.isPropertyAccessExpression(node)) return false;
  if (!NAVIGATOR_LANGUAGE_PROPERTIES.has(node.name.text)) return false;
  const owner = node.expression;
  return (
    (ts.isIdentifier(owner) && owner.text === 'navigator') ||
    (ts.isPropertyAccessExpression(owner) && owner.name.text === 'navigator')
  );
}

function calleeName(callee: ts.Expression): string {
  if (ts.isIdentifier(callee)) return callee.text;
  return ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
}

/** Is the node somewhere inside an argument of a call to `detectLocale(...)`? */
function isPassedToDetectLocale(node: ts.Node): boolean {
  for (let current = node; !ts.isSourceFile(current); current = current.parent) {
    const parent = current.parent;
    if (
      ts.isCallExpression(parent) &&
      parent.expression !== current &&
      calleeName(parent.expression) === 'detectLocale'
    ) {
      return true;
    }
  }
  return false;
}

/** The resource part of the catalogue of brief 2a (`users:read`, `settings:branding`, ...). */
const PERMISSION_NAME =
  /^(?:users|groups|distributionlists|contacts|audit|settings|rbac)(?::[a-z]+){1,2}$/;
/** A single name or a short any-of list is normal use; the catalogue has 15. */
const PERMISSION_LIST_MIN = 4;

function permissionNamesIn(node: ts.ArrayLiteralExpression | ts.ObjectLiteralExpression): number {
  const found = new Set<string>();
  const consider = (candidate: ts.Node | undefined): void => {
    if (candidate !== undefined && ts.isStringLiteralLike(candidate)) {
      if (PERMISSION_NAME.test(candidate.text)) found.add(candidate.text);
    }
  };
  if (ts.isArrayLiteralExpression(node)) {
    for (const element of node.elements) consider(element);
  } else {
    for (const property of node.properties) {
      if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) {
        consider(property.name);
      }
    }
  }
  return found.size;
}

function noteTellTales(node: ts.Node, source: ts.SourceFile, found: Record<TellTale, Hit[]>): void {
  const note = (tellTale: TellTale, detail: string): void => {
    found[tellTale].push({ line: lineOf(source, node), detail });
  };

  if (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === 'Segmenter' &&
    isIntl(node.expression)
  ) {
    note('grapheme-segmentation', 'Intl.Segmenter');
  }

  if (ts.isNumericLiteral(node)) {
    const value = Number(node.text);
    if (WCAG_CONSTANTS.has(value)) note('wcag-coefficients', node.text);
    if (OKLAB_CONSTANTS.has(value)) note('oklab-matrix', node.text);
  }

  if (ts.isRegularExpressionLiteral(node)) {
    const body = regexBody(node.text);
    if (looksLikeHexColourPattern(body)) note('hex-expansion', `/${body}/`);
  }
  if (
    (ts.isNewExpression(node) || ts.isCallExpression(node)) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'RegExp'
  ) {
    const first = node.arguments?.[0];
    if (
      first !== undefined &&
      ts.isStringLiteralLike(first) &&
      looksLikeHexColourPattern(first.text)
    ) {
      note('hex-expansion', `new RegExp('${first.text}')`);
    }
  }

  if (isNavigatorLanguage(node) && !isPassedToDetectLocale(node)) {
    note('language-reader', (node as ts.PropertyAccessExpression).getText(source));
  }

  if (ts.isTemplateExpression(node) && /(?:^|\W)problem\.$/.test(node.head.text)) {
    note('problem-key', '`problem.${...}`');
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
    ts.isStringLiteralLike(node.left) &&
    /(?:^|\W)problem\.$/.test(node.left.text)
  ) {
    note('problem-key', "'problem.' + ...");
  }

  if (ts.isArrayLiteralExpression(node) || ts.isObjectLiteralExpression(node)) {
    const count = permissionNamesIn(node);
    if (count >= PERMISSION_LIST_MIN) note('permission-list', `${String(count)} permission names`);
  }
}

function analyse(path: string, text: string, kind: ts.ScriptKind): Facts {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  const definitions: Definition[] = [];
  const tellTales = emptyTellTales();
  const visit = (node: ts.Node): void => {
    const definition = definitionOf(node, source);
    if (definition !== undefined) definitions.push(definition);
    noteTellTales(node, source, tellTales);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { definitions, tellTales };
}

// ---------------------------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------------------------

interface Report {
  readonly definitions: string[];
  readonly tellTales: string[];
  readonly homes: string[];
  readonly exemptions: string[];
}

function homesOf(tellTale: TellTale): string {
  const concepts = CONCEPTS.filter((concept) => concept.tellTales.includes(tellTale));
  return concepts.map((concept) => concept.home).join(', ');
}

function scan(tree: Tree, exemptions: readonly Exemption[] = EXEMPTIONS): Report {
  const report: Report = { definitions: [], tellTales: [], homes: [], exemptions: [] };
  const paths = [...tree.keys()].sort();
  const excused = new Set(
    exemptions.map((exemption) => `${exemption.path}\u0000${exemption.tellTale}`),
  );

  // Outside packages/shared/src: no definition of a table name, no tell-tale.
  for (const path of paths.filter(isOutsideScope)) {
    const facts = factsOf(path, tree.get(path) ?? '');
    for (const definition of facts.definitions) {
      const concept = CONCEPT_BY_NAME.get(definition.name);
      if (concept === undefined) continue;
      report.definitions.push(
        `${path}:${String(definition.line)}: second definition of ${definition.name} (${definition.kind}); the one implementation is ${concept.home}, import it from ${importPathOf(concept.home)} (FR-A-008)`,
      );
    }
    for (const tellTale of TELL_TALE_IDS) {
      if (excused.has(`${path}\u0000${tellTale}`)) continue;
      for (const hit of facts.tellTales[tellTale]) {
        report.tellTales.push(
          `${path}:${String(hit.line)}: ${TELL_TALES[tellTale]} [${tellTale}: ${hit.detail}]; see ${homesOf(tellTale)} (FR-A-008)`,
        );
      }
    }
  }

  // Inside packages/shared/src: at most one definition per name, and in its home.
  const insideShared = new Map<string, { path: string; line: number }[]>();
  for (const path of paths.filter(isSharedScope)) {
    for (const definition of factsOf(path, tree.get(path) ?? '').definitions) {
      const list = insideShared.get(definition.name) ?? [];
      list.push({ path, line: definition.line });
      insideShared.set(definition.name, list);
    }
  }
  for (const [name, definitions] of insideShared) {
    const concept = CONCEPT_BY_NAME.get(name);
    if (concept === undefined) continue;
    for (const definition of definitions) {
      if (definition.path === concept.home) continue;
      report.homes.push(
        `${definition.path}:${String(definition.line)}: ${name} is defined here, but its one home is ${concept.home} (FR-A-008)`,
      );
    }
    const inHome = definitions.filter((definition) => definition.path === concept.home);
    if (inHome.length > 1) {
      report.homes.push(
        `${concept.home}: ${name} is defined ${String(inHome.length)} times (lines ${inHome.map((definition) => String(definition.line)).join(', ')}); it must be defined once (FR-A-008)`,
      );
    }
  }

  // The exemption list itself must stay honest.
  for (const exemption of exemptions) {
    const label = `exemption ${exemption.path} [${exemption.tellTale}]`;
    if (exemption.reason.trim().length < MIN_REASON_LENGTH) {
      report.exemptions.push(
        `${label}: give a reason of at least ${String(MIN_REASON_LENGTH)} characters, saying why this surface cannot call the shared function (baseline section 10)`,
      );
    }
    const text = tree.get(exemption.path);
    if (text === undefined || !isOutsideScope(exemption.path)) {
      report.exemptions.push(
        `${label}: not a scanned file (missing, a test, documentation or inside packages/shared/src)`,
      );
    } else if (factsOf(exemption.path, text).tellTales[exemption.tellTale].length === 0) {
      report.exemptions.push(
        `${label}: stale, the file no longer shows this tell-tale; remove the exemption`,
      );
    }
  }
  return report;
}

const checkSecondDefinitions: Check = (tree) => scan(tree).definitions;
const checkReimplementations: Check = (tree) => scan(tree).tellTales;
const checkHomes: Check = (tree) => scan(tree).homes;
const checkExemptions: Check = (tree) => scan(tree).exemptions;
const checkAll: Check = (tree) => {
  const report = scan(tree);
  return [...report.definitions, ...report.tellTales, ...report.homes, ...report.exemptions];
};

function asGuard(check: Check): (tree: Tree) => void {
  return (tree) => {
    const problems = check(tree);
    if (problems.length > 0) throw new Error(problems.join('\n'));
  };
}

const realTree = loadTree();

/** Problems of `check` that are about `path` only. */
function problemsAt(check: Check, tree: Tree, path: string): string[] {
  return check(tree).filter((problem) => problem.startsWith(path));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Patterns of the `exports` map of packages/shared, as regular expressions on `./src/...` paths. */
function exportedFilePatterns(): RegExp[] {
  const manifest: unknown = JSON.parse(
    readFileSync(join(repositoryRoot, 'packages/shared/package.json'), 'utf8'),
  );
  const exportsMap = isRecord(manifest) && isRecord(manifest.exports) ? manifest.exports : {};
  const patterns: RegExp[] = [];
  for (const entry of Object.values(exportsMap)) {
    const target = isRecord(entry) ? entry.default : entry;
    if (typeof target !== 'string') continue;
    const escaped = target.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.+');
    patterns.push(new RegExp(`^${escaped}$`));
  }
  return patterns;
}

// ---------------------------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------------------------

const CHECKS: readonly (readonly [string, Check])[] = [
  ['1 no second definition of a table name outside packages/shared/src', checkSecondDefinitions],
  ['2 no tell-tale re-implementation outside packages/shared/src', checkReimplementations],
  ['3 each name is defined at most once, in its home module', checkHomes],
  ['4 the exemption list is honest', checkExemptions],
];

describe('single implementation: the real tree', () => {
  it('reads a tree that is big enough to mean something (the scan cannot silently shrink)', () => {
    const outside = [...realTree.keys()].filter(isOutsideScope);
    for (const path of [
      'apps/server/src/index.ts',
      'apps/web/src/main.tsx',
      'e2e/playwright.config.ts',
      'vitest.config.ts',
      'eslint.config.js',
    ]) {
      expect(outside, path).toContain(path);
    }
    expect(outside.length).toBeGreaterThan(15);

    const inside = [...realTree.keys()].filter(isSharedScope);
    for (const path of CONCEPTS.map((concept) => concept.home).filter((home) =>
      realTree.has(home),
    )) {
      expect(inside, path).toContain(path);
    }
    expect(inside).toContain(`${SHARED_SRC}index.ts`);
  });

  it('does not scan tests, fixtures, documentation or declaration files', () => {
    expect(isOutsideScope('apps/web/test/router.test.tsx')).toBe(false);
    expect(isOutsideScope('apps/server/test/helpers/test-app.ts')).toBe(false);
    expect(isOutsideScope('e2e/tests/smoke.spec.ts')).toBe(false);
    expect(isOutsideScope('apps/web/src/components/button.test.tsx')).toBe(false);
    expect(isOutsideScope('packages/shared/test/org-name.test.ts')).toBe(false);
    expect(isOutsideScope('docs/example.ts')).toBe(false);
    expect(isOutsideScope('specs/001-m365portal/prototype.js')).toBe(false);
    expect(isOutsideScope('apps/web/src/env.d.ts')).toBe(false);
    expect(isOutsideScope(`${SHARED_SRC}branding/org-name.ts`)).toBe(false);
    expect(isOutsideScope('packages/shared/scripts/gen-glyphs.ts')).toBe(true);
    expect(isOutsideScope('apps/web/build/make-sw.mjs')).toBe(true);
    expect(isOutsideScope('apps/server/src/branding/pipeline/icons.ts')).toBe(true);
  });

  it.each(CHECKS)('check %s reports nothing', (_name, check) => {
    expect(check(realTree)).toEqual([]);
  });
});

describe('single implementation: the table', () => {
  it('has a row for every concept FR-A-008 names, and the spec row still says them', () => {
    const spec = readFileSync(join(repositoryRoot, 'specs/001-m365portal/spec.md'), 'utf8');
    const row = spec.split(/\r?\n/).find((line) => line.startsWith('| FR-A-008 |'));
    expect(row, 'the FR-A-008 row of specs/001-m365portal/spec.md').toBeDefined();

    const claimed = new Set(CONCEPTS.flatMap((concept) => concept.fr008));
    for (const [word, pattern] of FR_A_008_WORDS) {
      expect(row, `FR-A-008 no longer mentions "${word}": update the table to follow it`).toMatch(
        pattern,
      );
      expect(claimed.has(word), `no row of the table answers for "${word}"`).toBe(true);
    }
    for (const word of claimed) {
      expect(
        FR_A_008_WORDS.some(([known]) => known === word),
        `"${word}" is claimed by a row but is not one of the FR-A-008 words`,
      ).toBe(true);
    }
  });

  it('lists every identifier T-A-005 names, plus the contrast helpers', () => {
    const known = new Set(CONCEPTS.flatMap((concept) => concept.names));
    for (const name of TASK_LISTED_NAMES) expect(known.has(name), name).toBe(true);
    const contrast = CONCEPTS.find((concept) => concept.id === 'contrast');
    expect(contrast?.names).toEqual(expect.arrayContaining(['relativeLuminance', 'contrastRatio']));
  });

  it('gives every name to exactly one concept and every concept its own home', () => {
    const names = CONCEPTS.flatMap((concept) => concept.names);
    expect(new Set(names).size).toBe(names.length);
    expect(CONCEPT_BY_NAME.size).toBe(names.length);
    const homes = CONCEPTS.map((concept) => concept.home);
    expect(new Set(homes).size).toBe(homes.length);
    for (const concept of CONCEPTS) expect(concept.names.length, concept.id).toBeGreaterThan(0);
    expect(new Set(CONCEPTS.map((concept) => concept.id)).size).toBe(CONCEPTS.length);
  });

  it('names homes that packages/shared really exports (a typo would make the home check vacuous)', () => {
    const patterns = exportedFilePatterns();
    expect(patterns.length).toBeGreaterThan(5);
    for (const concept of CONCEPTS) {
      expect(concept.home.startsWith(SHARED_SRC), concept.home).toBe(true);
      expect(concept.home.endsWith('.ts'), concept.home).toBe(true);
      const relative = `./${concept.home.slice('packages/shared/'.length)}`;
      expect(
        patterns.some((pattern) => pattern.test(relative)),
        `${concept.home} is not reachable through the exports map of packages/shared`,
      ).toBe(true);
    }
  });

  it('uses every tell-tale in some row, so none of them is dead weight', () => {
    const used = new Set(CONCEPTS.flatMap((concept) => concept.tellTales));
    expect([...used].sort()).toEqual([...TELL_TALE_IDS].sort());
  });
});

describe('single implementation: the detector bites on every row of the table', () => {
  const NAMES = CONCEPTS.flatMap((concept) =>
    concept.names.map((name) => [concept.id, name, concept.home] as const),
  );

  it.each(NAMES)('%s: a function named %s in apps/web/src fails', (_id, name, home) => {
    const tree = withFile(
      realTree,
      'apps/web/src/lib/second.ts',
      `export function ${name}(): void {}\n`,
    );
    expectGuardFails(asGuard(checkSecondDefinitions), tree, {
      name,
      reason: new RegExp(
        `apps/web/src/lib/second\\.ts:1: second definition of ${name} \\(function\\); the one implementation is ${home.replace(/\./g, '\\.')}`,
      ),
    });
  });

  it.each(NAMES)('%s: a constant named %s in apps/server/src fails', (_id, name) => {
    const tree = withFile(
      realTree,
      'apps/server/src/second.ts',
      `export const ${name} = (): void => undefined;\n`,
    );
    expectGuardFails(asGuard(checkSecondDefinitions), tree, {
      name,
      reason: new RegExp(
        `apps/server/src/second\\.ts:1: second definition of ${name} \\(variable\\)`,
      ),
    });
  });

  it.each(NAMES)('%s: %s defined once in its home is accepted', (_id, name, home) => {
    const tree = withFile(realTree, home, `export function ${name}(): void {}\n`);
    expect(problemsAt(checkAll, tree, home)).toEqual([]);
  });

  it.each(NAMES)(
    '%s: %s defined in the home and in another shared module fails',
    (_id, name, home) => {
      const tree = withFile(
        withFile(realTree, home, `export function ${name}(): void {}\n`),
        `${SHARED_SRC}schemas/elsewhere.ts`,
        `export const ${name} = (): void => undefined;\n`,
      );
      expectGuardFails(asGuard(checkHomes), tree, {
        name,
        reason: `schemas/elsewhere.ts:1: ${name} is defined here, but its one home is ${home}`,
      });
    },
  );

  const SAMPLES: Readonly<Record<TellTale, string>> = {
    'grapheme-segmentation':
      'export const cut = (n: string) => [...new Intl.Segmenter().segment(n)].slice(0, 12);\n',
    'hex-expansion':
      "export const expand = (h: string) => h.replace(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i, '#$1$1$2$2$3$3');\n",
    'oklab-matrix':
      'export const l = (r: number, g: number, b: number) => 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;\n',
    'wcag-coefficients':
      'export const y = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;\n',
    'language-reader': "export const lang = navigator.languages.find((l) => l.startsWith('nl'));\n",
    'problem-key': 'export const key = (code: string) => `problem.${code}`;\n',
    'permission-list':
      "export const all = ['users:read', 'groups:read', 'contacts:read', 'audit:read'];\n",
  };

  it.each(Object.entries(SAMPLES) as [TellTale, string][])(
    'the tell-tale %s fails in the web package, the server package and an e2e helper',
    (tellTale, sample) => {
      for (const path of ['apps/web/src/lib/x.ts', 'apps/server/src/x.ts', 'e2e/lib/x.ts']) {
        expectGuardFails(asGuard(checkReimplementations), withFile(realTree, path, sample), {
          name: `${tellTale} in ${path}`,
          reason: `${path}:1: ${TELL_TALES[tellTale]}`,
        });
      }
    },
  );
});

describe('single implementation: negative fixtures fail on purpose', () => {
  it.each([
    [
      'web-second-org-name.ts.txt',
      /apps\/web\/src\/lib\/org-name\.ts:2: second definition of normalizeOrgName \(function\)/,
    ],
    [
      'server-second-accent.ts.txt',
      /apps\/server\/src\/branding\/accent\.ts:2: second definition of normalizeAccent \(variable\)[\s\S]*accent\.ts:4: second definition of deriveAccentTokens \(variable\)/,
    ],
    [
      'server-class-method.ts.txt',
      /locale-negotiator\.ts:3: second definition of detectLocale \(method\)/,
    ],
    [
      'web-object-members.tsx.txt',
      /branding-helpers\.tsx:3: second definition of logoPlateFor \(property\)[\s\S]*branding-helpers\.tsx:4: second definition of shortOrgName \(method\)/,
    ],
    [
      'web-second-permission-catalogue.ts.txt',
      /apps\/web\/src\/lib\/permissions\.ts:2: second definition of PERMISSIONS \(variable\)[\s\S]*permissions\.ts:4: second definition of hasAnyPermission \(function\)[\s\S]*permissions\.ts:2: list of permission names/,
    ],
    [
      'server-renamed-permission-list.ts.txt',
      /apps\/server\/src\/policy\/preview-actor\.ts:3: list of permission names outside packages\/shared/,
    ],
    [
      'web-grapheme-cut.ts.txt',
      /org-mark\.ts:2: Intl\.Segmenter outside packages\/shared[\s\S]*packages\/shared\/src\/branding\/org-name\.ts, packages\/shared\/src\/branding\/initials\.ts/,
    ],
    [
      'server-hex-shorthand.ts.txt',
      /theme-colour\.ts:3: hex colour pattern outside packages\/shared[\s\S]*packages\/shared\/src\/branding\/accent\.ts/,
    ],
    [
      'server-hex-validator.ts.txt',
      /manifest-colour\.ts:2: hex colour pattern outside packages\/shared/,
    ],
    [
      'web-luminance.ts.txt',
      /readable-on\.ts:3: WCAG luminance constant outside packages\/shared[\s\S]*packages\/shared\/src\/branding\/contrast\.ts/,
    ],
    ['server-oklab.ts.txt', /hover-colour\.ts:3: OKLab matrix constant outside packages\/shared/],
    [
      'web-navigator-languages.ts.txt',
      /apps\/web\/src\/lib\/locale\.ts:4: navigator language read that is not handed to detectLocale/,
    ],
    [
      'web-problem-message-key.ts.txt',
      /problem-message\.ts:3: problem catalogue key built by hand[\s\S]*packages\/shared\/src\/problem\.ts/,
    ],
    [
      'shared-script-duplicate.ts.txt',
      /packages\/shared\/scripts\/initials-copy\.ts:2: second definition of deriveInitials \(function\)/,
    ],
    [
      'e2e-helper-contrast.ts.txt',
      /e2e\/lib\/contrast\.ts:2: second definition of contrastRatio \(function\)/,
    ],
    [
      'web-build-script.mjs.txt',
      /apps\/web\/build\/locale-boot\.mjs:2: second definition of detectLocale \(function\)/,
    ],
    [
      'shared-misplaced-definition.ts.txt',
      /packages\/shared\/src\/schemas\/branding\.ts:2: normalizeAccent is defined here, but its one home is packages\/shared\/src\/branding\/accent\.ts/,
    ],
    [
      'shared-double-definition.ts.txt',
      /packages\/shared\/src\/branding\/org-name\.ts: normalizeOrgName is defined 2 times \(lines 2, 8\)/,
    ],
  ] as const)('%s', (fixture, reason) => {
    expectGuardFails(asGuard(checkAll), mountFixture(realTree, fixture), { name: fixture, reason });
  });

  it('keeps no fixture that the tests above do not use, and no test without its fixture', () => {
    const onDisk = readdirSync(fixtureDirectory).sort();
    // The list is read back from the source of this very test so it cannot drift from the table.
    const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const named = [
      ...source.matchAll(/'((?:web|server|shared|e2e)-[a-z0-9-]+\.[a-z]+\.txt)'/g),
    ].map((match) => match[1] ?? '');
    expect([...new Set(named)].sort()).toEqual(onDisk);
  });

  it('fails a definition in a file with a javascript or jsx extension too', () => {
    for (const path of ['apps/web/src/x.jsx', 'apps/web/build/x.cjs', 'tools/x/y.mts']) {
      expectGuardFails(
        asGuard(checkSecondDefinitions),
        withFile(realTree, path, 'export function hasAnyPermission() { return false; }\n'),
        { name: path, reason: `${path}:1: second definition of hasAnyPermission` },
      );
    }
  });
});

describe('single implementation: what must stay allowed (the guard is not over-eager)', () => {
  function allowed(path: string, content: string): void {
    const tree = withFile(realTree, path, content);
    expect(problemsAt(checkAll, tree, path), path).toEqual([]);
  }

  it('allows importing, calling and re-exporting the shared functions', () => {
    allowed(
      'apps/web/src/lib/branding.ts',
      [
        "import { normalizeOrgName, shortOrgName } from '@m365portal/shared/branding/org-name';",
        "import { deriveAccentTokens, normalizeAccent } from '@m365portal/shared/branding/accent';",
        "import { PERMISSIONS, hasAnyPermission } from '@m365portal/shared/permissions';",
        "export { logoPlateFor } from '@m365portal/shared/branding/logo-plate';",
        "export { detectLocale as detect } from '@m365portal/shared/i18n/detect';",
        'export const name = normalizeOrgName(shortOrgName(raw));',
        'export const tokens = deriveAccentTokens(normalizeAccent(accent));',
        'export const everything = PERMISSIONS;',
        "export const may = hasAnyPermission(held, ['users:read', 'groups:read']);",
      ].join('\n'),
    );
  });

  it('allows an alias of a shared function and a destructured binding', () => {
    allowed(
      'apps/server/src/branding/aliases.ts',
      [
        "import * as org from '@m365portal/shared/branding/org-name';",
        'export const normalizeOrgName = org.normalizeOrgName;',
        'export const shortOrgName = (org as typeof org).shortOrgName;',
        'const { deriveInitials } = org as unknown as Record<string, () => string>;',
        'export const initials = deriveInitials;',
      ].join('\n'),
    );
  });

  it('allows the names in comments, strings and as look-alike identifiers', () => {
    allowed(
      'apps/server/src/branding/mentions.ts',
      [
        '// normalizeOrgName and shortOrgName live in packages/shared; PERMISSIONS too.',
        '/* function detectLocale() {} const logoPlateFor = () => 1; */',
        "export const ruleNames = ['normalizeAccent', 'deriveAccentTokens', 'hasAnyPermission'];",
        'export const normalizeOrgNameForSearch = (value: string): string => value.trim();',
        'export const shortOrgNames = new Map<string, string>();',
        'export function detectLocaleFromHeader(header: string): string { return header; }',
        'export const myPERMISSIONS = [1, 2, 3];',
        'export interface PermissionList { PERMISSIONS: readonly string[] }',
        'export type logoPlateFor = (luminance: number) => string;',
        'declare function deriveInitials(name: string): string;',
        'export function monogramGlyphs(initials: string): string;',
      ].join('\n'),
    );
  });

  it('allows parameters and destructured props that carry a table name', () => {
    allowed(
      'apps/web/src/components/shell/org-mark.tsx',
      [
        'interface Props { readonly logoPlateFor: (luminance: number) => string }',
        'export function OrgMark({ logoPlateFor }: Props): number {',
        '  return logoPlateFor(0.5).length;',
        '}',
        'export const wrap = (detectLocale: (tags: string[]) => string) => detectLocale([]);',
      ].join('\n'),
    );
  });

  it('allows a definition in tests, fixtures, documentation and declaration files', () => {
    const body = 'export function normalizeOrgName(raw: string): string { return raw; }\n';
    const paths = [
      'apps/web/test/org-name.test.ts',
      'apps/server/test/helpers/second.ts',
      'apps/server/test/fixtures/hostile/second.ts',
      'e2e/tests/second.spec.ts',
      'packages/shared/test/second.test.ts',
      'docs/example.ts',
      'specs/001-m365portal/prototype.js',
      'apps/web/src/types.d.ts',
    ];
    const tree = new Map([...realTree, ...paths.map((path) => [path, body] as const)]);
    for (const path of paths) expect(problemsAt(checkAll, tree, path), path).toEqual([]);
  });

  it('allows an overload signature and an ambient declaration without a body', () => {
    allowed(
      'apps/web/src/lib/ambient.ts',
      [
        'export function hasAnyPermission(held: string[]): boolean;',
        'export function hasAnyPermission(held: string[], wanted?: string[]): boolean;',
        'declare const PERMISSIONS: readonly string[];',
        'declare function problemMessageKey(code: string): string;',
      ].join('\n'),
    );
  });

  it('allows passing navigator.languages to detectLocale, however it is wrapped', () => {
    allowed(
      'apps/web/src/lib/locale-boot.ts',
      [
        "import { detectLocale } from '@m365portal/shared/i18n/detect';",
        'export const a = detectLocale(navigator.languages);',
        'export const b = detectLocale([...navigator.languages]);',
        'export const c = detectLocale(navigator.languages.length > 0 ? navigator.languages : [navigator.language]);',
        'export const d = detectLocale(window.navigator.languages ?? []);',
        'export const e = i18n.detectLocale(globalThis.navigator.languages);',
        'export const f = { locale: detectLocale(Array.from(navigator.languages)) };',
      ].join('\n'),
    );
  });

  it('allows other uses of the navigator object and of Intl', () => {
    allowed(
      'apps/web/src/lib/browser.ts',
      [
        'export const online = navigator.onLine;',
        'export const agent = navigator.userAgent;',
        "export const sw = 'serviceWorker' in navigator;",
        "export const plural = new Intl.PluralRules('nl');",
        "export const dates = new Intl.DateTimeFormat('en', { dateStyle: 'medium' });",
      ].join('\n'),
    );
  });

  it('allows a single permission name and a short any-of list', () => {
    allowed(
      'apps/server/src/branding/routes.ts',
      [
        "export const access = { permission: 'settings:branding' };",
        "export const either = ['audit:read', 'audit:export'];",
        "export const three = ['users:read', 'groups:read', 'contacts:read'];",
        "export const repeated = ['users:read', 'users:read', 'users:read', 'users:read', 'users:read'];",
        "export const labels = { 'users:read': 1, 'groups:read': 2 };",
      ].join('\n'),
    );
  });

  it('allows lists that merely look like permission names', () => {
    allowed(
      'apps/web/src/components/ui/variants.ts',
      [
        "export const hover = ['hover:underline', 'focus:ring', 'md:flex', 'dark:bg', 'sm:p'];",
        "export const pseudo = ['a:hover', 'a:focus', 'input:invalid', 'li:first'];",
        "export const nonsense = ['users', 'groups', 'audit', 'rbac', 'settings'];",
        "export const tooDeep = ['users:read:own:x', 'groups:a:b:c', 'rbac:manage:all:x', 'audit:a:b:c'];",
      ].join('\n'),
    );
  });

  it('allows a recogniser that searches for colours inside text (the no-raw-colour lint rule)', () => {
    allowed(
      'eslint-rules/rules/colour-finder.js',
      [
        '// The exact shape eslint-rules/rules/no-raw-colour.js uses to find raw colours in source:',
        '// unanchored, with a lookbehind and a lookahead. It finds colours; it normalises none.',
        'const HEX_COLOUR =',
        '  /(?<![A-Za-z0-9&/#-])#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})(?![A-Za-z0-9-])/i;',
        'export const find = (text) => HEX_COLOUR.exec(text)?.[0];',
        'export const findAll = (text) => text.match(/#[0-9a-fA-F]{6}\\b/g);',
        "export const fromString = (text) => new RegExp('#[0-9a-f]{3}', 'i').exec(text);",
      ].join('\n'),
    );
  });

  it('allows other hex patterns and other numbers', () => {
    allowed(
      'apps/server/src/lib/patterns.ts',
      [
        'export const sha256 = /^[0-9a-f]{64}$/;',
        'export const requestId = /^[A-Za-z0-9-]{8,64}$/;',
        'export const anchor = /^#\\/users\\/(\\d+)$/;',
        'export const hashRoute = /#([a-z]+)/;',
        'export const hexByte = /^[0-9a-f]{2}$/i;',
        "export const fromString = new RegExp('^[a-z]{6}$');",
        'export const n = [0.2127, 0.7, 0.722, 0.04, 0.2, 12.92, 2.4];',
        'export const lightness = 0.4122;',
      ].join('\n'),
    );
  });

  it('allows other template strings and concatenations', () => {
    allowed(
      'apps/web/src/lib/keys.ts',
      [
        'export const a = (code: string) => `errors.${code}`;',
        'export const b = (id: string) => `problem+json ${id}`;',
        "export const c = (code: string) => 'prob.' + code;",
        'export const d = (base: string) => `${base}/problem`;',
        "export const e = 'application/problem+json';",
        "export const f = 'problem.unknown';",
      ].join('\n'),
    );
  });

  it('allows grapheme-free text work', () => {
    allowed(
      'apps/web/src/lib/text.ts',
      [
        'export const words = (text: string) => text.split(/\\s+/);',
        "export const segmentName = 'Segmenter';",
        'export const upper = (text: string) => text.toUpperCase();',
      ].join('\n'),
    );
  });

  it('allows a definition inside packages/shared/src when it sits in its home', () => {
    allowed(
      `${SHARED_SRC}branding/org-name.ts`,
      [
        'export const DEFAULT_ORG_NAME = "M365Portal";',
        'const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });',
        'export function normalizeOrgName(raw: string): string { return [...segmenter.segment(raw)].join(""); }',
        'export function shortOrgName(name: string): string { return name; }',
        'export const isDefaultName = (name: string): boolean => name === DEFAULT_ORG_NAME;',
      ].join('\n'),
    );
  });

  it('allows the same non-concept helper to be defined in several shared modules', () => {
    const paths = [`${SHARED_SRC}schemas/common.ts`, `${SHARED_SRC}tokens/index.ts`];
    const tree = new Map([
      ...realTree,
      ...paths.map((path) => [path, 'export const clamp = (n: number) => n;\n'] as const),
    ]);
    for (const path of paths) expect(problemsAt(checkAll, tree, path), path).toEqual([]);
  });
});

describe('single implementation: exemptions', () => {
  const FILE = 'apps/server/src/branding/pipeline/mean-luminance.ts';
  const REASON =
    'Mean luminance over PNG pixels needs the per-pixel weights; the shared helper takes a hex string.';
  const TELL_TALE_SOURCE =
    'export const weight = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;\n';
  const exemption: Exemption = { path: FILE, tellTale: 'wcag-coefficients', reason: REASON };
  const tree = withFile(realTree, FILE, TELL_TALE_SOURCE);

  it('starts empty, and the list that ships passes', () => {
    expect(EXEMPTIONS).toEqual([]);
    expect(checkExemptions(realTree)).toEqual([]);
  });

  it('is needed: without it the file fails', () => {
    expect(scan(tree).tellTales.join('\n')).toContain(`${FILE}:1: WCAG luminance constant`);
  });

  it('excuses the tell-tale of that file when it carries a reason', () => {
    const report = scan(tree, [exemption]);
    expect(report.tellTales.filter((problem) => problem.startsWith(FILE))).toEqual([]);
    expect(report.exemptions).toEqual([]);
  });

  it('excuses only that tell-tale, and only in that file', () => {
    const otherFile = withFile(tree, 'apps/server/src/other.ts', TELL_TALE_SOURCE);
    expect(scan(otherFile, [exemption]).tellTales.join('\n')).toContain(
      'apps/server/src/other.ts:1:',
    );

    const otherTellTale = withFile(
      tree,
      FILE,
      `${TELL_TALE_SOURCE}export const cut = new Intl.Segmenter();\n`,
    );
    expect(scan(otherTellTale, [exemption]).tellTales.join('\n')).toContain(
      `${FILE}:2: Intl.Segmenter outside packages/shared`,
    );
  });

  it('never excuses a definition by name', () => {
    const withDefinition = withFile(
      tree,
      FILE,
      `${TELL_TALE_SOURCE}export function contrastRatio(): number { return 1; }\n`,
    );
    const report = scan(withDefinition, [exemption]);
    expect(report.definitions.join('\n')).toContain(
      `${FILE}:2: second definition of contrastRatio`,
    );
  });

  it('fails an exemption without a real reason', () => {
    expectGuardFails(
      asGuard((candidate) => scan(candidate, [{ ...exemption, reason: 'needed' }]).exemptions),
      tree,
      {
        name: 'short reason',
        reason: 'give a reason of at least 40 characters',
      },
    );
    expectGuardFails(
      asGuard(
        (candidate) => scan(candidate, [{ ...exemption, reason: ' '.repeat(80) }]).exemptions,
      ),
      tree,
      {
        name: 'blank reason',
        reason: 'give a reason of at least 40 characters',
      },
    );
  });

  it('fails an exemption that is stale: the file no longer shows the tell-tale', () => {
    const clean = withFile(realTree, FILE, 'export const answer = 42;\n');
    expectGuardFails(
      asGuard((candidate) => scan(candidate, [exemption]).exemptions),
      clean,
      {
        name: 'stale exemption',
        reason: `exemption ${FILE} [wcag-coefficients]: stale`,
      },
    );
  });

  it('fails an exemption for a file that is missing, a test, or inside packages/shared/src', () => {
    for (const path of [
      'apps/server/src/not-there.ts',
      'apps/server/test/mean.test.ts',
      `${SHARED_SRC}branding/contrast.ts`,
    ]) {
      const there = withFile(realTree, path, TELL_TALE_SOURCE);
      expectGuardFails(
        asGuard((candidate) => scan(candidate, [{ ...exemption, path }]).exemptions),
        path === 'apps/server/src/not-there.ts' ? realTree : there,
        { name: path, reason: `exemption ${path} [wcag-coefficients]: not a scanned file` },
      );
    }
  });
});
