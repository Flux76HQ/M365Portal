// local/no-trusted-types-policy-elsewhere (FR-A-042): the CSP allows exactly one Trusted Types
// policy name, and exactly one module creates it (apps/web/src/lib/sw-register.ts). Any other
// trustedTypes.createPolicy call is refused.
import type { RuleTester } from 'eslint';
import { describe, expect, it } from 'vitest';
import { createRuleTester, ruleOf, scopeOf, STRICT_ASSERTIONS } from './support.js';

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

describe('local/no-trusted-types-policy-elsewhere: scope', () => {
  it('applies to the whole web source except the service worker registration module', () => {
    const scope = scopeOf('no-trusted-types-policy-elsewhere');

    expect(scope.files).toEqual(['apps/web/src/**/*.{ts,tsx}']);
    expect(scope.ignores).toEqual(['apps/web/src/lib/sw-register.ts']);
  });
});
