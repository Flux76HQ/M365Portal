// local/no-dangerous-html (plan 8.2): the web app never writes HTML into the page. The CSP enforces
// Trusted Types (`require-trusted-types-for 'script'`), and one web module owns the only policy;
// everything else renders React elements or text. This rule refuses the HTML sinks in source.
import type { RuleTester } from 'eslint';
import { describe, expect, it } from 'vitest';
import { createRuleTester, ruleOf, scopeOf, STRICT_ASSERTIONS } from './support.js';

const FILE = 'apps/web/src/components/Html.tsx';
const rule = ruleOf('no-dangerous-html');

function validCase(code: string, name?: string): RuleTester.ValidTestCase {
  return { name: name ?? code, code, filename: FILE };
}

function sink(code: string, name: string, label?: string): RuleTester.InvalidTestCase {
  return {
    name: label ?? code,
    code,
    filename: FILE,
    errors: [{ messageId: 'dangerousHtml', data: { name } }],
  };
}

createRuleTester().run('local/no-dangerous-html', rule, {
  assertionOptions: STRICT_ASSERTIONS,
  valid: [
    validCase('const a = <div>{text}</div>;'),
    validCase('el.textContent = value;'),
    validCase("el.setAttribute('class', 'x');"),
    validCase("const node = document.createElement('div');"),
    validCase("document.title = 'x';"),
    validCase('writer.write(chunk);', 'write on something that is not the document'),
    validCase('stream.write(chunk); response.write(body);'),
    validCase('window.document.title;'),
    validCase('const innerHTMLLength = 1;', 'an identifier that contains the word'),
    validCase('const { children } = props;'),
    validCase("const key = 'innerHTML';", 'the word in a string is not a property access'),
    validCase('obj.myinnerHTML = 1; obj.innerHTMLish = 2;', 'near misses'),
    validCase('// el.innerHTML = html\nconst a = 1;', 'a comment'),
    validCase("const a = <p dangerouslyAnything='x' />;", 'a different attribute'),
    validCase('document.querySelector("p")?.append(node);'),
  ],

  invalid: [
    sink(
      'const a = <div dangerouslySetInnerHTML={{ __html: html }} />;',
      'dangerouslySetInnerHTML',
      'JSX attribute',
    ),
    sink(
      "createElement('div', { dangerouslySetInnerHTML: { __html: html } });",
      'dangerouslySetInnerHTML',
      'props object',
    ),
    sink(
      "const props = { 'dangerouslySetInnerHTML': x };",
      'dangerouslySetInnerHTML',
      'quoted key',
    ),
    sink('el.innerHTML = html;', 'innerHTML', 'assignment'),
    sink('const html = el.innerHTML;', 'innerHTML', 'read'),
    sink('el.outerHTML = html;', 'outerHTML'),
    sink("el.insertAdjacentHTML('beforeend', html);", 'insertAdjacentHTML'),
    sink('document.write(html);', 'document.write'),
    sink('document.writeln(html);', 'document.writeln'),
    sink('window.document.write(html);', 'document.write', 'through window'),
    sink('globalThis.document.write(html);', 'document.write', 'through globalThis'),
    sink("el['innerHTML'] = html;", 'innerHTML', 'computed string key'),
    sink('el[`innerHTML`] = html;', 'innerHTML', 'computed template key'),
    sink('el?.innerHTML;', 'innerHTML', 'optional chain'),
    sink('const { innerHTML } = el;', 'innerHTML', 'destructuring'),
    sink('Object.assign(el, { innerHTML: html });', 'innerHTML', 'object literal key'),
    sink("document['write'](html);", 'document.write', 'computed method name'),
    {
      name: 'every sink is reported',
      code: 'a.innerHTML = x;\nb.outerHTML = y;',
      filename: FILE,
      errors: [
        { messageId: 'dangerousHtml', data: { name: 'innerHTML' }, line: 1 },
        { messageId: 'dangerousHtml', data: { name: 'outerHTML' }, line: 2 },
      ],
    },
  ],
});

describe('local/no-dangerous-html: scope', () => {
  it('applies to the whole web source', () => {
    const scope = scopeOf('no-dangerous-html');

    expect(scope.files).toEqual(['apps/web/src/**/*.{ts,tsx}']);
    expect(scope.ignores).toEqual([]);
  });
});
