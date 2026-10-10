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
//     a test and not documentation. A test is a file in the test folder of a package (apps/*/test,
//     packages/*/test, e2e/tests and the like, anchored: `apps/server/src/test` is source) or a
//     file named like a test that its runner collects. That includes packages/shared/scripts, e2e
//     helpers, tools, build scripts, static files and root configuration. For each file the
//     TypeScript parser (not a text search, so comments, strings and look-alike identifiers are left
//     alone) finds
//       1. a definition of a name of the table: function, class, enum, variable with a function,
//          class, array, object or `new` initialiser or the result of a call (a factory), method,
//          accessor, object member, a default in a parameter or a destructuring pattern, an
//          assignment to a name or property, `export { impl as name }` of something the file
//          implements. An alias (`const x = shared.x`, `x.bind(y)`), an import and a re-export are
//          not definitions;
//       2. a look-alike: a function whose NAME says it does the work of a concept under another
//          spelling (`normaliseOrgName`, `getInitials`, `pickLocale`, `luminanceOf`, `hasPermission`).
//          Components, hooks (`useLocale`) and event handlers (`onAccentChange`) are left alone;
//       3. a tell-tale re-implementation: Intl.Segmenter, a regular expression that takes a colour
//          value apart or validates it whole (`^#rrggbb$`, `^[0-9a-f]{6}$`, `#rgb` expansion; a
//          pattern that SEARCHES text for colours, like the no-raw-colour lint rule's, is a
//          recogniser and is left alone), WCAG or OKLab constants, YIQ brightness weights, a
//          navigator.language(s) or Accept-Language read that is not handed to detectLocale, a
//          catalogue key built by hand (`problem.${code}`, `['problem', code].join('.')`), a list,
//          union or enum of four or more permission names, a catalogue built from lists of
//          resources and actions.
//   - INSIDE packages/shared/src: each name is defined at most once, in its home module. A home that
//     is still a stub (`export {};`) defines nothing; as soon as it holds code it must define the
//     names its row requires, so a row cannot guard nothing because the owner spelled the function
//     differently (G0 defect D19).
//
// A surface that genuinely needs a different answer needs a documented reason, not a local copy
// (baseline section 10). EXEMPTIONS is that record. It is empty, it excuses a tell-tale or a
// look-alike name in one file (never a definition of a name of the table), every entry needs a
// reason, and an entry that is no longer needed fails the test so the list cannot rot. Add one by
// asking stream S0 or the owner, not by editing around the guard. The cases to expect: a server step
// that must weigh PNG pixels with the WCAG constants for the stored luminance of a logo (plan section
// 8, step 8), and the static offline page, which cannot import detectLocale and reads
// navigator.languages itself (plan PD-17). Prefer a shared helper over an exemption.
//
// To add a concept: add a row to CONCEPTS (identifiers, the names that must exist, home module,
// tell-tales, the words of a look-alike) and, if FR-A-008 grows, its words to FR_A_008_WORDS. The
// table tests and the data-driven tests pick it up.
//
// This is a coarse net, not a proof. It does not follow a name through an import, code inside HTML
// files or generated strings. The unit tests of each module (org-name, accent, ...) are what check
// the behaviour; this file checks that there is one place for it to live.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';
import { expectGuardFails } from '../src/testing/index.js';
import {
  isTestPath,
  loadTree as loadRepositoryTree,
  mountFixture as mountRepositoryFixture,
  oversizedFiles,
  repositoryRoot,
  type Tree,
  withFile,
} from './support/repository.js';

type Check = (tree: Tree) => string[];

// ---------------------------------------------------------------------------------------------
// The real tree
// ---------------------------------------------------------------------------------------------

const fixtureDirectory = fileURLToPath(
  new URL('./fixtures/single-implementation/', import.meta.url),
);

const CODE_FILE = /\.[cm]?[jt]sx?$/;

const SHARED_SRC = 'packages/shared/src/';
const DOCUMENTATION_DIRECTORIES = ['docs/', 'specs/'];

/** Every code file of the repository (see support/repository.ts for what is never read). */
function loadTree(root?: string): Tree {
  return loadRepositoryTree((name) => CODE_FILE.test(name), root);
}

function mountFixture(tree: Tree, fixture: string): Tree {
  return mountRepositoryFixture(tree, fixtureDirectory, fixture).tree;
}

// ---------------------------------------------------------------------------------------------
// What is in scope
// ---------------------------------------------------------------------------------------------

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
  | 'yiq-coefficients'
  | 'language-reader'
  | 'accept-language'
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
  'yiq-coefficients':
    'YIQ brightness weights (299, 587, 114) outside packages/shared: the text colour on an accent is chosen once, in branding/contrast',
  'language-reader':
    'navigator language read that is not handed to detectLocale(...): locale tags are normalised once, by detectLocale',
  'accept-language':
    'Accept-Language read or parsed that is not handed to detectLocale(...): locale tags are normalised once, by detectLocale',
  'problem-key':
    'problem catalogue key built by hand: problem codes map to messages once, through problemMessageKey',
  'permission-list':
    'list of permission names outside packages/shared: the catalogue is PERMISSIONS (a single name or a short any-of list is fine)',
};
const TELL_TALE_IDS = Object.keys(TELL_TALES) as TellTale[];

/** A name that must be defined, or a group of which at least one must be. */
type Required = string | readonly string[];

interface Concept {
  /** Short stable id, used in messages. */
  readonly id: string;
  /** The words of FR-A-008 this concept answers for (the table must cover all of them). */
  readonly fr008: readonly string[];
  /** Identifiers defined at most once in packages/shared/src, and never outside it. */
  readonly names: readonly string[];
  /**
   * What the home must define, exactly once, as soon as it holds code (G0 defect D19). Without it a
   * row guards nothing if the owner spells the function differently: zero definitions would pass for
   * ever. A group asks for at least one of its names.
   */
  readonly required: readonly Required[];
  /** The only module that may define them. */
  readonly home: string;
  /** Re-implementations to look for outside packages/shared/src. */
  readonly tellTales: readonly TellTale[];
  /**
   * Is a function with these words in its name a second implementation of this concept under
   * another spelling (G0 defect D2)? `words` is the name split at case changes, lower-cased:
   * `normaliseOrgName` gives [normalise, org, name].
   */
  readonly lookalike: (words: readonly string[]) => boolean;
}

/** Splits `normaliseOrgName`, `ALL_PERMISSIONS` and `toSixDigitHex` into lower-case words. */
function wordsOf(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

function followedBy(words: readonly string[], first: RegExp, second: RegExp): boolean {
  return words.some((word, index) => first.test(word) && second.test(words[index + 1] ?? '\u0000'));
}

const CONCEPTS: readonly Concept[] = [
  {
    id: 'org-name',
    fr008: ['organisation-name normalisation', 'short-name cut'],
    names: ['normalizeOrgName', 'shortOrgName'],
    required: ['normalizeOrgName', 'shortOrgName'],
    home: `${SHARED_SRC}branding/org-name.ts`,
    tellTales: ['grapheme-segmentation'],
    // "org name" and a verb that cuts or cleans it: normaliseOrgName, cleanOrganisationName,
    // shortOrganizationName, canonicalOrgName, OrgNameNormalizer.
    lookalike: (words) =>
      followedBy(words, /^org(?:ani[sz]ation)?$/, /^names?$/) &&
      words.some((word) =>
        /^(?:normali[sz]|clean|canonical|sanitis|sanitiz|tidy|short|truncat|cut|abbreviat)/.test(
          word,
        ),
      ),
  },
  {
    id: 'accent',
    fr008: ['accent hex normalisation'],
    names: ['normalizeAccent', 'deriveAccentTokens'],
    required: ['normalizeAccent', 'deriveAccentTokens'],
    home: `${SHARED_SRC}branding/accent.ts`,
    tellTales: ['hex-expansion', 'oklab-matrix'],
    // The word "accent", or a hex colour being expanded or tidied: toSixDigitHex, expandHex.
    lookalike: (words) =>
      words.some((word) => /^accents?$/.test(word)) ||
      (words.includes('hex') &&
        words.some((word) =>
          /^(?:six|digits?|expand\w*|shorthand|short|normali[sz]\w*|clean\w*|canonical\w*|colou?rs?)$/.test(
            word,
          ),
        )),
  },
  {
    // The names of these helpers are not fixed by the spec (T-A-122 says "the contrast helpers"):
    // these are the ones a second WCAG implementation would plausibly carry. The constants of the
    // tell-tale catch the rest. Once the module has landed, at least one of them must be defined;
    // if S3 spells them differently the table is extended (a request to S0), it is not left empty.
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
    required: [
      [
        'relativeLuminance',
        'contrastRatio',
        'wcagContrast',
        'wcagLuminance',
        'getRelativeLuminance',
        'getContrastRatio',
      ],
    ],
    home: `${SHARED_SRC}branding/contrast.ts`,
    tellTales: ['wcag-coefficients', 'yiq-coefficients'],
    lookalike: (words) => words.some((word) => /^(?:luminance|contrast|luma|wcag)$/.test(word)),
  },
  {
    id: 'initials',
    fr008: ['initials'],
    names: ['deriveInitials'],
    required: ['deriveInitials'],
    home: `${SHARED_SRC}branding/initials.ts`,
    tellTales: ['grapheme-segmentation'],
    lookalike: (words) => words.includes('initials'),
  },
  {
    id: 'monogram',
    fr008: ['monogram glyph mapping'],
    names: ['monogramGlyphs'],
    required: ['monogramGlyphs'],
    home: `${SHARED_SRC}branding/monogram.ts`,
    tellTales: [],
    lookalike: (words) => words.some((word) => word.startsWith('monogram')),
  },
  {
    id: 'logo-plate',
    fr008: [],
    names: ['logoPlateFor'],
    required: ['logoPlateFor'],
    home: `${SHARED_SRC}branding/logo-plate.ts`,
    tellTales: [],
    lookalike: (words) => followedBy(words, /^logos?$/, /^plates?$/),
  },
  {
    id: 'locale',
    fr008: ['locale-tag normalisation'],
    names: ['detectLocale'],
    required: ['detectLocale'],
    home: `${SHARED_SRC}i18n/detect.ts`,
    tellTales: ['language-reader', 'accept-language'],
    lookalike: (words) =>
      words.some((word) => /^locales?$/.test(word)) ||
      followedBy(words, /^accept$/, /^languages?$/),
  },
  {
    id: 'problem',
    fr008: ['problem-code to message mapping'],
    names: ['problemMessageKey'],
    required: ['problemMessageKey'],
    home: `${SHARED_SRC}problem.ts`,
    tellTales: ['problem-key'],
    lookalike: (words) =>
      words.includes('problem') &&
      words.some((word) => /^(?:keys?|messages?|msg|text|title|label)$/.test(word)),
  },
  {
    id: 'permissions',
    fr008: ['permission catalogue'],
    names: ['PERMISSIONS', 'hasAnyPermission'],
    required: ['PERMISSIONS', 'hasAnyPermission'],
    home: `${SHARED_SRC}permissions.ts`,
    tellTales: ['permission-list'],
    lookalike: (words) => words.some((word) => /^permissions?$/.test(word)),
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

/**
 * Either a tell-tale a file is excused from, or a look-alike name it may define. A definition of a
 * name of the table can never be excused.
 */
type Exemption = {
  /** Repository-relative path of the file that is excused. */
  readonly path: string;
  /** Why this surface needs its own arithmetic or its own function and cannot use the shared one. */
  readonly reason: string;
} & (
  | { readonly tellTale: TellTale; readonly name?: undefined }
  | { readonly name: string; readonly tellTale?: undefined }
);

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

/** A function whose name says it does the work of a concept of the table (G0 defect D2). */
interface Lookalike extends Definition {
  readonly concept: Concept;
}

interface Facts {
  readonly definitions: readonly Definition[];
  readonly lookalikes: readonly Lookalike[];
  readonly tellTales: Readonly<Record<TellTale, readonly Hit[]>>;
}

function emptyTellTales(): Record<TellTale, Hit[]> {
  return Object.fromEntries(TELL_TALE_IDS.map((id) => [id, []])) as unknown as Record<
    TellTale,
    Hit[]
  >;
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
    ts.isTypeAssertionExpression(current) ||
    ts.isAwaitExpression(current)
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

/** An arrow or function expression, alone or handed to a wrapper: `useCallback((x) => x, [])`. */
function isFunctionLike(expression: ts.Expression): boolean {
  const value = unwrap(expression);
  if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) return true;
  return (
    ts.isCallExpression(value) &&
    value.arguments.some((argument) => {
      const inner = unwrap(argument);
      return ts.isArrowFunction(inner) || ts.isFunctionExpression(inner);
    })
  );
}

/** `x.bind(y)`, `require('x')` and `import('x')` hand over something that exists. */
function isAliasCall(call: ts.CallExpression): boolean {
  if (call.expression.kind === ts.SyntaxKind.ImportKeyword) return true;
  const callee = unwrap(call.expression);
  if (ts.isIdentifier(callee)) return callee.text === 'require';
  return ts.isPropertyAccessExpression(callee) && callee.name.text === 'bind';
}

/**
 * Does this initialiser carry an implementation or a list, as opposed to naming one that exists?
 * `const x = shared.x` and `const x = shared.x.bind(shared)` name one; `const x = (a) => a`,
 * `const x = [..]`, `new Set([..])`, `memoize((a) => a)` and `const x = makeNormaliser()` carry one:
 * a variable called after a concept that is the RESULT of a call is a factory's product.
 */
function isImplementation(initializer: ts.Expression): boolean {
  const value = unwrap(initializer);
  if (isFunctionOrLiteral(value) || ts.isClassExpression(value) || ts.isNewExpression(value)) {
    return true;
  }
  return ts.isCallExpression(value) && !isAliasCall(value);
}

function isAmbient(declaration: ts.Declaration): boolean {
  return (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Ambient) !== 0;
}

function nameText(name: ts.Node | undefined): string | undefined {
  if (name === undefined) return undefined;
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : undefined;
}

/** Top-level names that carry an implementation: the targets of `export { impl as name }`. */
function localImplementations(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.body !== undefined) {
      if (statement.name !== undefined) names.add(statement.name.text);
    } else if (ts.isClassDeclaration(statement)) {
      if (statement.name !== undefined) names.add(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.initializer !== undefined &&
          isImplementation(declaration.initializer)
        ) {
          names.add(declaration.name.text);
        }
      }
    }
  }
  return names;
}

function assignedName(left: ts.Expression): string | undefined {
  if (ts.isIdentifier(left)) return left.text;
  if (ts.isPropertyAccessExpression(left)) return left.name.text;
  if (ts.isElementAccessExpression(left) && ts.isStringLiteralLike(left.argumentExpression)) {
    return left.argumentExpression.text;
  }
  return undefined;
}

/** A definition of a name of the table: every form in which a function, class or list gets that name. */
function definitionOf(
  node: ts.Node,
  source: ts.SourceFile,
  locals: ReadonlySet<string>,
): Definition | undefined {
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
  } else if (ts.isGetAccessorDeclaration(node)) {
    if (node.body === undefined) return undefined;
    [name, kind] = [nameText(node.name), 'getter'];
  } else if (ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node)) {
    if (node.initializer === undefined || !isImplementation(node.initializer)) return undefined;
    [name, kind] = [nameText(node.name), 'property'];
  } else if (ts.isBindingElement(node) || ts.isParameter(node)) {
    // A default value in a destructuring pattern or a parameter list: `({ shortOrgName = (n) => n })`.
    if (node.initializer === undefined || !isImplementation(node.initializer)) return undefined;
    [name, kind] = [nameText(node.name), 'default'];
  } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    if (!isImplementation(node.right)) return undefined;
    [name, kind] = [assignedName(node.left), 'assignment'];
  } else if (ts.isExportSpecifier(node)) {
    // `export { impl as name }` of something this file implements. A re-export from a module, and an
    // export of an import, name something that exists.
    if (node.parent.parent.moduleSpecifier !== undefined) return undefined;
    if (node.propertyName === undefined || !locals.has(node.propertyName.text)) return undefined;
    [name, kind] = [node.name.text, 'export'];
  } else {
    return undefined;
  }
  if (name === undefined || !CONCEPT_BY_NAME.has(name)) return undefined;
  return { name, kind, line: lineOf(source, node) };
}

function containsJsx(node: ts.Node): boolean {
  if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) {
    return true;
  }
  return ts.forEachChild(node, (child) => (containsJsx(child) ? true : undefined)) === true;
}

/**
 * A function that is named after a concept without being the function of the table. Components
 * (they render), hooks (`useLocale` reads a context) and event handlers (`onAccentChange`) are not
 * normalisers and are left alone; everything else that is a function and sounds like a concept is a
 * second implementation until an EXEMPTIONS entry says otherwise.
 */
function lookalikeOf(node: ts.Node, source: ts.SourceFile): Lookalike | undefined {
  let name: string | undefined;
  let kind: string;
  let body: ts.Node | undefined;
  if (ts.isFunctionDeclaration(node)) {
    if (node.body === undefined || isAmbient(node)) return undefined;
    [name, kind, body] = [nameText(node.name), 'function', node.body];
  } else if (ts.isVariableDeclaration(node)) {
    if (node.initializer === undefined || !isFunctionLike(node.initializer) || isAmbient(node)) {
      return undefined;
    }
    [name, kind, body] = [nameText(node.name), 'variable', node.initializer];
  } else if (ts.isMethodDeclaration(node)) {
    if (node.body === undefined) return undefined;
    [name, kind, body] = [nameText(node.name), 'method', node.body];
  } else if (ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node)) {
    if (node.initializer === undefined || !isFunctionLike(node.initializer)) return undefined;
    [name, kind, body] = [nameText(node.name), 'property', node.initializer];
  } else {
    return undefined;
  }
  if (name === undefined || CONCEPT_BY_NAME.has(name)) return undefined;
  if (/^use[A-Z0-9]/.test(name) || /^(?:on|handle)[A-Z0-9]/.test(name)) return undefined;
  const words = wordsOf(name);
  const concept = CONCEPTS.find((candidate) => candidate.lookalike(words));
  if (concept === undefined || containsJsx(body)) return undefined;
  return { name, kind, line: lineOf(source, node), concept };
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
/**
 * The YIQ brightness weights, as fractions or in thousandths. Each is a plain number that turns up
 * for other reasons (an HTTP status, a size), so the tell-tale needs two different weights in one file.
 */
const YIQ_WEIGHTS = new Map<number, string>([
  [0.299, 'red'],
  [0.587, 'green'],
  [0.114, 'blue'],
  [299, 'red'],
  [587, 'green'],
  [114, 'blue'],
]);

/** A character class that spells hexadecimal digits: `[0-9a-f]`, `[a-fA-F\d]`, `[\da-f]`, ... */
const HEX_CLASS = /\[(?=[^\]]*(?:0-9|\\d))(?=[^\]]*[aA]-[fF])[^\]]*\]/g;
/** `(.)(.)(.)`, `(\w)(\w)(\w)`, `([a-f\d])([a-f\d])([a-f\d])`: a pattern that takes #rgb apart. */
const THREE_SINGLE_GROUPS = /(?:\((?:\.|\\[wWdDsS]|\[[^\]]+\])\)){3}/;
/** The widths of a colour: 3 (rgb), 4 (rgba), 6 (rrggbb) or 8 (rrggbbaa) digits, or a range. */
const COLOUR_WIDTH = /\{(?:3|4|6|8)(?:,\d+)?\}/;
/** `([0-9a-f])([0-9a-f])([0-9a-f])`: three single hex digits, the `#rgb` expansion with the "#" cut off. */
const THREE_HEX_GROUPS = /(?:\(\[(?=[^\]]*(?:0-9|\\d))(?=[^\]]*[aA]-[fF])[^\]]*\]\)){3}/;
/** Without a "#" only a 3 or 6 digit width gives a colour away: 8 digits is a checksum, 4 a code. */
const BARE_COLOUR_WIDTH = /\{(?:3|6)(?:,\d+)?\}|\{[3-6],[6-8]\}/;

/**
 * Does the pattern take a colour VALUE apart or validate it as a whole? That is what a second accent
 * normaliser does: it expands #rgb (three single-character groups) or checks `^#rrggbb$` (or, with
 * the "#" stripped off first, `^[0-9a-f]{6}$`).
 *
 * A pattern that SEARCHES for colours inside larger text is a recogniser, not a normaliser, and is
 * left alone: the no-raw-colour lint rule finds `#rrggbb` in source code with a lookbehind and a
 * lookahead and normalises nothing. The difference is the anchor at the start of the pattern.
 * Identifiers of 8, 12, 32 or 64 hex digits (checksums, UUIDs, hashes) are not colours.
 */
function looksLikeHexColourPattern(pattern: string): boolean {
  const hexClasses = pattern.match(HEX_CLASS)?.length ?? 0;
  if (pattern.includes('#')) {
    if (THREE_SINGLE_GROUPS.test(pattern)) return true;
    if (!pattern.startsWith('^')) return false;
    return hexClasses > 0 && (hexClasses >= 3 || COLOUR_WIDTH.test(pattern));
  }
  if (THREE_HEX_GROUPS.test(pattern)) return true;
  return (
    pattern.startsWith('^') && hexClasses >= 1 && hexClasses <= 2 && BARE_COLOUR_WIDTH.test(pattern)
  );
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
const PERMISSION_RESOURCES = [
  'users',
  'groups',
  'distributionlists',
  'contacts',
  'audit',
  'settings',
  'rbac',
];
const PERMISSION_NAME = new RegExp(`^(?:${PERMISSION_RESOURCES.join('|')})(?::[a-z]+){1,2}$`);
/** A single name or a short any-of list is normal use; the catalogue has 15. */
const PERMISSION_LIST_MIN = 4;
/** Resource names in one list that, with a "resource:action" join in a loop, build the catalogue by hand. */
const PERMISSION_RESOURCES_MIN = 3;
const ITERATION_METHODS = new Set(['flatMap', 'map', 'reduce', 'forEach']);

/** Is the node inside a callback handed to `flatMap`, `map`, `reduce` or `forEach`? */
function isInsideIterationCallback(node: ts.Node): boolean {
  for (let current: ts.Node = node; !ts.isSourceFile(current); current = current.parent) {
    const parent = current.parent;
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      ts.isCallExpression(parent) &&
      ts.isPropertyAccessExpression(parent.expression) &&
      ITERATION_METHODS.has(parent.expression.name.text)
    ) {
      return true;
    }
  }
  return false;
}

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

function permissionNamesInUnion(node: ts.UnionTypeNode): number {
  const found = new Set<string>();
  for (const member of node.types) {
    if (ts.isLiteralTypeNode(member) && ts.isStringLiteralLike(member.literal)) {
      if (PERMISSION_NAME.test(member.literal.text)) found.add(member.literal.text);
    }
  }
  return found.size;
}

function permissionNamesInEnum(node: ts.EnumDeclaration): number {
  const found = new Set<string>();
  for (const member of node.members) {
    const value = member.initializer;
    if (value !== undefined && ts.isStringLiteralLike(value) && PERMISSION_NAME.test(value.text)) {
      found.add(value.text);
    }
  }
  return found.size;
}

/** `${resource}:${action}`, `${resource}:read`, `resource + ':' + action`: a name joined by hand. */
function joinsWithColon(node: ts.Node): boolean {
  if (ts.isTemplateExpression(node)) {
    return node.templateSpans.some((span) => span.literal.text.startsWith(':'));
  }
  return (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
    ((ts.isStringLiteralLike(node.right) && node.right.text.startsWith(':')) ||
      (ts.isStringLiteralLike(node.left) && node.left.text.endsWith(':')))
  );
}

/** What a file shows about permissions beyond a single literal: collected during the walk. */
interface FileFlags {
  hasResourceList: boolean;
  firstColonJoin: number | undefined;
  readonly yiq: Map<string, number>;
}

function noteTellTales(
  node: ts.Node,
  source: ts.SourceFile,
  found: Record<TellTale, Hit[]>,
  flags: FileFlags,
): void {
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
    const weight = YIQ_WEIGHTS.get(value);
    if (weight !== undefined && !flags.yiq.has(weight)) flags.yiq.set(weight, lineOf(source, node));
  }

  if (ts.isRegularExpressionLiteral(node)) {
    const body = regexBody(node.text);
    if (looksLikeHexColourPattern(body)) note('hex-expansion', `/${body}/`);
    if (/;(?:\\s\*)?q=/.test(body)) note('accept-language', `/${body}/`);
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

  if (ts.isStringLiteralLike(node)) {
    if (node.text.toLowerCase() === 'accept-language' && !isPassedToDetectLocale(node)) {
      note('accept-language', `'${node.text}'`);
    } else if (/;\s*q=/.test(node.text)) {
      note('accept-language', `'${node.text}'`);
    }
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
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const method = node.expression.name.text;
    const receiver = unwrap(node.expression.expression);
    if (method === 'join' && ts.isArrayLiteralExpression(receiver)) {
      const separator = node.arguments[0];
      const dotted =
        separator !== undefined && ts.isStringLiteralLike(separator) && separator.text === '.';
      const mentionsProblem = receiver.elements.some(
        (element) => ts.isStringLiteralLike(element) && /^problems?$/i.test(element.text),
      );
      if (dotted && mentionsProblem) note('problem-key', "['problem', ...].join('.')");
    }
    if (
      method === 'concat' &&
      ts.isStringLiteralLike(receiver) &&
      /(?:^|\W)problem\.$/.test(receiver.text)
    ) {
      note('problem-key', "'problem.'.concat(...)");
    }
  }

  if (ts.isArrayLiteralExpression(node) || ts.isObjectLiteralExpression(node)) {
    const count = permissionNamesIn(node);
    if (count >= PERMISSION_LIST_MIN) note('permission-list', `${String(count)} permission names`);
  }
  if (ts.isArrayLiteralExpression(node)) {
    const resources = new Set(
      node.elements.flatMap((element) =>
        ts.isStringLiteralLike(element) && PERMISSION_RESOURCES.includes(element.text)
          ? [element.text]
          : [],
      ),
    );
    if (resources.size >= PERMISSION_RESOURCES_MIN) flags.hasResourceList = true;
  }
  if (ts.isUnionTypeNode(node)) {
    const count = permissionNamesInUnion(node);
    if (count >= PERMISSION_LIST_MIN)
      note('permission-list', `a union of ${String(count)} permission names`);
  }
  if (ts.isEnumDeclaration(node)) {
    const count = permissionNamesInEnum(node);
    if (count >= PERMISSION_LIST_MIN)
      note('permission-list', `an enum of ${String(count)} permission names`);
  }
  if (
    joinsWithColon(node) &&
    isInsideIterationCallback(node) &&
    flags.firstColonJoin === undefined
  ) {
    flags.firstColonJoin = lineOf(source, node);
  }
}

function analyse(path: string, text: string, kind: ts.ScriptKind): Facts {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  const locals = localImplementations(source);
  const definitions: Definition[] = [];
  const lookalikes: Lookalike[] = [];
  const tellTales = emptyTellTales();
  const flags: FileFlags = { hasResourceList: false, firstColonJoin: undefined, yiq: new Map() };
  const visit = (node: ts.Node): void => {
    const definition = definitionOf(node, source, locals);
    if (definition !== undefined) definitions.push(definition);
    const lookalike = lookalikeOf(node, source);
    if (lookalike !== undefined) lookalikes.push(lookalike);
    noteTellTales(node, source, tellTales, flags);
    ts.forEachChild(node, visit);
  };
  visit(source);

  // Two different brightness weights in one file are a YIQ picker, whatever it is called.
  if (flags.yiq.size >= 2) {
    const line = Math.min(...flags.yiq.values());
    tellTales['yiq-coefficients'].push({ line, detail: [...flags.yiq.keys()].join(' and ') });
  }
  // A catalogue built from resource and action lists: a list of resources and a "resource:action" join in a loop.
  if (flags.hasResourceList && flags.firstColonJoin !== undefined) {
    tellTales['permission-list'].push({
      line: flags.firstColonJoin,
      detail: 'permission names built from resource and action lists',
    });
  }
  return { definitions, lookalikes, tellTales };
}

// ---------------------------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------------------------

interface Report {
  readonly definitions: string[];
  readonly lookalikes: string[];
  readonly tellTales: string[];
  readonly homes: string[];
  readonly landed: string[];
  readonly exemptions: string[];
}

function homesOf(tellTale: TellTale): string {
  const concepts = CONCEPTS.filter((concept) => concept.tellTales.includes(tellTale));
  return concepts.map((concept) => concept.home).join(', ');
}

/** `export {};` and comments only: the placeholder every stream's module starts as (T-A-002). */
function isStubModule(text: string): boolean {
  const code = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .trim();
  return code === '' || /^export \{\};?$/.test(code);
}

const excusedTellTale = (path: string, tellTale: TellTale): string => `${path}\u0000${tellTale}`;
const excusedName = (path: string, name: string): string => `${path}\u0000name\u0000${name}`;

function scan(tree: Tree, exemptions: readonly Exemption[] = EXEMPTIONS): Report {
  const report: Report = {
    definitions: [],
    lookalikes: [],
    tellTales: [],
    homes: [],
    landed: [],
    exemptions: [],
  };
  const paths = [...tree.keys()].sort();
  const excused = new Set(
    exemptions.map((exemption) =>
      exemption.name === undefined
        ? excusedTellTale(exemption.path, exemption.tellTale)
        : excusedName(exemption.path, exemption.name),
    ),
  );

  // Outside packages/shared/src: no definition of a table name, no look-alike, no tell-tale.
  for (const path of paths.filter(isOutsideScope)) {
    const facts = factsOf(path, tree.get(path) ?? '');
    for (const definition of facts.definitions) {
      const concept = CONCEPT_BY_NAME.get(definition.name);
      if (concept === undefined) continue;
      report.definitions.push(
        `${path}:${String(definition.line)}: second definition of ${definition.name} (${definition.kind}); the one implementation is ${concept.home}, import it from ${importPathOf(concept.home)} (FR-A-008)`,
      );
    }
    for (const lookalike of facts.lookalikes) {
      if (excused.has(excusedName(path, lookalike.name))) continue;
      report.lookalikes.push(
        `${path}:${String(lookalike.line)}: "${lookalike.name}" (${lookalike.kind}) is named like the ${lookalike.concept.id} concept (${lookalike.concept.names.join(', ')}), which is implemented once in ${lookalike.concept.home}: import it from ${importPathOf(lookalike.concept.home)}, or, if this is a different thing, add an entry to EXEMPTIONS with a reason (FR-A-008)`,
      );
    }
    for (const tellTale of TELL_TALE_IDS) {
      if (excused.has(excusedTellTale(path, tellTale))) continue;
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

  // A module that holds code defines what its row guards (D19). A stub defines nothing, on purpose.
  for (const concept of CONCEPTS) {
    const text = tree.get(concept.home);
    if (text === undefined || isStubModule(text)) continue;
    const defined = new Set(factsOf(concept.home, text).definitions.map((item) => item.name));
    for (const entry of concept.required) {
      const alternatives = typeof entry === 'string' ? [entry] : entry;
      if (alternatives.some((name) => defined.has(name))) continue;
      report.landed.push(
        `${concept.home}: the module has code but defines no ${alternatives.join(' or ')}: FR-A-008 pins ${typeof entry === 'string' ? 'it' : 'them'} here, and a row whose names are not defined guards nothing. Spell ${typeof entry === 'string' ? 'it' : 'one of them'} as the table does, or ask stream S0 to change the table (single-implementation.test.ts)`,
      );
    }
  }

  // The exemption list itself must stay honest.
  for (const exemption of exemptions) {
    const subject = exemption.name ?? exemption.tellTale;
    const label = `exemption ${exemption.path} [${subject}]`;
    if (exemption.reason.trim().length < MIN_REASON_LENGTH) {
      report.exemptions.push(
        `${label}: give a reason of at least ${String(MIN_REASON_LENGTH)} characters, saying why this surface cannot call the shared function (baseline section 10)`,
      );
    }
    const concept = exemption.name === undefined ? undefined : CONCEPT_BY_NAME.get(exemption.name);
    if (concept !== undefined) {
      report.exemptions.push(
        `${label}: a name of the table can never be excused; it is defined once, in ${concept.home}`,
      );
    }
    const text = tree.get(exemption.path);
    if (text === undefined || !isOutsideScope(exemption.path)) {
      report.exemptions.push(
        `${label}: not a scanned file (missing, a test, documentation or inside packages/shared/src)`,
      );
    } else if (exemption.name === undefined) {
      if (factsOf(exemption.path, text).tellTales[exemption.tellTale].length === 0) {
        report.exemptions.push(
          `${label}: stale, the file no longer shows this tell-tale; remove the exemption`,
        );
      }
    } else if (
      concept === undefined &&
      !factsOf(exemption.path, text).lookalikes.some((item) => item.name === exemption.name)
    ) {
      report.exemptions.push(
        `${label}: stale, the file no longer defines a function of that name that looks like a second implementation; remove the exemption`,
      );
    }
  }
  return report;
}

const checkSecondDefinitions: Check = (tree) => scan(tree).definitions;
const checkLookalikes: Check = (tree) => scan(tree).lookalikes;
const checkLanded: Check = (tree) => scan(tree).landed;
const checkReimplementations: Check = (tree) => scan(tree).tellTales;
const checkHomes: Check = (tree) => scan(tree).homes;
const checkExemptions: Check = (tree) => scan(tree).exemptions;
const checkAll: Check = (tree) => {
  const report = scan(tree);
  return [
    ...report.definitions,
    ...report.lookalikes,
    ...report.tellTales,
    ...report.homes,
    ...report.landed,
    ...report.exemptions,
  ];
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
  ['5 no look-alike under another spelling outside packages/shared/src', checkLookalikes],
  ['6 a module that has landed defines the names its row guards', checkLanded],
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

  it('reads every code file whole: none is so large that it would be scanned as empty (D18)', () => {
    expect(oversizedFiles(realTree)).toEqual([]);
    const huge = withFile(
      realTree,
      'apps/web/src/lib/huge.ts',
      `export const a = "${'x'.repeat(1_000_000)}";`,
    );
    expectGuardFails(asGuard(oversizedFiles), huge, {
      name: 'oversized code file',
      reason: 'apps/web/src/lib/huge.ts is',
    });
  });

  it('does not scan tests, fixtures, documentation or declaration files', () => {
    expect(isOutsideScope('apps/web/test/router.test.tsx')).toBe(false);
    expect(isOutsideScope('apps/server/test/helpers/test-app.ts')).toBe(false);
    expect(isOutsideScope('e2e/tests/smoke.spec.ts')).toBe(false);
    // A file named like a test is a test only where its runner collects it (G0 defect D3): beside the
    // sources nobody runs it, so it is source, and repo-conventions.test.ts check 9 reports it too.
    expect(isOutsideScope('apps/web/src/components/button.test.tsx')).toBe(true);
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
    // The other names of the row are asked for by check 6 (see "a row must protect something").
    const tree = withFile(realTree, home, `export function ${name}(): void {}\n`);
    expect(problemsAt(checkSecondDefinitions, tree, home)).toEqual([]);
    expect(problemsAt(checkHomes, tree, home)).toEqual([]);
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
    'yiq-coefficients': 'export const y = (r: number, b: number) => 299 * r + 114 * b;\n',
    'accept-language': "export const raw = (c: Ctx) => c.req.header('accept-language');\n",
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
      'web-test-folder-helper.ts.txt',
      /apps\/web\/src\/test\/helpers\.ts:1: second definition of normalizeOrgName \(function\)/,
    ],
    [
      'server-factory-and-export.ts.txt',
      /names\.ts:2: second definition of shortOrgName \(export\)[\s\S]*names\.ts:3: second definition of normalizeOrgName \(variable\)/,
    ],
    [
      'server-lookalike-normaliser.ts.txt',
      /clean-name\.ts:1: "cleanOrganisationName" \(function\) is named like the org-name concept[\s\S]*EXEMPTIONS/,
    ],
    [
      'server-yiq-picker.ts.txt',
      /text-colour\.ts:\d+: YIQ brightness weights \(299, 587, 114\) outside packages\/shared[\s\S]*branding\/contrast\.ts/,
    ],
    [
      'web-permission-union.ts.txt',
      /permission-union\.ts:\d+: list of permission names outside packages\/shared[\s\S]*a union of 6 permission names/,
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
        'export const shortOrgNames = new Map<string, string>();',
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

describe('single implementation: where the scan looks (G0 defects D3 and D16)', () => {
  const temporaryRoots: string[] = [];
  afterAll(() => {
    for (const directory of temporaryRoots) rmSync(directory, { recursive: true, force: true });
  });

  it('reads a source folder that merely shares a name with build output', () => {
    const root = mkdtempSync(join(tmpdir(), 'm365portal-single-'));
    temporaryRoots.push(root);
    const files: Record<string, string> = {
      'package.json': '{}',
      'dist/out.ts': 'export {};',
      'apps/web/package.json': '{}',
      'apps/web/dist/out.js': 'export {};',
      'apps/web/coverage/out.js': 'export {};',
      'apps/web/src/features/coverage/org.ts': 'export {};',
      'apps/web/src/features/dist/x.ts': 'export {};',
      'apps/web/src/.vite/y.ts': 'export {};',
      'apps/web/src/.worktrees/z.ts': 'export {};',
      '.worktrees/copy/a.ts': 'export {};',
      'node_modules/dep/index.js': 'export {};',
    };
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }

    expect([...loadTree(root).keys()].sort()).toEqual([
      'apps/web/src/.vite/y.ts',
      'apps/web/src/.worktrees/z.ts',
      'apps/web/src/features/coverage/org.ts',
      'apps/web/src/features/dist/x.ts',
    ]);
  });

  it.each([
    'apps/web/src/test/helpers.ts',
    'apps/server/src/fixtures/org.ts',
    'apps/server/src/test/org.ts',
    'apps/web/src/__tests__/org.ts',
    'apps/web/src/features/tests/org.ts',
    'apps/web/src/features/coverage/org.ts',
    'packages/shared/scripts/test/org.ts',
    'e2e/lib/fixtures/org.ts',
  ])(
    'scans %s: a folder called test or fixtures deeper than the package root is source',
    (path) => {
      expect(isOutsideScope(path)).toBe(true);
      expectGuardFails(
        asGuard(checkSecondDefinitions),
        withFile(
          realTree,
          path,
          'export function normalizeOrgName(raw: string): string { return raw; }\n',
        ),
        { name: path, reason: `${path}:1: second definition of normalizeOrgName (function)` },
      );
    },
  );

  it.each([
    'apps/server/test/org.ts',
    'apps/server/test/fixtures/hostile/org.ts',
    'apps/web/test/helpers/org.ts',
    'packages/shared/test/org.test.ts',
    'packages/shared/test/fixtures/x/org.ts',
    'e2e/tests/org.spec.ts',
    'eslint-rules/test/org.test.ts',
    'tools/lint-canary/cases/org.case.ts',
    'tools/lint-canary/org.test.ts',
    'scripts/org.test.ts',
  ])('does not scan %s: the tests and fixtures of a package are exempt', (path) => {
    expect(isOutsideScope(path)).toBe(false);
  });

  it('does not exempt a file named like a test where no runner collects it', () => {
    for (const path of ['apps/web/src/lib/org.test.ts', 'apps/server/src/org.spec.ts']) {
      expect(isOutsideScope(path), path).toBe(true);
    }
  });
});

describe('single implementation: definition forms the first version missed (G0 defect D3)', () => {
  const outside = 'apps/web/src/lib/second.ts';

  it.each([
    ['a factory call', 'export const normalizeOrgName = makeNormaliser();', 'normalizeOrgName'],
    [
      'a renamed export of a local implementation',
      'const impl = (raw: string): string => raw.trim();\nexport { impl as normalizeOrgName };',
      'normalizeOrgName',
    ],
    [
      'a renamed export of a local function',
      'function impl(raw: string): string { return raw.trim(); }\nexport { impl as shortOrgName };',
      'shortOrgName',
    ],
    [
      'a default in a destructured parameter',
      'export function f({ normalizeOrgName = (raw: string) => raw.trim() }: Options): string { return normalizeOrgName(""); }',
      'normalizeOrgName',
    ],
    [
      'a parameter default',
      'export const f = (deriveInitials = (name: string) => name.slice(0, 2)) => deriveInitials;',
      'deriveInitials',
    ],
    [
      'a default in a destructuring declaration',
      'const { shortOrgName = (name: string) => name.slice(0, 3) } = options;',
      'shortOrgName',
    ],
    [
      'an assignment to a property of exports',
      'exports.hasAnyPermission = function () { return false; };',
      'hasAnyPermission',
    ],
    [
      'an assignment to a bare name after the declaration',
      'let detectLocale; detectLocale = (tags) => tags[0];',
      'detectLocale',
    ],
    [
      'a getter',
      'export const holder = { get logoPlateFor() { return (): string => "none"; } };',
      'logoPlateFor',
    ],
    [
      'a class getter',
      'export class Holder { get monogramGlyphs(): () => string { return () => "A"; } }',
      'monogramGlyphs',
    ],
  ])('%s is a definition', (_description, code, name) => {
    expectGuardFails(asGuard(checkSecondDefinitions), withFile(realTree, outside, `${code}\n`), {
      name,
      reason: `${outside}:`,
    });
    const problems = checkSecondDefinitions(withFile(realTree, outside, `${code}\n`));
    expect(problems.join('\n')).toContain(`second definition of ${name}`);
  });

  it('does not take an alias for a definition: a property, a bind, a require, an import', () => {
    const code = [
      "import * as org from '@m365portal/shared/branding/org-name';",
      "import { deriveInitials as impl } from '@m365portal/shared/branding/initials';",
      'export const normalizeOrgName = org.normalizeOrgName;',
      'export const shortOrgName = org.shortOrgName.bind(org);',
      "export const hasAnyPermission = require('@m365portal/shared/permissions').hasAnyPermission;",
      "const { detectLocale } = await import('@m365portal/shared/i18n/detect');",
      'export { impl as deriveInitials };',
      'const local = org.normalizeOrgName;',
      'export { local as problemMessageKey };',
      'let logoPlateFor; logoPlateFor = org.logoPlateFor;',
      'export function f({ monogramGlyphs = org.monogramGlyphs }: Options) { return monogramGlyphs; }',
    ].join('\n');
    const tree = withFile(realTree, 'apps/server/src/aliases.ts', code);

    expect(problemsAt(checkAll, tree, 'apps/server/src/aliases.ts')).toEqual([]);
  });
});

describe('single implementation: a second normaliser under another spelling (G0 defect D2)', () => {
  const PLACES = ['apps/web/src/lib/x.ts', 'apps/server/src/x.ts', 'e2e/lib/x.ts'];

  const LOOKALIKES: readonly (readonly [string, string, string])[] = [
    [
      'normaliseOrgName',
      'export function normaliseOrgName(raw: string): string { return raw.trim(); }',
      'org-name',
    ],
    [
      'cleanOrganisationName',
      'export const cleanOrganisationName = (raw: string) => raw.trim();',
      'org-name',
    ],
    [
      'shortOrganizationName',
      'export const shortOrganizationName = (raw: string) => raw.slice(0, 12);',
      'org-name',
    ],
    [
      'canonicalOrgName',
      'export const canonicalOrgName = (raw: string) => raw.trim();',
      'org-name',
    ],
    [
      'getInitials',
      "export function getInitials(name: string) { return name.split(' ').map((w) => w[0]).join(''); }",
      'initials',
    ],
    ['monogramFor', 'export const monogramFor = (name: string) => name.slice(0, 1);', 'monogram'],
    ['toSixDigitHex', 'export function toSixDigitHex(h: string): string { return h; }', 'accent'],
    ['expandAccent', 'export const expandAccent = (h: string) => h;', 'accent'],
    ['luminanceOf', 'export const luminanceOf = (r: number) => r;', 'contrast'],
    [
      'contrastBetween',
      'export function contrastBetween(a: number, b: number) { return a / b; }',
      'contrast',
    ],
    [
      'pickLocale',
      "export function pickLocale(acceptLanguage: string) { return acceptLanguage.startsWith('nl') ? 'nl' : 'en'; }",
      'locale',
    ],
    [
      'parseAcceptLanguage',
      'export const parseAcceptLanguage = (header: string) => header.split(",");',
      'locale',
    ],
    ['problemKeyFor', 'export const problemKeyFor = (code: string) => code;', 'problem'],
    [
      'getProblemMessage',
      'export function getProblemMessage(code: string) { return code; }',
      'problem',
    ],
    [
      'hasPermission',
      'export const hasPermission = (held: string[], wanted: string) => held.includes(wanted);',
      'permissions',
    ],
    ['allPermissions', 'export function allPermissions(): string[] { return []; }', 'permissions'],
    [
      'normalizeOrgNameForSearch',
      'export const normalizeOrgNameForSearch = (value: string): string => value.trim();',
      'org-name',
    ],
    [
      'detectLocaleFromHeader',
      'export function detectLocaleFromHeader(header: string): string { return header; }',
      'locale',
    ],
    [
      'a method',
      'export class Negotiator { pickLocale(tags: string[]) { return tags[0]; } }',
      'locale',
    ],
    [
      'an object member',
      'export const helpers = { cleanOrgName: (n: string) => n.trim() };',
      'org-name',
    ],
    [
      'a wrapped function',
      'export const normaliseOrgName = useCallback((raw: string) => raw.trim(), []);',
      'org-name',
    ],
  ];

  it.each(LOOKALIKES)('%s is a second implementation in disguise', (description, code, concept) => {
    const name = /^[a-z]\w*$/i.test(description)
      ? description
      : (/(\w+)\s*(?:\(|=)/.exec(code.replace(/^export (?:const|function|class) \w+ /, ''))?.[1] ??
        '');
    for (const path of PLACES) {
      const problems = checkLookalikes(withFile(realTree, path, `${code}\n`));
      expect(
        problems.some(
          (problem) =>
            problem.startsWith(`${path}:1: `) &&
            problem.includes(`is named like the ${concept} concept`),
        ),
        `${path}: ${problems.join(' | ')} (${name})`,
      ).toBe(true);
    }
  });

  it('names the one implementation and the way out', () => {
    expectGuardFails(
      asGuard(checkLookalikes),
      withFile(
        realTree,
        'apps/web/src/lib/x.ts',
        'export const normaliseOrgName = (raw: string) => raw;\n',
      ),
      {
        name: 'message',
        reason:
          /"normaliseOrgName" \(variable\) is named like the org-name concept \(normalizeOrgName, shortOrgName\)[^]*packages\/shared\/src\/branding\/org-name\.ts[^]*@m365portal\/shared\/branding\/org-name[^]*EXEMPTIONS/,
      },
    );
  });

  it('leaves components, hooks, handlers and unrelated words alone', () => {
    const code = [
      'export function LocaleSwitcher() { return <select />; }',
      'export const AccentPicker = memo(function AccentPickerInner() { return <input />; });',
      'export const PermissionGate = ({ children }: Props) => <>{children}</>;',
      'export const useLocale = () => useContext(LocaleContext);',
      'export function usePermissions() { return useContext(PermissionContext); }',
      'export const onAccentChange = (value: string) => value;',
      'function handlePermissionToggle(): void {}',
      'export const initialState = () => ({});',
      'export function normalizeEmail(raw: string): string { return raw.trim(); }',
      'export const cleanUpTimers = () => undefined;',
      'export const accentuate = (text: string) => text;',
      'export const contrasting = (a: number) => a;',
      'export const isProblem = (value: unknown) => value !== undefined;',
      'export const problemDetails = (code: string) => code;',
      'export const shortId = (id: string) => id.slice(0, 8);',
      'export const sorted = names.sort((a, b) => a.localeCompare(b));',
      'export const orgNameInput = { value: "" };',
    ].join('\n');
    const tree = withFile(realTree, 'apps/web/src/components/mixed.tsx', code);

    expect(problemsAt(checkLookalikes, tree, 'apps/web/src/components/mixed.tsx')).toEqual([]);
  });

  it('does not apply to packages/shared/src, tests or fixtures', () => {
    const code = 'export const pickLocale = (a: string) => a;\n';
    const tree = new Map([
      ...realTree,
      ['packages/shared/src/schemas/common.ts', code],
      ['apps/web/test/locale.test.ts', code],
      ['apps/server/test/fixtures/x.ts', code],
    ]);

    expect(checkLookalikes(tree)).toEqual([]);
  });

  it('does not report a table name twice: the exact check owns it', () => {
    const tree = withFile(
      realTree,
      'apps/web/src/lib/x.ts',
      'export function normalizeOrgName() {}\n',
    );

    expect(checkLookalikes(tree)).toEqual([]);
    expect(checkSecondDefinitions(tree)).not.toEqual([]);
  });
});

describe('single implementation: more tell-tales of a second implementation (G0 defect D2)', () => {
  const TELL_TALE_SAMPLES: readonly (readonly [TellTale, string])[] = [
    [
      'yiq-coefficients',
      'export const pick = (r: number, g: number, b: number) => ((r * 299 + g * 587 + b * 114) / 1000 > 128 ? "dark" : "light");',
    ],
    ['yiq-coefficients', 'export const weights = [0.299, 0.587, 0.114];'],
    ['yiq-coefficients', 'export const y = (r: number, b: number) => 0.299 * r + 0.114 * b;'],
    ['accept-language', "export const h = (c: { req: Req }) => c.req.header('Accept-Language');"],
    ['accept-language', "export const first = headers['accept-language'];"],
    ['accept-language', "export const q = (v: string) => v.split(',').map((p) => p.split(';q='));"],
    ['accept-language', 'export const weight = /;\\s*q=([0-9.]+)/;'],
    ['problem-key', "export const key = (code: string) => ['problem', code].join('.');"],
    ['problem-key', "export const key2 = (code: string) => 'problem.'.concat(code);"],
    ['hex-expansion', 'export const isHex = /^[0-9a-f]{6}$/i;'],
    ['hex-expansion', "export const ok = new RegExp('^[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$');"],
    [
      'hex-expansion',
      'export const expand = (h: string) => h.replace(/^([0-9a-f])([0-9a-f])([0-9a-f])$/i, "$1$1$2$2$3$3");',
    ],
    [
      'permission-list',
      "export type P = 'users:read' | 'users:write' | 'groups:read' | 'groups:write' | 'audit:read' | 'audit:export';",
    ],
    [
      'permission-list',
      "export enum P { A = 'users:read', B = 'users:write', C = 'groups:read', D = 'groups:write' }",
    ],
    [
      'permission-list',
      "const R = ['users', 'groups', 'contacts', 'audit'];\nconst A = ['read', 'write'];\nexport const all = R.flatMap((r) => A.map((a) => `${r}:${a}`));",
    ],
    [
      'permission-list',
      "const R = ['users', 'groups', 'contacts'];\nexport const all = R.map((r) => r + ':' + 'read');",
    ],
  ];

  it.each(TELL_TALE_SAMPLES)('%s: %j fails in the web, server and e2e code', (tellTale, sample) => {
    for (const path of ['apps/web/src/lib/x.ts', 'apps/server/src/x.ts', 'e2e/lib/x.ts']) {
      const problems = checkReimplementations(withFile(realTree, path, `${sample}\n`));
      expect(
        problems.some(
          (problem) => problem.startsWith(`${path}:`) && problem.includes(TELL_TALES[tellTale]),
        ),
        `${path}: ${problems.join(' | ')}`,
      ).toBe(true);
    }
  });

  it('allows what only looks like them', () => {
    const code = [
      'export const status = 299;',
      'export const total = 299 + 1;',
      "export const lang = c.req.header('x-requested-with');",
      "export const handed = detectLocale(parse(c.req.header('accept-language')));",
      "export const key = (code: string) => ['error', code].join('.');",
      "export const joined = ['problem', 'details'].join('-');",
      'export const sha = /^[0-9a-f]{64}$/;',
      'export const crc = /^[0-9a-f]{8}$/i;',
      'export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;',
      "export type Pair = 'users:read' | 'users:write' | 'groups:read';",
      "export type Mode = 'light' | 'dark' | 'system' | 'contrast';",
      "export enum Kind { A = 'a', B = 'b', C = 'c', D = 'd' }",
      'export const bucket = (ip: string, route: string) => `${ip}:${route}`;',
      "export const words = ['users', 'groups', 'audit', 'rbac', 'settings'];",
    ].join('\n');
    const tree = withFile(realTree, 'apps/server/src/lib/lookalikes.ts', code);

    expect(problemsAt(checkReimplementations, tree, 'apps/server/src/lib/lookalikes.ts')).toEqual(
      [],
    );
  });

  it('is excused by an exemption with a reason, like the older tell-tales', () => {
    const file = 'apps/server/src/lib/pixels.ts';
    const sample = 'export const weights = [0.299, 0.587, 0.114];\n';
    const tree = withFile(realTree, file, sample);
    const exemption: Exemption = {
      path: file,
      tellTale: 'yiq-coefficients',
      reason:
        'Legacy video frames are weighed with the YIQ weights; the shared helper takes a hex string.',
    };

    expect(scan(tree).tellTales.join('\n')).toContain(`${file}:1:`);
    expect(scan(tree, [exemption]).tellTales.filter((problem) => problem.startsWith(file))).toEqual(
      [],
    );
    expect(scan(tree, [exemption]).exemptions).toEqual([]);
  });
});

describe('single implementation: exemptions for a look-alike name (G0 defect D2)', () => {
  const FILE = 'apps/server/src/lib/locale-header.ts';
  const CODE = 'export function pickLocale(header: string): string { return header; }\n';
  const REASON =
    'Reads the raw header for the log line only; the shell language comes from detectLocale.';
  const exemption: Exemption = { path: FILE, name: 'pickLocale', reason: REASON };
  const tree = withFile(realTree, FILE, CODE);

  it('is needed: without it the file fails', () => {
    expect(scan(tree).lookalikes.join('\n')).toContain(`${FILE}:1: "pickLocale"`);
  });

  it('excuses that name in that file only', () => {
    expect(scan(tree, [exemption]).lookalikes.filter((p) => p.startsWith(FILE))).toEqual([]);
    expect(scan(tree, [exemption]).exemptions).toEqual([]);
    const other = withFile(tree, 'apps/server/src/lib/other.ts', CODE);
    expect(scan(other, [exemption]).lookalikes.join('\n')).toContain(
      'apps/server/src/lib/other.ts:1:',
    );
    const renamed = withFile(
      realTree,
      FILE,
      'export function negotiateLocale(): string { return ""; }\n',
    );
    expect(scan(renamed, [exemption]).lookalikes.join('\n')).toContain('"negotiateLocale"');
  });

  it('is refused without a real reason, when stale, and for a name of the table', () => {
    expectGuardFails(
      asGuard((candidate) => scan(candidate, [{ ...exemption, reason: 'needed' }]).exemptions),
      tree,
      { name: 'short reason', reason: 'give a reason of at least 40 characters' },
    );
    expectGuardFails(
      asGuard((candidate) => scan(candidate, [exemption]).exemptions),
      withFile(realTree, FILE, 'export const answer = 42;\n'),
      { name: 'stale', reason: `exemption ${FILE} [pickLocale]: stale` },
    );
    expectGuardFails(
      asGuard(
        (candidate) =>
          scan(candidate, [{ path: FILE, name: 'detectLocale', reason: REASON }]).exemptions,
      ),
      withFile(realTree, FILE, 'export function detectLocale() {}\n'),
      { name: 'table name', reason: 'a name of the table can never be excused' },
    );
  });
});

describe('single implementation: a row must protect something once its module has landed (G0 defect D19)', () => {
  const STUB = 'export {};\n';

  it('lets a stub home define nothing (the modules have not landed yet)', () => {
    expect(checkLanded(realTree)).toEqual([]);
    for (const concept of CONCEPTS) {
      expect(
        checkLanded(withFile(realTree, concept.home, `// stub of ${concept.id}\n${STUB}`)),
      ).toEqual([]);
    }
  });

  it.each(CONCEPTS.map((concept) => [concept.id, concept.home] as const))(
    '%s: a home with code that defines none of its names fails',
    (id, home) => {
      expectGuardFails(
        asGuard(checkLanded),
        withFile(realTree, home, 'export const somethingElse = (a: number) => a;\n'),
        {
          name: id,
          reason: new RegExp(`${home.replace(/\./g, '\\.')}: the module has code but defines no `),
        },
      );
    },
  );

  it('fails a module that defines only part of its row', () => {
    expectGuardFails(
      asGuard(checkLanded),
      withFile(
        realTree,
        `${SHARED_SRC}branding/org-name.ts`,
        'export function normalizeOrgName(raw: string): string { return raw; }\n',
      ),
      { name: 'half a row', reason: 'defines no shortOrgName' },
    );
  });

  it('accepts a module that defines every name of its row once', () => {
    for (const concept of CONCEPTS) {
      const names = concept.required.map((entry) =>
        typeof entry === 'string' ? entry : (entry[0] ?? ''),
      );
      const code = names.map((name) => `export function ${name}(): void {}`).join('\n');
      const tree = withFile(realTree, concept.home, `${code}\n`);
      expect(problemsAt(checkAll, tree, concept.home), concept.id).toEqual([]);
    }
  });

  it('asks the contrast row for one helper, not for all six plausible spellings', () => {
    const contrast = CONCEPTS.find((concept) => concept.id === 'contrast');
    const home = contrast?.home ?? '';
    const tree = withFile(
      realTree,
      home,
      'export function contrastRatio(): number { return 1; }\n',
    );
    expect(problemsAt(checkLanded, tree, home)).toEqual([]);
  });

  it('counts a re-export as no definition: the home must define the name itself', () => {
    expectGuardFails(
      asGuard(checkLanded),
      withFile(
        realTree,
        `${SHARED_SRC}permissions.ts`,
        "export { PERMISSIONS, hasAnyPermission } from './elsewhere.js';\n",
      ),
      { name: 're-export', reason: 'defines no PERMISSIONS' },
    );
  });

  it('every row names what it requires, and every required name is one of its names', () => {
    for (const concept of CONCEPTS) {
      expect(concept.required.length, concept.id).toBeGreaterThan(0);
      for (const entry of concept.required) {
        for (const name of typeof entry === 'string' ? [entry] : entry) {
          expect(concept.names, `${concept.id}: ${name}`).toContain(name);
        }
      }
    }
  });
});
