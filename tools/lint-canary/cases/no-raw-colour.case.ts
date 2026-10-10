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
  // G0 defects D4, D5, D15, D20: where the rule looks, and what it takes for a colour.
  {
    name: 'a source folder that merely shares the name of build output is linted (coverage)',
    path: 'apps/web/src/features/coverage/colour-hex.ts',
    code: HEX,
    mustReport: [RULE],
  },
  {
    name: 'a module with the extension .mts is linted',
    path: 'apps/web/src/__lint_canary__/colour-hex.mts',
    code: HEX,
    mustReport: [RULE],
  },
  {
    name: 'a module with the extension .cts is linted',
    path: 'apps/web/src/__lint_canary__/colour-hex.cts',
    code: HEX,
    mustReport: [RULE],
  },
  {
    name: 'plain JavaScript (.js) is linted',
    path: 'apps/web/src/__lint_canary__/colour-hex.js',
    code: HEX,
    mustReport: [RULE],
  },
  {
    name: 'JSX in a .jsx file is linted',
    path: 'apps/web/src/__lint_canary__/colour-style.jsx',
    code: `
export function Swatch() {
  return <div style={{ color: '#1a2b3c' }} />;
}
`,
    mustReport: [RULE],
  },
  {
    name: 'a .mjs and a .cjs module are linted',
    path: 'apps/web/src/__lint_canary__/colour-hex.mjs',
    code: HEX,
    mustReport: [RULE],
  },
  {
    name: 'a static file of the web package (public/offline.js) is linted',
    path: 'apps/web/public/__lint_canary__/offline.js',
    code: HEX,
    mustReport: [RULE],
  },
  {
    name: 'a named colour in a style object',
    path: 'apps/web/src/__lint_canary__/colour-named.tsx',
    code: `
export function Swatch() {
  return <div style={{ color: 'red', background: 'white' }} />;
}
`,
    mustReport: [RULE],
  },
  {
    name: 'a named colour in a colour attribute',
    path: 'apps/web/src/__lint_canary__/colour-fill.tsx',
    code: `
export function Dot() {
  return <circle fill="black" r="2" />;
}
`,
    mustReport: [RULE],
  },
  {
    name: 'a named colour in a Tailwind arbitrary property and in light-dark()',
    path: 'apps/web/src/__lint_canary__/colour-light-dark.ts',
    code: `
export const classes = '[color:red] p-2';
export const scheme = 'light-dark(white, black)';
`,
    mustReport: [RULE],
  },
  {
    name: 'control: colours that come from a token are allowed (var() arguments, an anchor)',
    path: 'apps/web/src/__lint_canary__/colour-token-arguments.tsx',
    code: `
export const mixed = 'color-mix(in oklab, var(--accent) 20%, transparent)';
export const hue = 'hsl(var(--accent))';
export const classes = 'bg-[color:var(--accent)] shadow-[0_0_0_1px_var(--ring)]';
export function Skip() {
  return <a href="#add" style={{ color: 'var(--fg)', fill: 'currentColor' }} />;
}
`,
    mustNotReport: [RULE],
  },
] as const satisfies readonly CanaryCase[];
