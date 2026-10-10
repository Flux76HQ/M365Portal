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
] as const satisfies readonly CanaryCase[];
