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
  // G0 defects D12 and D15: the other HTML sinks, and where the rule looks.
  {
    name: 'setHTMLUnsafe and createContextualFragment',
    path: 'apps/web/src/__lint_canary__/html-unsafe.ts',
    code: `
export function show(element: HTMLElement, html: string, range: Range): void {
  (element as unknown as { setHTMLUnsafe(value: string): void }).setHTMLUnsafe(html);
  range.createContextualFragment(html);
}
`,
    mustReport: [RULE],
  },
  {
    name: 'an iframe srcdoc assignment',
    path: 'apps/web/src/__lint_canary__/html-srcdoc.ts',
    code: `
export function frame(element: HTMLIFrameElement, html: string): void {
  element.srcdoc = html;
}
`,
    mustReport: [RULE],
  },
  {
    name: 'document.write through a constant that holds the document',
    path: 'apps/web/src/__lint_canary__/html-alias.ts',
    code: `
export function emit(html: string): void {
  const d = document;
  d.write(html);
}
`,
    mustReport: [RULE],
  },
  {
    name: 'a source folder that shares the name of build output is linted (coverage)',
    path: 'apps/web/src/features/coverage/html-inner.ts',
    code: INNER_HTML,
    mustReport: [RULE],
  },
  {
    name: 'plain JavaScript (.js, .mjs) is linted',
    path: 'apps/web/src/__lint_canary__/html-inner.mjs',
    code: `
export function show(element, html) {
  element.innerHTML = html;
}
`,
    mustReport: [RULE],
  },
] as const satisfies readonly CanaryCase[];
