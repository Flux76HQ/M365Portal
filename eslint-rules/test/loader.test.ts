// The loader of the local ESLint plugin (eslint-rules/index.js). It scans eslint-rules/rules/*.js,
// checks that every module is complete and turns each declared scope into a flat-config entry, so a
// later rule is "one new file" and never an edit of eslint.config.js.
//
// Its failure modes are tested with negative fixtures: a rule without a scope would silently apply
// to the whole repository (or to nothing), which is exactly the kind of mistake a guard exists for.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expectGuardFails } from '../../packages/shared/src/testing/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildConfigs,
  buildPlugin,
  configs,
  loadRuleModules,
  PLUGIN_NAME,
  plugin,
  rules,
  scopes,
  validateRuleModule,
} from '../index.js';

const VALID_MODULE_SOURCE = `
export const meta = {
  type: 'problem',
  docs: { description: 'A rule that never reports.' },
  messages: { never: 'never' },
  schema: [],
};
export function create() { return {}; }
export const scope = { files: ['apps/web/src/**/*.tsx'], ignores: ['apps/web/src/**/*.test.tsx'] };
`;

describe('local plugin loader: the real rules directory', () => {
  it('loads at least the rules of T-A-006 to T-A-008 and names each rule after its file', () => {
    expect(Object.keys(rules)).toEqual(
      expect.arrayContaining([
        'no-literal-ui-strings',
        'no-raw-colour',
        'no-string-built-sql',
        'no-dangerous-html',
        'no-direct-storage',
        'no-trusted-types-policy-elsewhere',
        'no-direct-route-registration',
      ]),
    );
    expect(Object.keys(scopes).sort()).toEqual(Object.keys(rules).sort());
    expect(plugin.rules).toBe(rules);
  });

  it('builds exactly one flat-config entry per rule, enabled as an error, with the declared scope', () => {
    expect(configs).toHaveLength(Object.keys(rules).length);
    for (const entry of configs) {
      const name = String(entry.name).slice(`${PLUGIN_NAME}/`.length);
      const scope = scopes[name];
      expect(scope, name).toBeDefined();
      expect(entry.files, name).toEqual(scope?.files);
      expect(entry.ignores, name).toEqual(scope?.ignores);
      expect(entry.plugins?.[PLUGIN_NAME], name).toBe(plugin);
      expect(entry.rules, name).toEqual({ [`${PLUGIN_NAME}/${name}`]: 'error' });
    }
  });

  it('gives every rule a scope inside one package, never the whole repository', () => {
    for (const [name, scope] of Object.entries(scopes)) {
      for (const pattern of scope.files) {
        expect(pattern, name).toMatch(/^(?:apps|packages|e2e|tools)\//);
      }
    }
  });
});

describe('local plugin loader: fixture directories', () => {
  let directory = '';

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'm365portal-eslint-rules-'));
  });
  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  function fixture(name: string, files: Readonly<Record<string, string>>): URL {
    const target = join(directory, name);
    mkdirSync(target, { recursive: true });
    for (const [file, source] of Object.entries(files)) writeFileSync(join(target, file), source);
    return pathToFileURL(`${target}/`);
  }

  it('loads every *.js file and ignores the rest', async () => {
    const url = fixture('good', {
      'first-rule.js': VALID_MODULE_SOURCE,
      'second-rule.js': VALID_MODULE_SOURCE,
      'notes.md': 'not a rule',
      'helper.d.ts': 'export {};',
    });

    const entries = await loadRuleModules(url);

    expect(entries.map((entry) => entry.name)).toEqual(['first-rule', 'second-rule']);
    const built = buildPlugin(entries);
    expect(Object.keys(built.rules)).toEqual(['first-rule', 'second-rule']);
    const entriesBuilt = buildConfigs(entries, built);
    expect(entriesBuilt.map((entry) => entry.name)).toEqual([
      'local/first-rule',
      'local/second-rule',
    ]);
  });

  it('refuses an empty directory (a scan of nothing proves nothing)', async () => {
    const url = fixture('empty', { 'readme.txt': 'no rules here' });

    await expectGuardFails(loadRuleModules, url, {
      name: 'loader on an empty directory',
      reason: /no rule modules/,
    });
  });

  it('refuses a rule module without a scope', async () => {
    const url = fixture('no-scope', {
      'no-scope.js': VALID_MODULE_SOURCE.replace(/export const scope[^\n]*\n/, ''),
    });

    await expectGuardFails(loadRuleModules, url, {
      name: 'loader on a rule without scope',
      reason: /no-scope\.js[\s\S]*scope/,
    });
  });

  it('refuses a rule file whose name is not a kebab-case identifier', async () => {
    const url = fixture('bad-name', { 'NoScope.js': VALID_MODULE_SOURCE });

    await expectGuardFails(loadRuleModules, url, {
      name: 'loader on a badly named rule',
      reason: /NoScope\.js/,
    });
  });
});

describe('local plugin loader: validateRuleModule', () => {
  const valid = {
    meta: {
      type: 'problem',
      docs: { description: 'text' },
      messages: { never: 'never' },
      schema: [],
    },
    create: () => ({}),
    scope: { files: ['apps/web/src/**/*.tsx'], ignores: [] },
  };

  it('accepts a complete module', () => {
    expect(() => {
      validateRuleModule('complete', valid);
    }).not.toThrow();
  });

  it.each([
    ['a missing create function', { ...valid, create: undefined }, /create/],
    ['a missing meta', { ...valid, meta: undefined }, /meta/],
    [
      'meta without messages',
      { ...valid, meta: { ...valid.meta, messages: undefined } },
      /messages/,
    ],
    ['meta without a schema', { ...valid, meta: { ...valid.meta, schema: undefined } }, /schema/],
    ['meta without a description', { ...valid, meta: { ...valid.meta, docs: {} } }, /description/],
    ['a missing scope', { ...valid, scope: undefined }, /scope/],
    ['an empty files list', { ...valid, scope: { files: [], ignores: [] } }, /scope\.files/],
    ['a missing ignores list', { ...valid, scope: { files: ['apps/x/**'] } }, /scope\.ignores/],
    [
      'a scope pattern with a leading slash',
      { ...valid, scope: { files: ['/apps/web/**'], ignores: [] } },
      /relative/,
    ],
    [
      'a scope pattern with a leading ./',
      { ...valid, scope: { files: ['./apps/web/**'], ignores: [] } },
      /relative/,
    ],
    [
      'a scope pattern that matches every file',
      { ...valid, scope: { files: ['**/*.tsx'], ignores: [] } },
      /whole repository/,
    ],
  ])('refuses %s', (_description, module, reason) => {
    expectGuardFails(
      (candidate: unknown) => {
        validateRuleModule('broken', candidate);
      },
      module,
      { name: 'validateRuleModule', reason },
    );
  });
});
