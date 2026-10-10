// Canary cases for local/no-trusted-types-policy-elsewhere (FR-A-042): scope
// apps/web/src/**/*.{ts,tsx} except apps/web/src/lib/sw-register.ts, the one module that creates
// the Trusted Types policy the CSP allows.
import type { CanaryCase } from '../canary-case.js';

const RULE = 'local/no-trusted-types-policy-elsewhere';

const CREATE_POLICY = `
export function makePolicy(): unknown {
  return window.trustedTypes?.createPolicy('m365portal-sw', {
    createScriptURL: (value: string) => value,
  });
}
`;

export const cases = [
  {
    name: 'a policy created outside the registration module',
    path: 'apps/web/src/__lint_canary__/tt-policy.ts',
    code: CREATE_POLICY,
    mustReport: [RULE],
  },
  {
    name: 'a policy created through a const alias',
    path: 'apps/web/src/__lint_canary__/tt-alias.ts',
    code: `
const factory = window.trustedTypes;
export const policy = factory?.createPolicy('other', {});
`,
    mustReport: [RULE],
  },
  {
    name: 'control: using the Trusted Types API without creating a policy is allowed',
    path: 'apps/web/src/__lint_canary__/tt-check.ts',
    code: `
export function isSafe(value: unknown): boolean {
  return window.trustedTypes?.isHTML(value) ?? false;
}
`,
    mustNotReport: [RULE],
  },
  {
    name: 'control: the registration module may create the policy',
    path: 'apps/web/src/lib/sw-register.ts',
    code: CREATE_POLICY,
    mustNotReport: [RULE],
  },
  {
    name: 'control: the rule is scoped to the web package (shared)',
    path: 'packages/shared/src/__lint_canary__/tt-policy.ts',
    code: CREATE_POLICY,
    mustNotReport: [RULE],
  },
  // G0 defects D13 and D15: a factory reached in a way other than "const alias = window.trustedTypes".
  {
    name: 'a policy created through a fallback (window.trustedTypes ?? polyfill)',
    path: 'apps/web/src/__lint_canary__/tt-fallback.ts',
    code: `
declare const polyfill: TrustedTypePolicyFactory;
const tt = window.trustedTypes ?? polyfill;
export const policy = tt.createPolicy('other', {});
`,
    mustReport: [RULE],
  },
  {
    name: 'a policy created through a factory passed in as a parameter',
    path: 'apps/web/src/__lint_canary__/tt-parameter.ts',
    // The DOM library of TypeScript does not declare the Trusted Types API; @types/trusted-types or
    // a module's own declaration does, under the name the rule looks for.
    code: `
interface TrustedTypePolicyFactory {
  createPolicy(name: string, rules: object): unknown;
}
export function make(factory: TrustedTypePolicyFactory): unknown {
  return factory.createPolicy('other', {});
}
`,
    mustReport: [RULE],
  },
  {
    name: 'a policy created through a getter and through globalThis.window',
    path: 'apps/web/src/__lint_canary__/tt-getter.ts',
    code: `
const get = () => window.trustedTypes;
export const a = get()?.createPolicy('other', {});
export const b = globalThis.window.trustedTypes?.createPolicy('other', {});
`,
    mustReport: [RULE],
  },
  {
    name: 'a source folder that shares the name of build output is linted (coverage)',
    path: 'apps/web/src/features/coverage/tt-policy.ts',
    code: CREATE_POLICY,
    mustReport: [RULE],
  },
] as const satisfies readonly CanaryCase[];
