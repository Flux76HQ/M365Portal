// Canary cases for local/no-literal-ui-strings (FR-A-115): scope apps/web/src/**/*.{tsx,jsx}; tests live in apps/web/test and are outside it.
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
    name: 'control: web tests live in apps/web/test, outside src, and may use literal text',
    path: 'apps/web/test/__lint_canary__/ui-text.test.tsx',
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
  // G0 defects D10, D15, D17: attributes that arrive through a spread, a variable, a component prop.
  {
    name: 'a user-facing attribute inside a spread object literal',
    path: 'apps/web/src/__lint_canary__/ui-spread-literal.tsx',
    code: `
export function Search() {
  return <input {...{ placeholder: 'Search users' }} />;
}
`,
    mustReport: [RULE],
  },
  {
    name: 'a user-facing attribute in an object that is spread',
    path: 'apps/web/src/__lint_canary__/ui-spread-variable.tsx',
    code: `
const props = { 'aria-label': 'Close dialog' };
export function Close() {
  return <button {...props} />;
}
`,
    mustReport: [RULE],
  },
  {
    name: 'a text kept in a constant and rendered',
    path: 'apps/web/src/__lint_canary__/ui-const-text.tsx',
    code: `
const heading = 'Users overview';
export function Title() {
  return <h1>{heading}</h1>;
}
`,
    mustReport: [RULE],
  },
  {
    name: 'the children attribute and the label of an option',
    path: 'apps/web/src/__lint_canary__/ui-children-label.tsx',
    code: `
declare function Button(props: { children: string }): null;
export function Pick() {
  return (
    <select>
      <option value="a" label="First choice" />
      <Button children="Save" />
    </select>
  );
}
`,
    mustReport: [RULE],
  },
  {
    name: 'the value of a submit button',
    path: 'apps/web/src/__lint_canary__/ui-submit.tsx',
    code: `
export function Send() {
  return <input type="submit" value="Send" />;
}
`,
    mustReport: [RULE],
  },
  {
    name: 'a component file named like a test under src is linted: tests live in apps/web/test',
    path: 'apps/web/src/__lint_canary__/ui-text.spec.tsx',
    code: OFFENDING_TEXT,
    mustReport: [RULE],
  },
  {
    name: 'a source folder that shares the name of build output is linted (coverage)',
    path: 'apps/web/src/features/coverage/ui-text.tsx',
    code: OFFENDING_TEXT,
    mustReport: [RULE],
  },
  {
    name: 'plain JSX in a .jsx file is linted',
    path: 'apps/web/src/__lint_canary__/ui-text.jsx',
    code: OFFENDING_TEXT,
    mustReport: [RULE],
  },
  {
    name: 'control: a value that is not text (a type, a number, a name) is allowed on an input',
    path: 'apps/web/src/__lint_canary__/ui-value-ok.tsx',
    code: `
export function Field({ value }: { value: string }) {
  return <input type="text" value={value} name="query" data-testid="query" />;
}
`,
    mustNotReport: [RULE],
  },
] as const satisfies readonly CanaryCase[];
