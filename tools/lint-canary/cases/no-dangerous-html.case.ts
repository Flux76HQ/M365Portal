// Canary cases for local/no-dangerous-html (plan 8.2, FR-A-042): scope apps/web/src/**/*.{ts,tsx}.
import type { CanaryCase } from '../canary-case.js';

const RULE = 'local/no-dangerous-html';

const INNER_HTML = `
export function show(element: HTMLElement, html: string): void {
  element.innerHTML = html;
}
`;

export const cases = [
  {
    name: 'dangerouslySetInnerHTML in JSX',
    path: 'apps/web/src/__lint_canary__/html-jsx.tsx',
    code: `
export function Rich({ html }: { html: string }) {
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}
`,
    mustReport: [RULE],
  },
  {
    name: 'an innerHTML assignment',
    path: 'apps/web/src/__lint_canary__/html-inner.ts',
    code: INNER_HTML,
    mustReport: [RULE],
  },
  {
    name: 'insertAdjacentHTML',
    path: 'apps/web/src/__lint_canary__/html-adjacent.ts',
    code: `
export function append(element: HTMLElement, html: string): void {
  element.insertAdjacentHTML('beforeend', html);
}
`,
    mustReport: [RULE],
  },
  {
    name: 'document.write',
    path: 'apps/web/src/__lint_canary__/html-write.ts',
    code: `
export function emit(html: string): void {
  document.write(html);
}
`,
    mustReport: [RULE],
  },
  {
    name: 'control: text content and React elements are allowed',
    path: 'apps/web/src/__lint_canary__/html-text.tsx',
    code: `
export function show(element: HTMLElement, text: string): void {
  element.textContent = text;
}
export function Plain({ text }: { text: string }) {
  return <div>{text}</div>;
}
`,
    mustNotReport: [RULE],
  },
  {
    name: 'control: web tests live outside src and may inspect innerHTML',
    path: 'apps/web/test/__lint_canary__/html-inner.test.ts',
    code: INNER_HTML,
    mustNotReport: [RULE],
  },
  {
    name: 'control: the rule is scoped to the web package (shared)',
    path: 'packages/shared/src/__lint_canary__/html-inner.ts',
    code: INNER_HTML,
    mustNotReport: [RULE],
  },
  {
    name: 'control: the rule is scoped to the web package (server)',
    path: 'apps/server/src/__lint_canary__/html-inner.ts',
    code: INNER_HTML,
    mustNotReport: [RULE],
  },
] as const satisfies readonly CanaryCase[];
