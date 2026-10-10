// local/no-trusted-types-policy-elsewhere (FR-A-042): the CSP allows exactly one Trusted Types
// policy name, and exactly one module creates it (apps/web/src/lib/sw-register.ts). Any other
// trustedTypes.createPolicy call is refused.
//
// Two suites: the first has no type information and follows the factory through constants, lets,
// fallbacks, conditionals and small functions; the second has types and recognises the factory by
// its type (TrustedTypePolicyFactory), whatever it is called and however it was reached.
import type { RuleTester } from 'eslint';
import { describe, expect, it } from 'vitest';
import {
  createRuleTester,
  createTypedRuleTester,
  ruleOf,
  scopeOf,
  STRICT_ASSERTIONS,
} from './support.js';

const FILE = 'apps/web/src/lib/other.ts';
const rule = ruleOf('no-trusted-types-policy-elsewhere');

function validCase(code: string, name?: string): RuleTester.ValidTestCase {
  return { name: name ?? code, code, filename: FILE };
}

function elsewhere(code: string, name?: string): RuleTester.InvalidTestCase {
  return {
    name: name ?? code,
    code,
    filename: FILE,
    errors: [{ messageId: 'policyElsewhere' }],
  };
}

createRuleTester().run('local/no-trusted-types-policy-elsewhere', rule, {
  assertionOptions: STRICT_ASSERTIONS,
  valid: [
    validCase('window.trustedTypes?.isHTML(value);', 'other Trusted Types API'),
    validCase('trustedTypes.emptyHTML;'),
    validCase('policy.createScriptURL(url);', 'a method of a policy that already exists'),
    validCase("api.createPolicy({ name: 'x' });", 'an unrelated object with a method of that name'),
    validCase("createPolicy('x');", 'a plain function of that name'),
    validCase(
      'const tt = window.trustedTypes; tt?.isScript(x);',
      'an alias used for something else',
    ),
    validCase('const { isHTML } = window.trustedTypes!;', 'destructuring another member'),
    validCase("const name = 'createPolicy';", 'the word in a string'),
    validCase(
      "const tt = polyfill; tt.createPolicy('x', {});",
      'a factory that is not trustedTypes',
    ),
    validCase(
      "const tt = window.name ?? polyfill; tt.createPolicy('x', {});",
      'a fallback of something else',
    ),
    validCase(
      "const get = () => polyfill; get().createPolicy('x', {});",
      'a function that returns something else',
    ),
    validCase(
      "let tt = polyfill; tt = other; tt.createPolicy('x', {});",
      'a let that never holds it',
    ),
    validCase(
      "const { name: tt } = window; tt.createPolicy('x', {});",
      'destructuring another global',
    ),
    validCase(
      'const a = cond ? window.trustedTypes : undefined; a?.isHTML(x);',
      'used for something else',
    ),
  ],

  invalid: [
    elsewhere("trustedTypes.createPolicy('x', {});"),
    elsewhere("window.trustedTypes.createPolicy('x', {});", 'through window'),
    elsewhere("window.trustedTypes?.createPolicy('x', {});", 'optional chain'),
    elsewhere("globalThis.trustedTypes!.createPolicy('x', {});", 'non-null assertion'),
    elsewhere("self.trustedTypes.createPolicy('x', {});", 'through self'),
    elsewhere("window['trustedTypes']['createPolicy']('x', {});", 'computed keys'),
    elsewhere("const tt = window.trustedTypes; tt?.createPolicy('x', {});", 'through an alias'),
    elsewhere(
      "const a = window.trustedTypes; const b = a; b?.createPolicy('x', {});",
      'through two aliases',
    ),
    elsewhere('const make = trustedTypes.createPolicy;', 'referenced, not called'),
    elsewhere('const { createPolicy } = window.trustedTypes!;', 'destructured'),
    elsewhere("trustedTypes.createPolicy.call(trustedTypes, 'x', {});", 'called through call()'),
    // The factory reached in a way other than "const alias = window.trustedTypes" (G0 defect D13).
    elsewhere(
      "const tt = window.trustedTypes ?? polyfill; tt.createPolicy('x', {});",
      'a fallback to a polyfill',
    ),
    elsewhere(
      "const tt = polyfill || window.trustedTypes; tt.createPolicy('x', {});",
      'a fallback, the factory on the right',
    ),
    elsewhere(
      "const tt = cond ? window.trustedTypes : undefined; tt?.createPolicy('x', {});",
      'a conditional',
    ),
    elsewhere("let tt = window.trustedTypes; tt?.createPolicy('x', {});", 'a let'),
    elsewhere(
      "let tt; if (ready) { tt = window.trustedTypes; } tt?.createPolicy('x', {});",
      'a let assigned later',
    ),
    elsewhere(
      "const get = () => window.trustedTypes; get()?.createPolicy('x', {});",
      'a getter (arrow)',
    ),
    elsewhere(
      "function get() { return window.trustedTypes; } get()!.createPolicy('x', {});",
      'a getter (function declaration)',
    ),
    elsewhere(
      "const get = function () { if (a) { return undefined; } return trustedTypes; }; get()?.createPolicy('x', {});",
      'a getter with a branch',
    ),
    elsewhere(
      "(() => window.trustedTypes)()?.createPolicy('x', {});",
      'an immediately invoked arrow',
    ),
    elsewhere("globalThis.window.trustedTypes.createPolicy('x', {});", 'globalThis.window'),
    elsewhere("window.top.trustedTypes.createPolicy('x', {});", 'window.top'),
    elsewhere(
      "const { trustedTypes: tt } = window; tt.createPolicy('x', {});",
      'destructured off the window',
    ),
    elsewhere(
      "const { trustedTypes } = globalThis; trustedTypes.createPolicy('x', {});",
      'destructured, same name',
    ),
    elsewhere(
      "const tt = (window.trustedTypes || polyfill) as Factory; tt.createPolicy('x', {});",
      'behind a type assertion',
    ),
    elsewhere(
      "window['trusted' + 'Types'].createPolicy('x', {});",
      'a key built from two literals',
    ),
    elsewhere("const w = window; w.trustedTypes.createPolicy('x', {});", 'a const alias of window'),
    elsewhere(
      "const w = globalThis.window; const { trustedTypes: tt } = w; tt.createPolicy('x', {});",
      'destructured from an alias',
    ),
    elsewhere(
      'const { createPolicy } = window.trustedTypes ?? polyfill;',
      'destructured from a fallback',
    ),
    {
      name: 'every call is reported',
      code: "trustedTypes.createPolicy('a', {});\ntrustedTypes.createPolicy('b', {});",
      filename: FILE,
      errors: [
        { messageId: 'policyElsewhere', line: 1 },
        { messageId: 'policyElsewhere', line: 2 },
      ],
    },
  ],
});

// ---------------------------------------------------------------------------------------------
// With type information: the receiver's type decides.
// ---------------------------------------------------------------------------------------------

const PRELUDE = `export {};
declare class TrustedTypePolicyFactory {
  createPolicy(name: string, rules: object): unknown;
  isHTML(value: unknown): boolean;
}
declare class PolicyStore {
  createPolicy(name: string): unknown;
}
`;

let typedFileCount = 0;
const typedFilenames: string[] = [];

function typedFile(): string {
  typedFileCount += 1;
  const filename = `apps/web/src/__rule_tester__/typed-${String(typedFileCount)}.ts`;
  typedFilenames.push(filename);
  return filename;
}

const typedValidCases: RuleTester.ValidTestCase[] = [
  {
    name: 'a store that is not the factory',
    code: `${PRELUDE}declare const store: PolicyStore;\nstore.createPolicy('x');`,
    filename: typedFile(),
  },
  {
    name: 'the factory used for something else',
    code: `${PRELUDE}declare const factory: TrustedTypePolicyFactory;\nfactory.isHTML(1);`,
    filename: typedFile(),
  },
];

const typedInvalidCases: RuleTester.InvalidTestCase[] = [
  {
    name: 'a factory passed in as a parameter',
    code: `${PRELUDE}export function make(f: TrustedTypePolicyFactory) {\n  return f.createPolicy('x', {});\n}`,
    filename: typedFile(),
    errors: [{ messageId: 'policyElsewhere' }],
  },
  {
    name: 'a factory in a field of a class',
    code: `${PRELUDE}export class Holder {\n  constructor(private readonly factory: TrustedTypePolicyFactory) {}\n  make() {\n    return this.factory.createPolicy('x', {});\n  }\n}`,
    filename: typedFile(),
    errors: [{ messageId: 'policyElsewhere' }],
  },
  {
    name: 'a factory that may be undefined',
    code: `${PRELUDE}declare const maybe: TrustedTypePolicyFactory | undefined;\nmaybe?.createPolicy('x', {});`,
    filename: typedFile(),
    errors: [{ messageId: 'policyElsewhere' }],
  },
  {
    name: 'a factory returned by a function in another shape',
    code: `${PRELUDE}declare function obtain(): TrustedTypePolicyFactory;\nobtain().createPolicy('x', {});`,
    filename: typedFile(),
    errors: [{ messageId: 'policyElsewhere' }],
  },
];

createTypedRuleTester(typedFilenames).run('local/no-trusted-types-policy-elsewhere (types)', rule, {
  assertionOptions: STRICT_ASSERTIONS,
  valid: typedValidCases,
  invalid: typedInvalidCases,
});

describe('local/no-trusted-types-policy-elsewhere: scope', () => {
  it('applies to every kind of script of the web package except the service worker registration module', () => {
    const scope = scopeOf('no-trusted-types-policy-elsewhere');

    expect(scope.files).toEqual(['apps/web/{src,public}/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}']);
    expect(scope.ignores).toEqual(['apps/web/src/lib/sw-register.ts']);
  });
});
