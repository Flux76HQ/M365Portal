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
    validCase('const d = other; d.write(chunk);', 'a const that is not the document'),
    validCase('const d = document; d.title = "x";', 'a document alias that is not written to'),
    validCase('iframe.src = url; iframe.name = "x";', 'other attributes of an iframe'),
    validCase('el[name] = value;', 'a dynamic key cannot be seen'),
    validCase('const k = props.key; el[k] = value;', 'a const that holds a value from elsewhere'),
    validCase("el['inner' + suffix] = value;", 'a concatenation with something unknown'),
    validCase('const a = <iframe src={url} title={t("frame")} />;', 'an iframe with a src'),
    validCase('const created = createContextualFragments(1);', 'a near miss'),
    validCase('const s = setHTMLUnsafeValue + 1;', 'a name that contains a sink as a prefix'),
    validCase("el.setAttribute('class', 'x'); el.setAttribute(name, value);", 'other attributes'),
    validCase('const w = other; w.document.write(chunk);', 'an alias of something else'),
    validCase('const { write } = stream;', 'write taken off a stream'),
    validCase('const html = document.open;', 'open without a call'),
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
    // The sinks that came with newer browsers, and the disguises of the old ones (G0 defect D12).
    sink('el.setHTMLUnsafe(html);', 'setHTMLUnsafe'),
    sink('shadow?.setHTMLUnsafe(html);', 'setHTMLUnsafe', 'optional call'),
    sink('const doc = Document.parseHTMLUnsafe(html);', 'parseHTMLUnsafe'),
    sink('const fragment = range.createContextualFragment(html);', 'createContextualFragment'),
    sink('iframe.srcdoc = html;', 'srcdoc'),
    sink('Object.assign(iframe, { srcdoc: html });', 'srcdoc', 'object literal key'),
    sink('const a = <iframe srcDoc={html} />;', 'srcDoc', 'React attribute'),
    sink('const a = <iframe srcdoc="<p>x</p>" />;', 'srcdoc', 'lower-case attribute'),
    sink('const d = document; d.write(html);', 'document.write', 'a const alias of document'),
    sink(
      'const d = window.document; d.writeln(html);',
      'document.writeln',
      'alias of window.document',
    ),
    sink(
      'const w = document; const d = w; d.write(html);',
      'document.write',
      'an alias of an alias',
    ),
    sink("el['inner' + 'HTML'] = html;", 'innerHTML', 'a key built from two literals'),
    sink('el[`inner${"HTML"}`] = html;', 'innerHTML', 'a key built in a template'),
    sink("const key = 'outerHTML'; el[key] = html;", 'outerHTML', 'a key held in a const'),
    sink(
      "const a = 'insertAdjacent'; el[a + 'HTML']('beforeend', html);",
      'insertAdjacentHTML',
      'a const and a literal',
    ),
    sink("el.setAttribute('srcdoc', html);", 'srcdoc', 'srcdoc through setAttribute'),
    sink("el.setAttribute('srcDoc', html);", 'srcdoc', 'srcDoc through setAttribute'),
    sink("el.setAttributeNS(null, 'srcdoc', html);", 'srcdoc', 'srcdoc through setAttributeNS'),
    sink('const w = window; w.document.write(html);', 'document.write', 'the document of an alias'),
    sink(
      'const w = globalThis.window; w.document.writeln(html);',
      'document.writeln',
      'globalThis.window',
    ),
    sink(
      'const { write } = document; write(html);',
      'document.write',
      'write taken off the document',
    ),
    sink('document.open().write(html);', 'document.write', 'the document returned by open()'),
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
  it('applies to every kind of script in the sources and the static files of the web package', () => {
    const scope = scopeOf('no-dangerous-html');

    expect(scope.files).toEqual(['apps/web/{src,public}/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}']);
    expect(scope.ignores).toEqual([]);
  });
});
