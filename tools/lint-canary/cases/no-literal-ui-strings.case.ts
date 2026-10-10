// Canary cases for local/no-literal-ui-strings (FR-A-115): scope apps/web/src/**/*.tsx, tests excluded.
import type { CanaryCase } from '../canary-case.js';

const RULE = 'local/no-literal-ui-strings';

const OFFENDING_TEXT = `
export function Title() {
  return <h1>Dashboard</h1>;
}
`;

export const cases = [
  {
    name: 'a literal text in JSX',
    path: 'apps/web/src/__lint_canary__/ui-text.tsx',
    code: OFFENDING_TEXT,
    mustReport: [RULE],
  },
  {
    name: 'a literal in a user-facing attribute',
    path: 'apps/web/src/__lint_canary__/ui-attribute.tsx',
    code: `
export function CloseButton() {
  return <button type="button" aria-label="Close dialog" />;
}
`,
    mustReport: [RULE],
  },
  {
    name: 'a literal inside braces, in a conditional',
    path: 'apps/web/src/__lint_canary__/ui-braces.tsx',
    code: `
export function State({ open }: { open: boolean }) {
  return <span>{open ? 'Open' : 'Closed'}</span>;
}
`,
    mustReport: [RULE],
  },
  {
    name: 'control: a catalogue call is allowed',
    path: 'apps/web/src/__lint_canary__/ui-catalogue.tsx',
    code: `
declare function t(key: string): string;
export function Title() {
  return <h1 title={t('dashboard.title')}>{t('dashboard.title')}</h1>;
}
`,
    mustNotReport: [RULE],
  },
  {
    name: 'control: punctuation, digits and symbols are allowed',
    path: 'apps/web/src/__lint_canary__/ui-symbols.tsx',
    code: `
export function Price({ amount }: { amount: number }) {
  return <span>{amount} — 12:30 © 2026 →</span>;
}
`,
    mustNotReport: [RULE],
  },
  {
    name: 'control: the same text in a test file of the web package is allowed',
    path: 'apps/web/src/__lint_canary__/ui-text.test.tsx',
    code: OFFENDING_TEXT,
    mustNotReport: [RULE],
  },
  {
    name: 'control: the rule is scoped to the web package (shared)',
    path: 'packages/shared/src/__lint_canary__/ui-text.tsx',
    code: OFFENDING_TEXT,
    mustNotReport: [RULE],
  },
  {
    name: 'control: the rule is scoped to the web package (server)',
    path: 'apps/server/src/__lint_canary__/ui-text.tsx',
    code: OFFENDING_TEXT,
    mustNotReport: [RULE],
  },
] as const satisfies readonly CanaryCase[];
