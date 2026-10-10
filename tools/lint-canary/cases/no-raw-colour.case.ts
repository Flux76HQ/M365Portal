// Canary cases for local/no-raw-colour (FR-A-009): scope apps/web/src/**/*.{ts,tsx}.
import type { CanaryCase } from '../canary-case.js';

const RULE = 'local/no-raw-colour';

const HEX = `
export const background = '#1a2b3c';
`;

export const cases = [
  {
    name: 'a hex colour in a TypeScript module',
    path: 'apps/web/src/__lint_canary__/colour-hex.ts',
    code: HEX,
    mustReport: [RULE],
  },
  {
    name: 'a colour function in an inline style',
    path: 'apps/web/src/__lint_canary__/colour-style.tsx',
    code: `
export function Swatch() {
  return <div style={{ color: 'rgb(1, 2, 3)' }} />;
}
`,
    mustReport: [RULE],
  },
  {
    name: 'a Tailwind arbitrary colour value',
    path: 'apps/web/src/__lint_canary__/colour-tailwind.ts',
    code: `
export const classes = 'p-2 bg-[oklch(0.5_0.1_20)] text-white';
`,
    mustReport: [RULE],
  },
  {
    name: 'a colour in a template literal',
    path: 'apps/web/src/__lint_canary__/colour-template.ts',
    code: `
export function border(width: number): string {
  return \`\${String(width)}px solid #ccc\`;
}
`,
    mustReport: [RULE],
  },
  {
    name: 'control: token utilities and custom properties are allowed',
    path: 'apps/web/src/__lint_canary__/colour-tokens.ts',
    code: `
export const classes = 'bg-surface text-fg border-border bg-accent/20';
export const reference = 'var(--accent)';
`,
    mustNotReport: [RULE],
  },
  {
    name: 'control: the design tokens themselves live in the shared package',
    path: 'packages/shared/src/__lint_canary__/colour-tokens.ts',
    code: HEX,
    mustNotReport: [RULE],
  },
  {
    name: 'control: the rule is scoped to the web package (server)',
    path: 'apps/server/src/__lint_canary__/colour-hex.ts',
    code: HEX,
    mustNotReport: [RULE],
  },
  {
    name: 'control: web tests live outside src and may name colours',
    path: 'apps/web/test/__lint_canary__/colour.test.ts',
    code: HEX,
    mustNotReport: [RULE],
  },
] as const satisfies readonly CanaryCase[];
