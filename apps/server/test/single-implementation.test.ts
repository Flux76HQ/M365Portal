// T-B-393 (FR-B-713, TB-05, XB23): one implementation per concept on the server side. The names that
// `packages/shared/test/single-implementation.test.ts` guards live in the shared package; these live in
// `apps/server/src` or in the shared cookie module, and each must be defined exactly once, in its home:
//
//   signClientAssertion   integrations/identity/client-assertion.ts   the one signer of client assertions
//   sealSecret, openSecret  secrets/sealed-box.ts                     the only AEAD seal and open
//   backoffDelay          setup/backoff.ts                            the one retry schedule
//   classifyFailure       setup/classify.ts                           the one failure classifier
//   hashSessionId, csrfBindingFor  policy/session-hash.ts             the one session hash and CSRF binding
//   serializeCookie       packages/shared/src/auth/cookies.ts         the one Set-Cookie writer
//   chunkIds, mapLimited  ports/batching.ts                           the one 20-id chunker and fan-out
//
// A definition is a function, a method or a variable with a function value, anywhere in `apps/*/src`
// and `packages/shared/src` (tests excluded), found with the TypeScript parser, so a comment, a string
// or an import never counts. A second definition fails and names both. Tell-tales (a hand-written
// `slice(at, at + 20)`, a second fan-out loop over `Promise.all` workers) fail too.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectGuardFails } from '@m365portal/shared/testing';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SCANNED_ROOTS = ['apps/server/src', 'apps/web/src', 'packages/shared/src'];

type Tree = ReadonlyMap<string, string>;

const HOMES: Readonly<Record<string, string>> = {
  signClientAssertion: 'apps/server/src/integrations/identity/client-assertion.ts',
  sealSecret: 'apps/server/src/secrets/sealed-box.ts',
  openSecret: 'apps/server/src/secrets/sealed-box.ts',
  backoffDelay: 'apps/server/src/setup/backoff.ts',
  classifyFailure: 'apps/server/src/setup/classify.ts',
  hashSessionId: 'apps/server/src/policy/session-hash.ts',
  csrfBindingFor: 'apps/server/src/policy/session-hash.ts',
  serializeCookie: 'packages/shared/src/auth/cookies.ts',
  chunkIds: 'apps/server/src/ports/batching.ts',
  mapLimited: 'apps/server/src/ports/batching.ts',
};

function walk(directory: string, into: string[]): void {
  for (const name of readdirSync(directory)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) walk(path, into);
    else if (/\.[cm]?tsx?$/.test(name) && !name.endsWith(".d.ts")) into.push(path);
  }
}

function loadTree(): Tree {
  const files: string[] = [];
  for (const root of SCANNED_ROOTS) walk(join(ROOT, root), files);
  return new Map(
    files.map((file) => [relative(ROOT, file).replaceAll('\\', '/'), readFileSync(file, 'utf8')]),
  );
}

function isFunctionLike(expression: ts.Expression): boolean {
  let value = expression;
  while (ts.isParenthesizedExpression(value) || ts.isAsExpression(value)) value = value.expression;
  return ts.isArrowFunction(value) || ts.isFunctionExpression(value);
}

interface Definition {
  readonly name: string;
  readonly path: string;
  readonly line: number;
}

/** Every named function of a file: declarations, methods and variables or members with a function value. */
const definitionMemo = new Map<string, Definition[]>();
const chunkerMemo = new Map<string, number[]>();

function definitionsIn(path: string, text: string): Definition[] {
  const key = `${path}\u0000${text}`;
  const cached = definitionMemo.get(key);
  if (cached !== undefined) return cached;
  const found = computeDefinitions(path, text);
  definitionMemo.set(key, found);
  return found;
}

function computeDefinitions(path: string, text: string): Definition[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const found: Definition[] = [];
  const add = (name: ts.Node | undefined, node: ts.Node): void => {
    if (name === undefined || !(ts.isIdentifier(name) || ts.isStringLiteralLike(name))) return;
    found.push({
      name: name.text,
      path,
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
    });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.body !== undefined) add(node.name, node);
    else if (ts.isMethodDeclaration(node) && node.body !== undefined) add(node.name, node);
    else if (
      (ts.isVariableDeclaration(node) ||
        ts.isPropertyAssignment(node) ||
        ts.isPropertyDeclaration(node)) &&
      node.initializer !== undefined &&
      isFunctionLike(node.initializer)
    ) {
      add(node.name, node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** The sites of a hand-written 20-id chunker: a slice by `+ 20`, a loop stepping by 20, a splice of 20. */
function chunkerSites(path: string, text: string): number[] {
  const key = `${path}\u0000${text}`;
  const cached = chunkerMemo.get(key);
  if (cached !== undefined) return cached;
  const found = computeChunkerSites(path, text);
  chunkerMemo.set(key, found);
  return found;
}

function computeChunkerSites(path: string, text: string): number[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const lines: number[] = [];
  const note = (node: ts.Node): void => {
    lines.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
  };
  const isTwenty = (node: ts.Node | undefined): boolean =>
    node !== undefined && ts.isNumericLiteral(node) && node.text === '20';
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const second = node.arguments[1];
      if (
        method === 'slice' &&
        second !== undefined &&
        ts.isBinaryExpression(second) &&
        second.operatorToken.kind === ts.SyntaxKind.PlusToken &&
        isTwenty(second.right)
      ) {
        note(node);
      }
      if (method === 'splice' && isTwenty(second)) note(node);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken &&
      isTwenty(node.right)
    ) {
      note(node);
    }
    // The constant of the Graph limit, read outside the module that owns the chunker.
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'graphCheckMemberGroupsMaxIds') {
      note(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return lines;
}

/** The chunker may be read in its home and where the constant is defined; nowhere else. */
const CHUNKER_ALLOWED = new Set([
  'apps/server/src/ports/batching.ts',
  'packages/shared/src/limits.ts',
]);

function singleImplementationProblems(tree: Tree): string[] {
  const problems: string[] = [];
  const definitions = new Map<string, Definition[]>();
  for (const [path, text] of tree) {
    for (const definition of definitionsIn(path, text)) {
      if (!(definition.name in HOMES)) continue;
      definitions.set(definition.name, [...(definitions.get(definition.name) ?? []), definition]);
    }
    if (!CHUNKER_ALLOWED.has(path)) {
      for (const line of chunkerSites(path, text)) {
        problems.push(
          `${path}:${String(line)}: a hand-written chunker of 20 ids; the one is chunkIds in ${HOMES.chunkIds ?? ''} (FR-B-713)`,
        );
      }
    }
  }
  for (const [name, home] of Object.entries(HOMES)) {
    const found = definitions.get(name) ?? [];
    const inHome = found.filter((definition) => definition.path === home);
    if (inHome.length === 0) problems.push(`${home}: ${name} is not defined in its home`);
    if (inHome.length > 1)
      problems.push(`${home}: ${name} is defined ${String(inHome.length)} times`);
    for (const definition of found) {
      if (definition.path !== home) {
        problems.push(
          `${definition.path}:${String(definition.line)}: a second definition of ${name}; the one implementation is ${home} (FR-B-713)`,
        );
      }
    }
  }
  return problems;
}

function assertSingle(tree: Tree): void {
  const problems = singleImplementationProblems(tree);
  if (problems.length > 0) throw new Error(problems.join('\n'));
}

const realTree = loadTree();
const withFile = (path: string, text: string): Tree => new Map([...realTree, [path, text]]);

describe('one implementation per concept on the server (FR-B-713)', () => {
  it('reads enough of the tree to mean something', () => {
    expect(realTree.size).toBeGreaterThan(300);
    for (const home of Object.values(HOMES)) expect(realTree.has(home), home).toBe(true);
  });

  it('defines every name once, in its home, and chunks ids in one place', () => {
    expect(singleImplementationProblems(realTree)).toEqual([]);
  });

  describe('negative fixtures: a second definition fails on purpose', () => {
    it.each(Object.keys(HOMES))('%s defined again in the server fails', (name) => {
      expectGuardFails(
        assertSingle,
        withFile('apps/server/src/second.ts', `export const ${name} = (): void => undefined;\n`),
        { reason: new RegExp(`apps/server/src/second\\.ts:1: a second definition of ${name}`) },
      );
    });

    it('a method of the same name counts, and so does a function in the web package', () => {
      expectGuardFails(
        assertSingle,
        withFile(
          'apps/server/src/second.ts',
          'export class A { hashSessionId(): string { return ""; } }\n',
        ),
        { reason: /a second definition of hashSessionId/ },
      );
      expectGuardFails(
        assertSingle,
        withFile(
          'apps/web/src/lib/second.ts',
          'export function serializeCookie(): string { return ""; }\n',
        ),
        { reason: /apps\/web\/src\/lib\/second\.ts:1: a second definition of serializeCookie/ },
      );
    });

    it('a name that is missing from its home fails', () => {
      const home = HOMES.openSecret ?? '';
      const without = new Map(realTree);
      without.set(
        home,
        (realTree.get(home) ?? '').replace(
          'export function openSecret',
          'export function openSecretX',
        ),
      );
      expectGuardFails(assertSingle, without, { reason: /openSecret is not defined in its home/ });
    });

    it.each([
      [
        'a slice by 20',
        'export const cut = (ids: string[], at: number) => ids.slice(at, at + 20);\n',
      ],
      [
        'a loop stepping by 20',
        'export function run(n: number) { for (let i = 0; i < n; i += 20) void i; }\n',
      ],
      ['a splice of 20', 'export const take = (ids: string[]) => ids.splice(0, 20);\n'],
      [
        'the Graph constant read elsewhere',
        "import { LIMITS } from '@m365portal/shared/limits';\nexport const size = LIMITS.microsoft.graphCheckMemberGroupsMaxIds;\n",
      ],
    ])('%s fails as a second chunker', (_label, code) => {
      expectGuardFails(assertSingle, withFile('apps/server/src/rbac/chunks.ts', code), {
        reason: /a hand-written chunker of 20 ids/,
      });
    });
  });

  describe('what stays allowed', () => {
    it('calls and imports of the shared functions', () => {
      const code =
        "import { hashSessionId } from '../policy/session-hash.js';\nexport const own = (v: string) => hashSessionId(v);\nexport const alias = hashSessionId;\n";
      expect(() => {
        assertSingle(withFile('apps/server/src/consumer.ts', code));
      }).not.toThrow();
    });

    it('a slice by another number and a loop stepping by another number', () => {
      const code =
        'export const cut = (a: string[], i: number) => a.slice(i, i + 25);\nexport function f(n: number) { for (let i = 0; i < n; i += 10) void i; }\n';
      expect(() => {
        assertSingle(withFile('apps/server/src/other.ts', code));
      }).not.toThrow();
    });
  });
});
